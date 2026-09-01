use crate::daemon::actor::{Command, Daemon, Event};
use crate::daemon::task::Task;

impl Daemon {
    pub(crate) async fn handle_memory_command(&mut self, cmd: Command) {
        match cmd {
            Command::MemoryStore {
                content,
                scope,
                kind,
                tags,
                project_id,
                created_by,
                reply,
            } => {
                let result = self
                    .memory
                    .store(
                        &content,
                        scope.as_deref(),
                        kind.as_deref(),
                        tags.as_deref(),
                        project_id.as_deref(),
                        created_by.as_deref(),
                    )
                    .and_then(|m| {
                        serde_json::to_value(m).map_err(crate::daemon::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemorySearch {
                query,
                scope,
                limit,
                mode,
                reply,
            } => {
                let result = self
                    .memory
                    .search(&query, scope.as_deref(), limit, mode.as_deref())
                    .and_then(|v| {
                        serde_json::to_value(v).map_err(crate::daemon::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemoryList {
                scope,
                kind,
                limit,
                offset,
                reply,
            } => {
                let result = self
                    .memory
                    .list(scope.as_deref(), kind.as_deref(), limit, offset)
                    .and_then(|v| {
                        serde_json::to_value(v).map_err(crate::daemon::memory::MemoryError::from)
                    });
                let _ = reply.send(result);
            }
            Command::MemoryUpdate { id, content, reply } => {
                let result = self.memory.update(&id, &content).and_then(|m| {
                    serde_json::to_value(m).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::MemoryDelete { id, reply } => {
                let _ = reply.send(self.memory.delete(&id));
            }
            Command::MemoryStats { reply } => {
                let result = self.memory.stats().and_then(|s| {
                    serde_json::to_value(s).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::SetMemoryEmbedding { mode, reply } => {
                let result = self.memory.set_embedding(&mode).and_then(|s| {
                    serde_json::to_value(s).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(result);
            }
            Command::MemoryAddEdge {
                src_id,
                dst_id,
                relation,
                reply,
            } => {
                let r = self
                    .memory
                    .add_edge(&src_id, &dst_id, &relation)
                    .and_then(|e| {
                        serde_json::to_value(e).map_err(crate::daemon::memory::MemoryError::from)
                    });
                let _ = reply.send(r);
            }
            Command::MemoryEdges { id, reply } => {
                let r = self.memory.list_edges(&id).and_then(|v| {
                    serde_json::to_value(v).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryListCompaction { reply } => {
                let r = self.memory.list_compaction_log().and_then(|v| {
                    serde_json::to_value(v).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryResolveCompaction { id, approve, reply } => {
                let r = self.memory.resolve_compaction(id, approve).and_then(|s| {
                    serde_json::to_value(s).map_err(crate::daemon::memory::MemoryError::from)
                });
                let _ = reply.send(r);
            }
            Command::MemoryDream {
                dry_run,
                project_id,
                reply,
            } => {
                *self.last_memory_activity.lock().unwrap() = std::time::Instant::now();
                // Scheduler for idle/cron is spawned in Daemon::spawn when dreaming.enabled;
                // this handler just executes the pass. Dream uses dreaming agent/model
                // (fallback agent.default_model) via dream prompt over last_accessed ASC 200;
                // when no model configured it falls back to heuristic propose_compaction.
                let cfg = self.memory.config().dreaming.clone();
                let fallback = self
                    .configured_agents
                    .iter()
                    .find(|a| a.id == cfg.agent)
                    .and_then(|a| a.last_model.clone());
                let res = self
                    .memory
                    .dream_with_config(dry_run, &cfg, fallback.as_deref());
                if !dry_run {
                    if let Ok(v) = &res {
                        let inserted = v.get("inserted").and_then(|n| n.as_u64()).unwrap_or(0);
                        if inserted > 0 {
                            let pid = project_id.clone().unwrap_or_else(|| "global".to_string());
                            let title =
                                format!("Dreaming: {} \u{2014} {} proposals", pid, inserted);
                            let prompt = format!(
                                "Dreaming compaction proposals for project '{}': {}\nPending review in memory_compaction_log.",
                                pid, v
                            );
                            let mut task =
                                Task::new(&pid, &prompt, &cfg.agent, vec!["dreaming".into()]);
                            task.title = title;
                            // Dreaming is already done — proposals are in DB. Don't spawn agent;
                            // mark Waiting so board shows review-needed, not spinner/“warming up”.
                            task.status = crate::daemon::task::TaskStatus::Waiting;
                            // Rich prompt so conversation isn't blank
                            task.prompt = format!(
                                "Dreaming finished for '{}' — {} proposal(s).\n\n{}\n\n→ Review in Memory → Compaction (approve/reject). No agent session needed.",
                                pid, inserted, v
                            );
                            let tid = task.id.clone();
                            self.tasks.insert(tid.clone(), task.clone());
                            self.persist(&task);
                            self.emit(Event::TaskCreated(task));
                        }
                    }
                }
                let _ = reply.send(res);
            }

            other => self.handle_automation_command(other).await,
        }
    }
}
