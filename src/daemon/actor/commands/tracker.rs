use warpforge_protocol as wire;

use crate::daemon::actor::{Command, Daemon};

impl Daemon {
    pub(crate) async fn handle_tracker_command(&mut self, cmd: Command) {
        match cmd {
            Command::TrackerPersistLink { link, reply } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store
                            .upsert_tracker_link(&link)
                            .map_err(|e| format!("failed to persist link: {e:#}"))
                    }
                    None => Err("daemon has no persistent store (demo mode?)".into()),
                };
                let _ = reply.send(result);
            }
            Command::TrackerLinks { reply } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        crate::daemon::tracker::list_links(&store)
                            .map_err(|e: anyhow::Error| format!("{e:#}"))
                    }
                    None => Ok(Vec::new()),
                };
                let _ = reply.send(result);
            }
            Command::TrackerProjectSettings { project, reply } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| "daemon has no persistent store".to_string())
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store
                            .tracker_project_settings(&project)
                            .map_err(|e| format!("{e:#}"))
                    });
                let _ = reply.send(result);
            }
            Command::TrackerSetProjectLinearTeam {
                project,
                team_id,
                team_name,
                reply,
            } => {
                let result = self
                    .store
                    .as_ref()
                    .ok_or_else(|| "daemon has no persistent store".to_string())
                    .and_then(|store| {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        // Pointing a project somewhere else (or nowhere) makes the
                        // rows the old team put here meaningless, so they go with
                        // the mapping. Only rows an import minted are eligible —
                        // see `Store::delete_imported_linear_items`.
                        let previous = store
                            .tracker_project_settings(&project)
                            .map_err(|e| format!("{e:#}"))?
                            .linear_team_id;
                        if previous.as_deref() != team_id.as_deref() {
                            match store.delete_imported_linear_items(&project) {
                                Ok(0) => {}
                                Ok(n) => eprintln!(
                                    "[tracker] dropped {n} imported Linear rows from \
                                     '{project}' after its team mapping changed"
                                ),
                                Err(e) => {
                                    return Err(format!("clearing old Linear rows failed: {e:#}"))
                                }
                            }
                        }
                        store
                            .set_tracker_project_linear_team(
                                &project,
                                team_id.as_deref(),
                                team_name.as_deref(),
                            )
                            .map_err(|e| format!("{e:#}"))
                    });
                let _ = reply.send(result);
            }
            Command::TrackerSyncInputs { ids, reply } => {
                let links: Vec<crate::daemon::store::TrackerLink> = match &self.store {
                    Some(store) if ids.is_empty() => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        store.load_all_tracker_links().unwrap_or_default()
                    }
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        ids.iter()
                            .filter_map(|id| store.load_tracker_link(id).ok().flatten())
                            .collect()
                    }
                    None => Vec::new(),
                };
                let mut repo_dirs = std::collections::HashMap::new();
                let mut linear_teams = std::collections::HashMap::new();
                for link in &links {
                    if link.provider == "github" && !repo_dirs.contains_key(&link.project) {
                        if let Some(path) = self.project_path(&link.project) {
                            repo_dirs.insert(link.project.clone(), path);
                        }
                    }
                    if link.provider == "linear" && !linear_teams.contains_key(&link.project) {
                        if let Some(team) = self
                            .store
                            .as_ref()
                            .and_then(|store| {
                                let store = store.lock().unwrap_or_else(|e| e.into_inner());
                                store.tracker_project_settings(&link.project).ok()
                            })
                            .and_then(|settings| settings.linear_team_id)
                        {
                            linear_teams.insert(link.project.clone(), team);
                        }
                    }
                }
                let _ = reply.send((links, repo_dirs, linear_teams));
            }
            Command::TrackerPersistSynced { links, reply } => {
                if let Some(store) = &self.store {
                    let store = store.lock().unwrap_or_else(|e| e.into_inner());
                    for link in &links {
                        if let Err(e) = store.upsert_tracker_link(link) {
                            eprintln!("[tracker] failed to persist sync for {}: {e}", link.item_id);
                        }
                        if store.backlog_storage_mode().ok() == Some(wire::BacklogStorageMode::Yaml)
                        {
                            if let Some(path) = self.project_path(&link.project) {
                                let result = crate::daemon::backlog::update(
                                    &path,
                                    &link.project,
                                    &link.item_id,
                                    |item| {
                                        item.status = link.status.clone();
                                        item.remote_status = link.remote_status.clone();
                                        item.url = Some(link.url.clone());
                                        item.updated_at = crate::daemon::task::now_secs();
                                    },
                                );
                                if let Err(e) = result {
                                    eprintln!(
                                        "[backlog] failed to update YAML remote status for {}: {e}",
                                        link.item_id
                                    );
                                }
                            }
                        }
                        if store.backlog_storage_mode().ok()
                            == Some(wire::BacklogStorageMode::Sqlite)
                        {
                            if let Err(e) = store.update_backlog_remote(
                                &link.item_id,
                                &link.status,
                                link.remote_status.as_deref(),
                                &link.url,
                                crate::daemon::task::now_secs(),
                            ) {
                                eprintln!(
                                    "[backlog] failed to persist remote status for {}: {e}",
                                    link.item_id
                                );
                            }
                        }
                    }
                }
                let _ = reply.send(());
            }
            Command::TrackerDeleteItems { ids, reply } => {
                if let Some(store) = &self.store {
                    let store = store.lock().unwrap_or_else(|e| e.into_inner());
                    let mode = store.backlog_storage_mode().ok();
                    for item_id in ids {
                        // need project for YAML mode — get link before deleting it
                        let project = store
                            .load_tracker_link(&item_id)
                            .ok()
                            .flatten()
                            .map(|l| l.project);
                        if mode == Some(wire::BacklogStorageMode::Yaml) {
                            if let Some(proj) = &project {
                                if let Some(path) = self.project_path(proj) {
                                    let _ = crate::daemon::backlog::remove(&path, proj, &item_id);
                                }
                            }
                        } else {
                            let _ = store.delete_backlog_item(&item_id);
                        }
                        let _ = store.delete_tracker_link(&item_id);
                    }
                }
                let _ = reply.send(());
            }
            Command::TrackerAdoptImported {
                project,
                fetched,
                reply,
            } => {
                let result = match &self.store {
                    Some(store) => {
                        let store = store.lock().unwrap_or_else(|e| e.into_inner());
                        // YAML mode keeps backlog item rows project-local in
                        // `…/.warpforge/backlog/`; SQLite mode keeps them in the
                        // `backlog_items` table. `adopt_imported` is told which
                        // so it never writes a shadow row to the other backend.
                        let yaml_path = if store.backlog_storage_mode().ok()
                            == Some(wire::BacklogStorageMode::Yaml)
                        {
                            self.project_path(&project)
                        } else {
                            None
                        };
                        crate::daemon::tracker::adopt_imported(
                            &store,
                            &project,
                            yaml_path.as_deref(),
                            fetched,
                        )
                        .map_err(|e: anyhow::Error| format!("{e:#}"))
                    }
                    None => Ok((Vec::new(), Vec::new())),
                };
                let _ = reply.send(result);
            }

            other => self.handle_backlog_command(other).await,
        }
    }
}
