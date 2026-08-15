//! Write-behind persistence for the daemon actor.
//!
//! Every state change used to write to SQLite from inside the actor loop —
//! including one INSERT per streamed chunk of agent output. Those are blocking
//! disk writes on a tokio worker, so while an agent streamed, the actor could
//! not accept a tool approval queued behind it. See `docs/adr/0002`.
//!
//! Writes are queued here and applied by a dedicated OS thread that drains
//! whatever is pending into a single transaction.
//!
//! **Batching, never coalescing.** Rows keep their exact identity and order.
//! `actor.rs`'s resume replay guard compares persisted history against the
//! agent's replay chunk for chunk, so merging two `AgentText` rows into one
//! would silently break de-duplication and double the output on resume.

use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot};
use warpforge_protocol as wire;

use crate::daemon::store::{Store, StoredAccount};
use crate::daemon::task::Task;

/// Upper bound on writes folded into one transaction. Large enough that a
/// stream burst commits once, small enough that a reader waiting on the store
/// mutex is never held off for long.
const MAX_BATCH: usize = 512;

/// A queued write. Fire-and-forget: the actor does not learn whether it landed.
pub enum Write {
    Task(Box<Task>),
    DeleteTask(String),
    SessionUpdate {
        task_id: String,
        update: Box<wire::SessionUpdate>,
    },
    Agents(Vec<wire::AgentConfig>),
    AgentModels {
        id: String,
        models: Vec<wire::ConfigOption>,
        last_model: Option<String>,
    },
    Account(Box<StoredAccount>),
    OrchestratorConfig(Box<crate::orchestration::config::OrchestratorConfig>),
    WorkflowRun {
        task_id: String,
        json: String,
    },
    DeleteWorkflowRun(String),
}

impl Write {
    fn apply(self, store: &Store) -> anyhow::Result<()> {
        match self {
            Write::Task(task) => store.upsert_task(&task),
            Write::DeleteTask(id) => store.delete_task(&id),
            Write::SessionUpdate { task_id, update } => {
                store.save_session_update(&task_id, &update)
            }
            Write::Agents(agents) => store.save_agents(&agents),
            Write::AgentModels {
                id,
                models,
                last_model,
            } => store.update_agent_models(&id, &models, last_model.as_deref()),
            Write::Account(account) => store.upsert_account(&account),
            Write::OrchestratorConfig(config) => store.save_orchestrator_config(&config),
            Write::WorkflowRun { task_id, json } => store.save_workflow_run(&task_id, &json),
            Write::DeleteWorkflowRun(task_id) => store.delete_workflow_run(&task_id),
        }
    }
}

/// A write whose outcome the caller needs, because it already reports failure
/// through the UI and dropping the error would change what the user sees.
///
/// Every variant is user-initiated and rare — an account edit, a task deletion.
/// Nothing on the streaming path belongs here: awaiting a write from the actor
/// stalls the mailbox, which is the whole problem ADR 0002 exists to fix.
pub enum Ask {
    Account(Box<StoredAccount>),
    DeleteAccount(String),
    SetActiveAccount {
        agent_id: String,
        account_id: String,
    },
    DeleteTask(String),
}

impl Ask {
    fn apply(self, store: &Store) -> anyhow::Result<()> {
        match self {
            Ask::Account(account) => store.upsert_account(&account),
            Ask::DeleteAccount(id) => store.delete_account(&id),
            Ask::SetActiveAccount {
                agent_id,
                account_id,
            } => store.set_active_account(&agent_id, &account_id),
            Ask::DeleteTask(id) => store.delete_task(&id),
        }
    }
}

/// Reply channel for a write whose outcome the caller waits on.
type AskReply = oneshot::Sender<Result<(), String>>;

enum Msg {
    Write(Write),
    Ask(Ask, AskReply),
    /// Applied after everything queued ahead of it. Used by shutdown and by
    /// tests that read the database back.
    Flush(oneshot::Sender<()>),
}

/// Handle to the persistence thread. Cloneable and cheap.
#[derive(Clone)]
pub struct Persist {
    tx: Option<mpsc::UnboundedSender<Msg>>,
}

impl Persist {
    /// Start the persistence thread over `store`, returning the handle and the
    /// shared store for the reads that still run on the actor (ADR 0002 moves
    /// those to an in-memory projection next).
    ///
    /// Without a store — the database failed to open — every write is dropped
    /// and the daemon runs in memory, which is what it did before.
    pub fn spawn(store: Option<Store>) -> (Self, Option<Arc<Mutex<Store>>>) {
        let Some(store) = store else {
            return (Self { tx: None }, None);
        };
        let store = Arc::new(Mutex::new(store));
        let (tx, rx) = mpsc::unbounded_channel();
        let worker_store = Arc::clone(&store);
        // A dedicated OS thread, not spawn_blocking: this runs for the life of
        // the daemon and must never occupy a pooled blocking slot.
        std::thread::Builder::new()
            .name("warpforge-persist".into())
            .spawn(move || run(rx, &worker_store))
            .expect("spawning the persistence thread");
        (Self { tx: Some(tx) }, Some(store))
    }

    /// Queue a write. Dropped silently when there is no database, matching the
    /// previous `if let Some(store)` behaviour at every call site.
    pub fn write(&self, write: Write) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Write(write));
        }
    }

    pub fn task(&self, task: &Task) {
        self.write(Write::Task(Box::new(task.clone())));
    }

    pub fn session_update(&self, task_id: &str, update: &wire::SessionUpdate) {
        self.write(Write::SessionUpdate {
            task_id: task_id.to_string(),
            update: Box::new(update.clone()),
        });
    }

    pub fn workflow_run(&self, task_id: &str, json: String) {
        self.write(Write::WorkflowRun {
            task_id: task_id.to_string(),
            json,
        });
    }

    /// Apply a write and wait for its outcome. Waits behind whatever is already
    /// queued, which is bounded by the drain loop below.
    pub async fn ask(&self, ask: Ask) -> Result<(), String> {
        let Some(tx) = &self.tx else {
            return Ok(());
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        if tx.send(Msg::Ask(ask, reply_tx)).is_err() {
            return Err("persistence thread is gone".into());
        }
        reply_rx
            .await
            .unwrap_or_else(|_| Err("persistence thread dropped the reply".into()))
    }

    /// Wait until everything queued so far has been committed.
    ///
    /// Shutdown must await this: with writes in flight on another thread, a
    /// daemon that exits without flushing loses the tail of every transcript.
    pub async fn flush(&self) {
        let Some(tx) = &self.tx else {
            return;
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        if tx.send(Msg::Flush(reply_tx)).is_ok() {
            let _ = reply_rx.await;
        }
    }
}

/// Run a read against the store on the blocking pool.
///
/// SQLite is blocking and the store is behind a plain mutex, so doing this
/// inline in a spawned task occupies a runtime worker for the length of the
/// query — and blocks outright whenever the persistence thread happens to hold
/// the lock for a batch commit. `None` when there is no database.
pub async fn read<T: Send + 'static>(
    store: Option<Arc<Mutex<Store>>>,
    read: impl FnOnce(&Store) -> T + Send + 'static,
) -> Option<T> {
    let store = store?;
    tokio::task::spawn_blocking(move || {
        // Recover a poisoned lock rather than cascade the panic, as the
        // persistence thread does.
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        read(&guard)
    })
    .await
    .ok()
}

/// Drain the queue into transactions until every sender is gone.
fn run(mut rx: mpsc::UnboundedReceiver<Msg>, store: &Arc<Mutex<Store>>) {
    // Replies are sent after the batch commits, never inside it, so a caller
    // that hears "ok" knows the row is durable.
    let mut replies: Vec<oneshot::Sender<()>> = Vec::new();
    let mut asked: Vec<(AskReply, Result<(), String>)> = Vec::new();

    while let Some(first) = rx.blocking_recv() {
        let mut batch = vec![first];
        while batch.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(msg) => batch.push(msg),
                Err(_) => break,
            }
        }

        {
            // Recover a poisoned mutex rather than cascade the panic: losing
            // persistence is bad, taking the daemon down with it is worse.
            let store = store.lock().unwrap_or_else(|e| e.into_inner());
            let result = store.write_batch(|store| {
                for msg in batch.drain(..) {
                    match msg {
                        Msg::Write(write) => {
                            if let Err(error) = write.apply(store) {
                                eprintln!("[persist] write failed: {error}");
                            }
                        }
                        Msg::Ask(ask, reply) => {
                            let outcome = ask.apply(store).map_err(|e| e.to_string());
                            asked.push((reply, outcome));
                        }
                        Msg::Flush(reply) => replies.push(reply),
                    }
                }
                Ok(())
            });
            if let Err(error) = result {
                eprintln!("[persist] batch failed to commit: {error}");
            }
        }

        for (reply, outcome) in asked.drain(..) {
            let _ = reply.send(outcome);
        }
        for reply in replies.drain(..) {
            let _ = reply.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::task::Task;

    fn temp_store() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        (dir, path)
    }

    #[tokio::test]
    async fn flush_makes_queued_writes_durable() {
        let (_dir, path) = temp_store();
        let (persist, _store) = Persist::spawn(Store::open_at(&path).ok());

        let task = Task::new("demo", "prompt", "agent", vec![]);
        persist.task(&task);
        for i in 0..50 {
            persist.session_update(
                &task.id,
                &wire::SessionUpdate::AgentText {
                    text: format!("chunk {i}"),
                },
            );
        }
        persist.flush().await;

        let reader = Store::open_at(&path).unwrap();
        assert_eq!(reader.load_tasks().unwrap().len(), 1);
        assert_eq!(reader.load_session_updates(&task.id).unwrap().len(), 50);
    }

    /// The resume replay guard compares persisted updates one by one against
    /// the agent's replay, so a batch must not merge adjacent text chunks.
    #[tokio::test]
    async fn batching_preserves_row_identity_and_order() {
        let (_dir, path) = temp_store();
        let (persist, _store) = Persist::spawn(Store::open_at(&path).ok());

        let task = Task::new("demo", "prompt", "agent", vec![]);
        persist.task(&task);
        let chunks = ["one ", "two ", "three"];
        for text in chunks {
            persist.session_update(
                &task.id,
                &wire::SessionUpdate::AgentText {
                    text: text.to_string(),
                },
            );
        }
        persist.flush().await;

        let reader = Store::open_at(&path).unwrap();
        let stored = reader.load_session_updates(&task.id).unwrap();
        let texts: Vec<String> = stored
            .into_iter()
            .filter_map(|u| match u {
                wire::SessionUpdate::AgentText { text } => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(texts, chunks, "chunks must stay separate rows, in order");
    }

    #[tokio::test]
    async fn ask_reports_its_outcome() {
        let (_dir, path) = temp_store();
        let (persist, _store) = Persist::spawn(Store::open_at(&path).ok());

        let account = StoredAccount {
            id: "acct-1".into(),
            agent_id: "claude".into(),
            label: "work".into(),
            email: None,
            plan: None,
            home_dir: "/tmp/vault".into(),
            created_at: 0,
            active: true,
        };
        persist
            .ask(Ask::Account(Box::new(account)))
            .await
            .expect("account write should report success");

        let reader = Store::open_at(&path).unwrap();
        assert_eq!(reader.load_accounts().unwrap().len(), 1);
    }

    /// Without a database the daemon still runs; writes are dropped rather than
    /// failing, which is what the actor's old `if let Some(store)` guards did.
    #[tokio::test]
    async fn no_store_drops_writes_without_blocking() {
        let (persist, store) = Persist::spawn(None);
        assert!(store.is_none());
        persist.task(&Task::new("demo", "prompt", "agent", vec![]));
        persist.flush().await;
        assert!(persist.ask(Ask::DeleteAccount("nope".into())).await.is_ok());
    }
}
