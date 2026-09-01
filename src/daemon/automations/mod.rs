//! Scheduled automations: cron maths, precheck execution, and the wire RPCs
//! that create, edit and fire them. The lifecycle itself (scheduler tick, run
//! dispatch) lives on the actor in `actor/commands/automation.rs`.

pub mod rpc;
pub mod schedule;

pub use rpc::dispatch;
pub use schedule::{host_timezone, next_occurrence, preset_cron, run_precheck, validate_trigger};
