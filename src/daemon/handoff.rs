//! Handoff documents: compacting a session's transcript so a fresh agent can
//! pick the work up.
//!
//! Two paths produce one of these. The *warm* path asks the session that did
//! the work — it still holds tool results, file contents and reasoning that
//! never reached the transcript, so it writes the better document for almost no
//! marginal cost. The *cold* path is for when that session cannot answer: its
//! native history was deleted, or its account hit a usage limit. Then the only
//! record left is what the daemon persisted, and some model has to read it.
//!
//! [`HANDOFF_INSTRUCTION`] serves both, so the two paths cannot drift: the warm
//! path sends it as a message, the cold path prepends it to a transcript.
//!
//! The transcript itself arrives from the client. It is the client that knows
//! where the conversation should be cut — a fork continues from one specific
//! message, not from the end — and its view is already folded, while the store
//! holds every raw lifecycle frame. The daemon still owns the size bound, so
//! one limit governs no matter who assembles the text.

/// Upper bound on the transcript handed to a cold compaction. Past this the
/// oldest material is dropped: the tail is what the next session continues
/// from, so it is the part worth keeping when something must go.
const TRANSCRIPT_LIMIT: usize = 96 * 1024;

/// What both handoff paths ask for.
///
/// Deliberately harness-neutral: it is sent to whichever agent is available,
/// which may not be the one that did the work and may not share its vocabulary.
/// Nothing here names a tool, a slash command or a file layout.
pub const HANDOFF_INSTRUCTION: &str = "\
Write a handoff document so a fresh agent session can continue this work.

Cover, using only what the conversation supports:

1. Goal — what the work is trying to achieve, and why.
2. State — what is finished, what is half-done, and exactly where work stopped. \
Be concrete: the file left mid-edit, the command that failed, the assumption \
still unverified. This is the most valuable section; a new session cannot \
recover it any other way.
3. Decisions — choices already made and the reasoning behind them, so they are \
not silently reopened. Include approaches that were tried and rejected.
4. Files and artifacts — reference specs, plans, records, issues, commits and \
diffs by path or URL. Do not restate their contents; the next agent can open them.
5. Next steps — the immediate ones, in order.
6. Open questions — anything that needs a decision from the developer.
7. Useful capabilities — if particular skills, tools or references helped, name \
them. The next session may have a different set available, so write these as \
hints rather than instructions.

Rules:

- Write for an agent with no memory of this conversation and no access to it.
- Prefer specifics over summary. \"Refactored the parser\" is useless; \
\"split `parse_header` out of `parse`, callers in `reader.rs` not yet updated\" is not.
- Omit a section that has nothing real in it rather than padding it.
- Redact secrets: API keys, tokens, passwords, personal data.
- Reply with ONLY the document — no preamble, no closing remarks.";

/// Preamble for the cold path, warning the compacting model that it is reading
/// a lossy record rather than sitting on the original context.
const COLD_TRANSCRIPT_NOTE: &str = "\
The transcript below is a stored record of the session, not its live context. \
Tool output is abbreviated and file contents are absent, so treat it as \
evidence of what happened rather than a complete account. Where it is thin, say \
so in the document instead of guessing.";

/// The full cold-path prompt: instruction, warning, transcript.
pub fn cold_prompt(transcript: &str) -> Result<String, String> {
    if transcript.trim().is_empty() {
        return Err("no conversation to summarize".to_string());
    }
    let transcript = keep_tail(transcript.to_string(), TRANSCRIPT_LIMIT);
    Ok(format!(
        "{HANDOFF_INSTRUCTION}\n\n{COLD_TRANSCRIPT_NOTE}\n\n----- transcript -----\n{transcript}"
    ))
}

/// Keep the last `limit` bytes, dropping whole leading entries.
fn keep_tail(text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    // Land on a character boundary before slicing: a cut inside a multi-byte
    // character panics, and non-ASCII transcripts are the common case.
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    // Resume at an entry boundary so the tail never opens mid-sentence.
    if let Some(offset) = text[start..].find("\n\n") {
        start += offset + 2;
    }
    format!("… earlier conversation omitted …\n\n{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_transcript(entry: impl Fn(usize) -> String) -> String {
        (0..4000).map(entry).collect::<Vec<_>>().join("\n\n")
    }

    #[test]
    fn keeps_the_instruction_and_the_transcript_together() {
        let prompt = cold_prompt("## Developer\nadd a parser").unwrap();

        assert!(prompt.starts_with("Write a handoff document"));
        assert!(prompt.contains("----- transcript -----"));
        assert!(prompt.ends_with("## Developer\nadd a parser"));
    }

    #[test]
    fn drops_the_oldest_material_when_over_the_limit() {
        let transcript = long_transcript(|index| format!("message {index} {}", "x".repeat(64)));
        let prompt = cold_prompt(&transcript).unwrap();

        assert!(prompt.contains("… earlier conversation omitted …"));
        assert!(!prompt.contains("message 0 "));
        assert!(prompt.contains("message 3999 "));
    }

    #[test]
    fn trims_a_non_ascii_transcript_without_splitting_a_character() {
        let transcript =
            long_transcript(|index| format!("повідомлення {index} {}", "я".repeat(48)));
        let prompt = cold_prompt(&transcript).unwrap();

        assert!(prompt.contains("… earlier conversation omitted …"));
        assert!(prompt.contains("повідомлення 3999 "));
    }

    #[test]
    fn cold_prompt_refuses_an_empty_transcript() {
        assert!(cold_prompt("").is_err());
        assert!(cold_prompt("   \n\n  ").is_err());
    }
}
