//! Daemon runtime: the concurrency machinery the actor delegates to.
//!
//! `actor.rs` owns state and decides; everything here owns work that must not
//! run on the actor's thread. Pieces land one at a time and take ownership when
//! they do — see `docs/adr/0002` for the target shape and the invariants that
//! keep blocking work from creeping back in.

pub mod persist;

pub use persist::{read as store_read, Ask, Persist, Write};
