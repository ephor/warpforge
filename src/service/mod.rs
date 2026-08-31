use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

mod query;
mod spawn;
mod stop;

#[cfg(test)]
mod tests;

pub use stop::kill_listeners_on_ports;

/// A single retained log line with a monotonic per-service sequence number and
/// the wall-clock time (epoch millis) it was captured. Sequence numbers let
/// clients read "everything after cursor X" cheaply and never lose/gain lines
/// as the ring buffer drops old entries; timestamps let tooling show age.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub seq: u64,
    pub at_ms: u64,
    pub line: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum ServiceStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

impl std::fmt::Display for ServiceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceStatus::Starting => write!(f, "starting"),
            ServiceStatus::Running => write!(f, "running"),
            ServiceStatus::Stopped => write!(f, "stopped"),
            ServiceStatus::Failed => write!(f, "failed"),
        }
    }
}

#[allow(dead_code)]
pub struct ManagedService {
    pub name: String,
    pub project_name: String,
    pub command: String,
    pub status: ServiceStatus,
    pub logs: Vec<LogLine>,
    /// Sequence number for the next appended log line (monotonic, never reused,
    /// even across restarts). Log `seq` values are assigned from this.
    pub next_seq: u64,
    /// Port declared in .warpforge.yaml (0 = none)
    pub original_port: u16,
    /// Actual port the process is listening on (allocated from range)
    pub allocated_port: u16,
    /// True when the declared port was pinned strictly (no fallback).
    pub port_pinned: bool,
    /// Process-group ID — used to kill the entire tree (sh → npm → node)
    pgid: Option<u32>,
    /// Monotonic run identifier. Async log/status tasks include this so late
    /// events from an older process cannot overwrite a newer restart.
    run_id: u64,
    /// Set true when we're deliberately stopping, so the exit waiter can tell
    /// an intentional stop from a crash and report the right status.
    stopping: Arc<AtomicBool>,
}

pub enum ServiceEvent {
    Log {
        key: String,
        run_id: u64,
        line: String,
    },
    StatusChange {
        key: String,
        run_id: u64,
        status: ServiceStatus,
        /// Exit code from a stopped/crashed process, when known (None for a
        /// signal kill). Drives the `[service failed: exit code=N]` marker.
        exit_code: Option<i32>,
    },
}

pub struct ServiceManager {
    services: HashMap<String, ManagedService>,
    pub event_tx: mpsc::UnboundedSender<ServiceEvent>,
    next_run_id: u64,
}

impl ManagedService {
    /// Append a retained line (assigning its seq + timestamp) and trim the ring.
    pub fn push_log(&mut self, line: String) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        self.logs.push(LogLine {
            seq,
            at_ms: now_ms(),
            line,
        });
        if self.logs.len() > 2000 {
            self.logs.drain(..self.logs.len() - 2000);
        }
    }

    /// Slice the ring by seq cursor and cap to `limit`; returns raw lines, their
    /// timestamps (millis, index-aligned), and the cursor to pass back as `after`.
    /// `after` is inclusive ("start from this seq"), so `0` returns the oldest
    /// retained line and polling with the returned cursor returns only newer ones.
    pub fn window(&self, after: u64, limit: Option<u32>) -> (Vec<String>, Vec<u64>, u64) {
        let mut lines: Vec<&LogLine> = self.logs.iter().filter(|l| l.seq >= after).collect();
        if let Some(n) = limit {
            let n = n as usize;
            if lines.len() > n {
                lines = lines.split_off(lines.len() - n);
            }
        }
        let (text, at): (Vec<String>, Vec<u64>) =
            lines.iter().map(|l| (l.line.clone(), l.at_ms)).unzip();
        (text, at, self.next_seq)
    }
}

#[allow(dead_code)]
impl ServiceManager {
    pub fn new(event_tx: mpsc::UnboundedSender<ServiceEvent>) -> Self {
        Self {
            services: HashMap::new(),
            event_tx,
            next_run_id: 1,
        }
    }
}
