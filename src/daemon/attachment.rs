//! Fetching images embedded in tracker issue bodies.
//!
//! A GitHub attachment (`github.com/user-attachments/assets/…`) is only
//! readable by someone signed in to GitHub. The desktop's WebView carries no
//! GitHub session, so it renders those as broken — even though the person
//! looking at the issue plainly has access, since the issue itself was
//! imported with their credentials. The daemon does hold the credentials, so
//! it fetches the bytes and hands them back for the WebView to show inline.
//! Nothing about the user's tokens reaches the renderer.
//!
//! This takes a URL that arrived over the network (an issue body is written by
//! whoever opened the issue), and turns it into an outbound request from the
//! daemon — a server-side request forgery primitive if left open. Hence:
//!
//! * the first hop must be a known tracker host, `https` only;
//! * redirects are followed by hand, one allowlisted host at a time, so a
//!   tracker's open redirect cannot be pointed at localhost or a cloud
//!   metadata endpoint;
//! * credentials go to the tracker and are dropped before the redirect, so the
//!   signed asset host never sees a token;
//! * the response must be an image, and a bounded number of bytes of one.

use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use tokio::process::Command;
use warpforge_protocol as wire;

use super::tracker;

const NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Screenshots are the case this exists for; anything this big is not one, and
/// the bytes travel over the same websocket the UI uses.
const MAX_BYTES: usize = 10 * 1024 * 1024;

/// A tracker redirects an attachment to signed storage, which redirects again.
const MAX_REDIRECTS: usize = 4;

/// Hosts an attachment URL may name. The first hop must be one of these, which
/// is what makes the request the user's tracker rather than an arbitrary
/// address chosen by whoever wrote the issue.
const TRACKER_HOSTS: &[&str] = &[
    "github.com",
    "www.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "user-images.githubusercontent.com",
    "private-user-images.githubusercontent.com",
    "avatars.githubusercontent.com",
    "uploads.linear.app",
];

/// Additional hosts a redirect may land on: the storage the trackers sign
/// their assets into. Object storage is not a route into a private network,
/// which is the property that makes widening to these safe.
const STORAGE_HOST_SUFFIXES: &[&str] =
    &[".githubusercontent.com", ".s3.amazonaws.com", ".linear.app"];

fn host_of(url: &reqwest::Url) -> Result<String> {
    url.host_str()
        .map(|host| host.to_ascii_lowercase())
        .ok_or_else(|| anyhow!("attachment URL has no host"))
}

fn is_tracker_host(host: &str) -> bool {
    TRACKER_HOSTS.contains(&host)
}

fn is_storage_host(host: &str) -> bool {
    STORAGE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host.ends_with(suffix))
}

/// The entry point's own check: https, and a host we know serves attachments.
fn check_first_hop(url: &reqwest::Url) -> Result<()> {
    if url.scheme() != "https" {
        bail!("attachment URL must be https");
    }
    let host = host_of(url)?;
    if !is_tracker_host(&host) {
        bail!("{host} is not a tracker attachment host");
    }
    Ok(())
}

/// Where a redirect is allowed to go: still https, and either a tracker host
/// or the signed storage one of them redirects to.
fn check_redirect(url: &reqwest::Url) -> Result<()> {
    if url.scheme() != "https" {
        bail!("attachment redirect must stay on https");
    }
    let host = host_of(url)?;
    if !is_tracker_host(&host) && !is_storage_host(&host) {
        bail!("attachment redirect to {host} is not allowed");
    }
    Ok(())
}

/// `gh`'s token for api.github.com. Absent when `gh` is missing or logged out,
/// in which case a public attachment still works and a private one does not.
async fn github_token() -> Option<String> {
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token"]);
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(NETWORK_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// The credential for the host being asked, if warpforge holds one.
async fn authorization_for(host: &str) -> Option<String> {
    if host.ends_with("linear.app") {
        return tracker::keychain_read();
    }
    if host == "github.com" || host == "www.github.com" || host.ends_with(".githubusercontent.com")
    {
        return github_token().await.map(|token| format!("Bearer {token}"));
    }
    None
}

/// Read at most `MAX_BYTES`, streaming, so a huge or endless body cannot be
/// used to exhaust memory. `Content-Length` is a hint, not a promise.
async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>> {
    if let Some(len) = response.content_length() {
        if len as usize > MAX_BYTES {
            bail!("attachment is larger than {MAX_BYTES} bytes");
        }
    }
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            bail!("attachment is larger than {MAX_BYTES} bytes");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Fetch one image embedded in an issue body.
///
/// Runs on the request task, never inside the actor (ADR-0002 invariant 1):
/// this is a network call, and the actor awaits its handlers inline.
pub async fn fetch(url: &str) -> Result<wire::TrackerAttachment> {
    let mut target: reqwest::Url = url.parse().map_err(|_| anyhow!("invalid attachment URL"))?;
    check_first_hop(&target)?;

    // Redirects are followed here rather than by reqwest so that every hop is
    // checked and the tracker credential is dropped after the first one.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(NETWORK_TIMEOUT)
        .build()?;
    let mut authorization = authorization_for(&host_of(&target)?).await;

    for _ in 0..=MAX_REDIRECTS {
        let mut request = client.get(target.clone());
        if let Some(value) = &authorization {
            request = request.header(reqwest::header::AUTHORIZATION, value);
        }
        let response = request
            .send()
            .await
            .map_err(|e| anyhow!("fetching the attachment failed: {e}"))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| anyhow!("attachment redirect had no location"))?;
            let next = target
                .join(location)
                .map_err(|_| anyhow!("attachment redirect location is not a URL"))?;
            check_redirect(&next)?;
            // Signed storage does not need the token, and must not be told it.
            authorization = None;
            target = next;
            continue;
        }
        if !status.is_success() {
            bail!("the tracker returned {status} for this attachment");
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        // The renderer puts this in an <img>; anything else is not ours to
        // hand it, and an HTML error page is the common wrong answer here.
        if !content_type.starts_with("image/") {
            bail!("attachment is {content_type}, not an image");
        }

        let bytes = read_bounded(response).await?;
        return Ok(wire::TrackerAttachment {
            content_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    bail!("attachment redirected more than {MAX_REDIRECTS} times")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> reqwest::Url {
        raw.parse().expect("test URL parses")
    }

    #[test]
    fn accepts_the_hosts_trackers_serve_attachments_from() {
        for raw in [
            "https://github.com/user-attachments/assets/abc",
            "https://private-user-images.githubusercontent.com/1/2.png",
            "https://uploads.linear.app/a/b.png",
        ] {
            check_first_hop(&url(raw)).unwrap_or_else(|e| panic!("{raw} rejected: {e}"));
        }
    }

    // The URL comes out of an issue body, which anyone who can open an issue
    // can write. Left unchecked it aims the daemon wherever they like.
    #[test]
    fn rejects_a_first_hop_that_is_not_a_tracker() {
        for raw in [
            "https://example.com/a.png",
            "https://127.0.0.1/a.png",
            "https://169.254.169.254/latest/meta-data/",
            "https://github.com.attacker.test/a.png",
        ] {
            assert!(
                check_first_hop(&url(raw)).is_err(),
                "{raw} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_plaintext_and_non_http_schemes() {
        assert!(check_first_hop(&url("http://github.com/a.png")).is_err());
        assert!(check_first_hop(&url("file:///etc/passwd")).is_err());
    }

    #[test]
    fn allows_a_redirect_into_signed_storage_only() {
        check_redirect(&url(
            "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?X-Amz-Signature=x",
        ))
        .expect("github's signed asset storage is where attachments live");
        assert!(check_redirect(&url("https://attacker.test/a.png")).is_err());
        assert!(check_redirect(&url("https://169.254.169.254/latest/meta-data/")).is_err());
    }

    #[test]
    fn a_redirect_may_not_leave_https() {
        assert!(check_redirect(&url("http://objects.githubusercontent.com/a")).is_err());
    }
}
