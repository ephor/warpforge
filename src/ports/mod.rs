use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};

mod resolve;

pub use resolve::{resolve_ranges, ProjectPortInput, RangeSource, ResolvedRange};

/// How a service reacts when its desired port is not free.
///
/// `Strict` is a hard pin: the exact port, or the service fails loudly — no
/// fallback (ADR 0006 invariant 4). `Auto` keeps the first-free-in-range
/// behaviour for unpinned services and for services that opted back in via
/// `portFallback: auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortPin {
    Auto,
    Strict,
}

fn alloc_map() -> &'static Mutex<HashMap<u16, String>> {
    static ALLOCATED: OnceLock<Mutex<HashMap<u16, String>>> = OnceLock::new();
    ALLOCATED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Check if a TCP port is available by trying to bind to it.
fn is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Allocate a port for a service inside the project's resolved range.
///
/// `Strict` binds exactly `desired_port`: it must sit inside `range` and be
/// free, otherwise the call fails with a message naming the service and the
/// port — a pinned port is a hard constraint, never silently shifted. `Auto`
/// hands out the first free port in the range and ignores `desired_port`.
pub fn allocate(
    range: (u16, u16),
    project_name: &str,
    service_name: &str,
    desired_port: u16,
    pin: PortPin,
) -> Result<u16, String> {
    let (start, end) = range;
    let key = format!("{project_name}/{service_name}");
    let mut map = alloc_map().lock().unwrap();

    match pin {
        PortPin::Strict => {
            if desired_port < start || desired_port > end {
                return Err(format!(
                    "Port {desired_port} for {key} is outside the declared range {start}-{end}; move the port inside the range, or set portFallback: auto for this service to shift it"
                ));
            }
            if map.contains_key(&desired_port) || !is_available(desired_port) {
                return Err(format!(
                    "Port {desired_port} requested by {key} is already in use"
                ));
            }
            map.insert(desired_port, key);
            Ok(desired_port)
        }
        PortPin::Auto => {
            for port in start..=end {
                if map.contains_key(&port) {
                    continue;
                }
                if is_available(port) {
                    map.insert(port, key);
                    return Ok(port);
                }
            }
            Err(format!(
                "No available ports in range {start}-{end} for {project_name}/{service_name}"
            ))
        }
    }
}

/// Ports this process handed out that fall inside `ranges`.
///
/// Teardown sweeps use this instead of the whole range: a range holds whatever
/// happens to be listening, including a developer's unrelated server, and
/// warpforge has no business killing a process it did not start.
pub fn allocated_in_ranges(ranges: &[(u16, u16)]) -> Vec<u16> {
    let map = alloc_map().lock().unwrap();
    let mut ports: Vec<u16> = map
        .keys()
        .copied()
        .filter(|port| {
            ranges
                .iter()
                .any(|&(start, end)| *port >= start && *port <= end)
        })
        .collect();
    ports.sort_unstable();
    ports
}

/// Release the port allocated for a service.
pub fn release(project_name: &str, service_name: &str) {
    let key = format!("{project_name}/{service_name}");
    alloc_map().lock().unwrap().retain(|_, v| v != &key);
}

/// Release all ports for a project.
pub fn release_project(project_name: &str) {
    let prefix = format!("{project_name}/");
    alloc_map()
        .lock()
        .unwrap()
        .retain(|_, v| !v.starts_with(&prefix));
}

/// Replace `${service.port}` placeholders in env values.
/// `port_map` maps service_name → allocated_port.
pub fn interpolate_env(
    env: &HashMap<String, String>,
    port_map: &HashMap<String, u16>,
) -> HashMap<String, String> {
    env.iter()
        .map(|(k, v)| {
            let replaced = regex_replace(v, port_map);
            (k.clone(), replaced)
        })
        .collect()
}

fn regex_replace(s: &str, port_map: &HashMap<String, u16>) -> String {
    let mut result = String::with_capacity(s.len());
    // Replace ${svcName.port} with the allocated port number. Simple manual
    // scan — avoids pulling in the regex crate. An unresolvable placeholder is
    // left literal and the scan continues, so later resolvable placeholders
    // still get their value.
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        result.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('}') else {
            result.push_str(tail);
            return result;
        };
        let placeholder = &tail[2..end];
        let resolved = placeholder
            .strip_suffix(".port")
            .and_then(|svc| port_map.get(svc));
        match resolved {
            Some(port) => result.push_str(&port.to_string()),
            None => result.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allocation map is a process-global; drop our entries between tests
    /// so they stay independent of execution order.
    fn release_all(names: &[&str]) {
        alloc_map()
            .lock()
            .unwrap()
            .retain(|_, v| !names.contains(&v.as_str()));
    }

    #[test]
    fn strict_binds_the_exact_port() {
        release_all(&["p/web"]);
        let port = allocate((4200, 4299), "p", "web", 4242, PortPin::Strict).unwrap();
        assert_eq!(port, 4242);
        release_all(&["p/web"]);
    }

    #[test]
    fn strict_on_a_taken_port_fails_instead_of_falling_back() {
        release_all(&["p/web", "p/other"]);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        // Put the listener inside a range-shaped hole so `is_available` fails.
        let start = port.saturating_sub(50).max(1024);
        let err = allocate((start, port), "p", "web", port, PortPin::Strict).unwrap_err();
        assert!(
            err.contains(&port.to_string()),
            "error names the port: {err}"
        );
        assert!(err.contains("p/web"), "error names the service: {err}");
        release_all(&["p/other"]);
    }

    #[test]
    fn strict_outside_the_range_fails_with_an_out_of_range_message() {
        release_all(&["p/web"]);
        let err = allocate((4200, 4299), "p", "web", 5000, PortPin::Strict).unwrap_err();
        assert!(err.contains("outside the declared range"), "{err}");
        release_all(&["p/web"]);
    }

    #[test]
    fn auto_returns_the_first_free_port_in_the_range() {
        release_all(&["p/web"]);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = listener.local_addr().unwrap().port();
        let start = taken;
        let port = allocate((start, taken + 9), "p", "web", 0, PortPin::Auto).unwrap();
        assert_ne!(port, taken, "the occupied port must be skipped");
        release_all(&["p/web"]);
    }

    fn env_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn interpolation_resolves_port_placeholders() {
        let mut map = HashMap::new();
        map.insert("db".to_string(), 5432u16);
        let out = interpolate_env(
            &env_map(&[("URL", "postgres://localhost:${db.port}/app")]),
            &map,
        );
        assert_eq!(out["URL"], "postgres://localhost:5432/app");
    }

    /// One unresolvable placeholder must not blind the scan: placeholders
    /// after it still resolve.
    #[test]
    fn interpolation_continues_past_an_unresolvable_placeholder() {
        let mut map = HashMap::new();
        map.insert("db".to_string(), 5432u16);
        let out = interpolate_env(&env_map(&[("URL", "${missing.port}://${db.port}")]), &map);
        assert_eq!(out["URL"], "${missing.port}://5432");
    }
}
