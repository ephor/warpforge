use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon};

impl Daemon {
    pub(crate) async fn handle_backlog_command(&mut self, cmd: Command) {
        match cmd {
            Command::BacklogGetSettings { reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store.backlog_storage_mode()
                    })
                    .map(|mode| wire::BacklogSettings { mode })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogSetStorage { mode, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let from = store.backlog_storage_mode()?;
                        if from != mode {
                            // Switching backends must not silently hide rows in
                            // the one being left. Refuse until those rows are
                            // gone (or moved), surfaced as a clear error.
                            match (from, mode) {
                                (wire::BacklogStorageMode::Sqlite, wire::BacklogStorageMode::Yaml) => {
                                    let count = store.count_backlog_items()?;
                                    if count > 0 {
                                        anyhow::bail!(
                                            "Cannot switch backlog to YAML while {count} backlog item(s) still live in SQLite. Delete or move them first."
                                        );
                                    }
                                }
                                (wire::BacklogStorageMode::Yaml, wire::BacklogStorageMode::Sqlite) => {
                                    for project in &self.projects {
                                        let Some(path) = self.project_path(&project.name) else {
                                            continue;
                                        };
                                        if !crate::daemon::backlog::list(&path, &project.name)?.is_empty() {
                                            anyhow::bail!(
                                                "Cannot switch backlog to SQLite while project '{}' has YAML backlog files. Delete or move them first.",
                                                project.name
                                            );
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        store.set_backlog_storage_mode(mode)
                    })
                    .map(|_| wire::BacklogSettings { mode })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogList {
                project,
                query,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project '{project}'"))?;
                            let items = crate::daemon::backlog::list(&path, &project)?;
                            Ok(crate::daemon::backlog::page(items, &query))
                        } else {
                            store.list_backlog(&project, &query)
                        }
                    })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogCreate { item: new, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let project = new.project;
                        let now = crate::daemon::task::now_secs();
                        let (number, yaml_path) =
                            if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                                let path = self.project_path(&project).ok_or_else(|| {
                                    anyhow::anyhow!("unknown project '{project}'")
                                })?;
                                let items = crate::daemon::backlog::list(&path, &project)?;
                                (crate::daemon::backlog::next_number(&items), Some(path))
                            } else {
                                (store.next_backlog_number(&project)?, None)
                            };
                        let item = wire::BacklogItem {
                            id: format!("b_{}", uuid::Uuid::new_v4().simple()),
                            number,
                            project,
                            title: new.title,
                            body: new.body,
                            status: if new.status.is_empty() {
                                "todo".into()
                            } else {
                                new.status
                            },
                            priority: if new.priority.is_empty() {
                                "none".into()
                            } else {
                                new.priority
                            },
                            source: if new.source.is_empty() {
                                "local".into()
                            } else {
                                new.source
                            },
                            external_id: None,
                            url: None,
                            remote_status: None,
                            assignee: new.assignee,
                            created_at: now,
                            updated_at: now,
                            task_id: None,
                        };
                        if let Some(path) = yaml_path {
                            crate::daemon::backlog::write(&path, &item)?;
                        } else {
                            store.upsert_backlog_item(&item)?;
                        }
                        Ok(item)
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogUpdate { patch, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let yaml = store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml;
                        let path = if yaml {
                            Some(self.project_path(&patch.project).ok_or_else(|| {
                                anyhow::anyhow!("unknown project '{}'", patch.project)
                            })?)
                        } else {
                            None
                        };
                        let mut item = match &path {
                            Some(path) => crate::daemon::backlog::list(path, &patch.project)?
                                .into_iter()
                                .find(|item| item.id == patch.item_id),
                            None => store.get_backlog_item(&patch.item_id)?,
                        }
                        .ok_or_else(|| anyhow::anyhow!("backlog item not found"))?;
                        patch.apply(&mut item);
                        item.updated_at = crate::daemon::task::now_secs();
                        match &path {
                            Some(path) => crate::daemon::backlog::write(path, &item)?,
                            None => store.upsert_backlog_item(&item)?,
                        }
                        Ok(item)
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogAttachExternal {
                item_id,
                project,
                provider,
                external_id,
                url,
                remote_status,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project"))?;
                            let mut item = crate::daemon::backlog::list(&path, &project)?
                                .into_iter()
                                .find(|item| item.id == item_id)
                                .ok_or_else(|| anyhow::anyhow!("backlog item not found"))?;
                            item.source = provider;
                            item.external_id = Some(external_id);
                            item.url = Some(url);
                            item.remote_status = remote_status;
                            crate::daemon::backlog::write(&path, &item)
                        } else {
                            store.patch_backlog_external(
                                &item_id,
                                &external_id,
                                &url,
                                &provider,
                                remote_status.as_deref(),
                            )
                        }
                    })
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::BacklogDelete {
                item_id,
                project,
                reply,
            } => {
                // Compensating cleanup for a failed external create: drop the
                // local item in whichever backend holds it AND its tracker link,
                // so a remote-create failure never leaves an item that claims to
                // live in a tracker it never reached.
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                            let path = self
                                .project_path(&project)
                                .ok_or_else(|| anyhow::anyhow!("unknown project"))?;
                            crate::daemon::backlog::remove(&path, &project, &item_id)?;
                        } else {
                            store.delete_backlog_item(&item_id)?;
                        }
                        store.delete_tracker_link(&item_id)?;
                        Ok(())
                    })
                    .map_err(|e: anyhow::Error| format!("{e:#}"));
                let _ = reply.send(result);
            }
            Command::WorkItemLinkTask {
                item_id,
                task_id,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("daemon has no persistent store (demo mode?)"))
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        let project = self
                            .tasks
                            .get(&task_id)
                            .map(|t| t.project.clone())
                            .unwrap_or_default();
                        crate::daemon::tracker::link_task(
                            &store, &item_id, &task_id, "local", &project,
                        )
                        .and_then(|_| {
                            if store.backlog_storage_mode()? == wire::BacklogStorageMode::Sqlite {
                                store.link_backlog_task(&item_id, &task_id)?;
                            }
                            Ok(())
                        })
                        .and_then(|_| {
                            if store.backlog_storage_mode()? == wire::BacklogStorageMode::Yaml {
                                let path = self.project_path(&project).ok_or_else(|| {
                                    anyhow::anyhow!("unknown project '{project}'")
                                })?;
                                crate::daemon::backlog::update(
                                    &path,
                                    &project,
                                    &item_id,
                                    |item| {
                                        item.task_id = Some(task_id.clone());
                                        item.status = "in_progress".into();
                                        item.updated_at = crate::daemon::task::now_secs();
                                    },
                                )?;
                            }
                            Ok(())
                        })
                    });
                let _ = reply.send(result.map_err(|e: anyhow::Error| format!("{e:#}")));
            }

            other => self.handle_session_command(other).await,
        }
    }
}
