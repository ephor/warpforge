use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::runtime::Write as PersistWrite;
use crate::daemon::wire as wireconv;

impl Daemon {
    pub(crate) async fn handle_accounts_command(&mut self, cmd: Command) {
        match cmd {
            Command::ListAccounts { reply } => {
                let _ = reply.send(self.account_infos());
            }
            Command::ListAgentLimits { reply, refresh } => {
                if refresh {
                    let accounts = self.accounts.clone();
                    let cmd_tx = self.cmd_tx.clone();
                    tokio::spawn(async move {
                        // Deliberately not `fetch_all_force`: a manual Refresh while
                        // an endpoint is throttling us would just earn another 429.
                        let fetched = crate::daemon::limits::poll::fetch_all(accounts).await;
                        let _ = cmd_tx
                            .send(Command::AgentLimitsUpdated {
                                accounts: fetched.clone(),
                            })
                            .await;
                        let _ = reply.send(fetched);
                    });
                } else {
                    let _ = reply.send(self.agent_limits.clone());
                }
            }
            Command::AgentLimitsUpdated { accounts } => {
                let merged =
                    crate::daemon::limits::poll::merge_snapshots(&self.agent_limits, accounts);
                self.agent_limits = merged.clone();
                // Persist off-actor: reading each account's identity touches
                // the filesystem and this loop is the whole daemon.
                let snapshot = merged.clone();
                let known = self.accounts.clone();
                tokio::task::spawn_blocking(move || {
                    crate::daemon::limits::cache::save(&snapshot, &known)
                });
                self.emit(Event::AgentLimitsUpdated { accounts: merged });
            }
            Command::ListAgentSpend { reply } => {
                if let Some((cached, at)) = &self.spend_cache {
                    if at.elapsed() < std::time::Duration::from_secs(300) {
                        let _ = reply.send(cached.clone());
                        return;
                    }
                }
                let store = self.store.clone();
                let tasks: Vec<wire::TaskInfo> =
                    self.tasks.values().map(wireconv::task_info).collect();
                let tx = self.cmd_tx.clone();
                tokio::spawn(async move {
                    let rows =
                        crate::daemon::runtime::store_read(store, |s| s.load_spend_rows().ok())
                            .await
                            .unwrap_or(None)
                            .unwrap_or_default();
                    let agents = crate::daemon::spend::compute_agent_spend(rows, &tasks);
                    let _ = tx
                        .send(Command::AgentSpendUpdated {
                            agents: agents.clone(),
                            at: std::time::Instant::now(),
                        })
                        .await;
                    let _ = reply.send(agents);
                });
            }
            Command::AgentSpendUpdated { agents, at } => {
                self.spend_cache = Some((agents, at));
            }
            Command::ImportAccount {
                agent_id,
                label,
                reply,
            } => {
                let result = self.import_account(&agent_id, &label).await;
                let _ = reply.send(result);
            }
            Command::RenameAccount {
                account_id,
                label,
                reply,
            } => {
                let result = match self.accounts.iter_mut().find(|a| a.id == account_id) {
                    Some(account) => {
                        account.label = label;
                        let updated = account.clone();
                        self.persist.write(PersistWrite::Account(Box::new(updated)));
                        Ok(())
                    }
                    None => Err(format!("no account {account_id}")),
                };
                let _ = reply.send(result.map(|()| self.emit_accounts()));
            }
            Command::RemoveAccount { account_id, reply } => {
                let result = self.remove_account(&account_id).await;
                let _ = reply.send(result);
            }
            Command::SetActiveAccount {
                agent_id,
                account_id,
                reply,
            } => {
                let result = self.set_active_account(&agent_id, &account_id).await;
                if result.is_ok() {
                    // Restamp which account is live without refetching: the quota
                    // numbers did not change, only which login they belong to.
                    // Waiting for the next 20-minute poll left the header showing
                    // the previous account's percentage after a switch.
                    for entry in &mut self.agent_limits {
                        if entry.agent_id == agent_id {
                            entry.active = entry.account_id == account_id;
                        }
                    }
                    self.emit(Event::AgentLimitsUpdated {
                        accounts: self.agent_limits.clone(),
                    });
                }
                let _ = reply.send(result);
            }

            other => self.handle_memory_command(other).await,
        }
    }
}
