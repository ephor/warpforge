use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, mpsc};

use crate::agent::AgentManager;
use crate::portforward::PortForwardManager;
use crate::registry::ProjectEntry;
use crate::service::ServiceManager;

use crate::daemon::acp::PolicyCheck;
use crate::daemon::actor::config_observer::HISTORY_PRUNE_INTERVAL;
use crate::daemon::actor::ConfigObserver;
use crate::daemon::actor::PendingPermissions;
use crate::daemon::actor::{Command, Daemon, DaemonHandle, Event};
use crate::daemon::store::Store;
use crate::policies::builtins::{BlastRadiusPolicy, SpawnBoundsPolicy};
use crate::policies::registry::PolicyRegistry;

impl Daemon {
    /// Persisted tasks are loaded from the store (Running/Queued tasks come back
    /// as Interrupted — no live-session resumption in v1).
    pub fn spawn(projects: Vec<ProjectEntry>, store: Option<Store>) -> DaemonHandle {
        Self::spawn_with_sink(
            projects,
            store,
            crate::daemon::actor::ports::PortRangeSink::for_current_build(),
        )
    }

    /// Like [`Daemon::spawn`], but with an explicit port-range persistence
    /// sink. Tests pass [`PortRangeSink::Registry`] to exercise real
    /// registry writes against a throwaway `WARPFORGE_HOME`, or rely on the
    /// default in-memory sink to keep test runs off the real registry.
    pub fn spawn_with_sink(
        projects: Vec<ProjectEntry>,
        store: Option<Store>,
        port_range_sink: crate::daemon::actor::ports::PortRangeSink,
    ) -> DaemonHandle {
        // Entries without a stored range at boot predate port persistence and
        // get the one-time positional migration. Everything added later — at
        // runtime or on a subsequent boot — falls through to a fresh scan.
        let positional_migration: std::collections::HashSet<String> = projects
            .iter()
            .filter(|entry| entry.port_range.is_none())
            .map(|entry| entry.name.clone())
            .collect();
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let (event_tx, _) = broadcast::channel(2048);
        let (agent_tx, agent_rx) = mpsc::unbounded_channel();
        let (service_tx, service_rx) = mpsc::unbounded_channel();
        let (pf_tx, pf_rx) = mpsc::unbounded_channel();
        let (acp_tx, acp_rx) = mpsc::unbounded_channel();
        let (policy_tx, policy_rx) = mpsc::unbounded_channel::<PolicyCheck>();

        let tasks = store
            .as_ref()
            .and_then(|s| s.load_tasks().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();

        let mut configured_agents = store
            .as_ref()
            .and_then(|s| s.load_agents().ok())
            .unwrap_or_default();
        // Migrate retired `npx …@latest` launch commands to the global-binary
        // form. Persist once if anything changed so it's a one-time rewrite.
        let mut migrated = false;
        for agent in &mut configured_agents {
            if let Some(new_cmd) =
                crate::daemon::agents::migrate_npx_command(&agent.id, &agent.acp_command)
            {
                agent.acp_command = new_cmd;
                migrated = true;
            }
        }
        if migrated {
            if let Some(store) = store.as_ref() {
                let _ = store.save_agents(&configured_agents);
            }
        }
        // Always present every known agent in canonical order, even those never
        // saved (e.g. newly installed). Keeps the UI list stable and complete
        // without waiting on live detection; version/install state is layered on
        // later by `agents.detect`.
        let configured_agents = crate::daemon::agents::reconcile_agents_config(&configured_agents);
        // Re-probe every enabled agent, cached list or not: the user may have
        // added a provider inside the harness (a new OpenCode provider, say)
        // since we last looked, and a cached list would hide it forever. The
        // cache still serves the UI instantly; the probe refreshes it behind it.
        let probe_candidates: Vec<String> = configured_agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect();

        let needs_setup = store
            .as_ref()
            .map(|s| !s.agents_configured())
            .unwrap_or(false);

        let orch_config = store
            .as_ref()
            .and_then(|s| s.load_orchestrator_config().ok())
            .flatten()
            .unwrap_or_default();

        // Only the stable tool-call timestamps survive startup. The full
        // transcripts are NOT loaded or held in memory — resume replay guards,
        // snapshots and finished-turn output read them from the store on demand.
        let tool_call_starts = store
            .as_ref()
            .and_then(|s| s.load_tool_call_starts().ok())
            .unwrap_or_default();

        let accounts = store
            .as_ref()
            .and_then(|s| s.load_accounts().ok())
            .unwrap_or_default();

        // Last known quota numbers, so the cards are populated before the first
        // poll answers. Entries whose login we cannot re-confirm are dropped by
        // the loader; the startup fetch below runs either way.
        let agent_limits = crate::daemon::limits::cache::load(&accounts);

        // Open (or disable) the shared-memory store. `load` never fails: an
        // unopenable memory.db yields a disabled store whose tools report
        // "memory disabled" rather than crashing the daemon.
        let memory = crate::daemon::memory::MemoryStore::load();

        // Everything above read from the store directly — it is startup, the
        // actor is not running yet. From here the connection belongs to the
        // persistence thread and writes go through the queue.
        let (persist, store) = crate::daemon::runtime::Persist::spawn(store);

        // Runs left mid-flight by the previous daemon instance cannot finish;
        // mark them failed BEFORE the automations load, so last_status is
        // reconciled against the final state of the run history, and seed the
        // per-automation run counters from the store while the connection is
        // still exclusive to this thread.
        if let Some(startup_store) = store.as_ref() {
            if let Ok(s) = startup_store.lock() {
                let _ = s.fail_inflight_automation_runs();
            }
        }
        let mut automation_run_counters: HashMap<String, u64> = HashMap::new();
        let startup_automations: std::collections::HashMap<String, warpforge_protocol::Automation> = {
            match store.as_ref().map(|s| s.lock()) {
                Some(Ok(s)) => {
                    let mut map = std::collections::HashMap::new();
                    for mut a in s.load_automations().unwrap_or_default() {
                        automation_run_counters.insert(
                            a.id.clone(),
                            s.next_automation_run_number(&a.id)
                                .unwrap_or(1)
                                .saturating_sub(1),
                        );
                        // A run that the sweep just failed may have been the
                        // automation's last known status; do not present a
                        // mid-flight status the daemon can no longer be in.
                        if matches!(
                            a.last_status,
                            Some(warpforge_protocol::AutomationRunStatus::Pending)
                                | Some(warpforge_protocol::AutomationRunStatus::Running)
                        ) {
                            a.last_status = Some(warpforge_protocol::AutomationRunStatus::Failed);
                        }
                        map.insert(a.id.clone(), a);
                    }
                    map
                }
                _ => Default::default(),
            }
        };
        let persist_handle = persist.clone();
        for a in startup_automations.values() {
            if a.last_status == Some(warpforge_protocol::AutomationRunStatus::Failed) {
                persist_handle.write(crate::daemon::runtime::Write::Automation(Box::new(
                    a.clone(),
                )));
            }
        }

        let config_observer = ConfigObserver::new(&projects);
        let daemon = Daemon {
            agent_limits,
            projects,
            port_ranges: HashMap::new(),
            port_range_sink,
            positional_migration,
            config_observer,
            tasks,
            configured_agents,
            sessions: HashMap::new(),
            pending_permissions: PendingPermissions::default(),
            agents: AgentManager::new(agent_tx),
            services: ServiceManager::new(service_tx),
            portforwards: PortForwardManager::new(pf_tx),
            lsp: crate::daemon::lsp::LspManager::new(event_tx.clone()),
            event_tx: event_tx.clone(),
            acp_tx,
            cmd_tx: cmd_tx.clone(),
            persist,
            store,
            resume_replay: HashMap::new(),
            worktrees: HashMap::new(),
            pending_session_starts: HashMap::new(),
            policies: default_policies(),
            policy_tx,
            orch_tx: None,
            orch_event_rx: None,
            orch_config,
            orchestrator_inbox: HashMap::new(),
            pending_wake: std::collections::HashSet::new(),
            tool_call_starts,
            last_session_update: HashMap::new(),
            turn_updates: HashMap::new(),
            pending_resume: HashMap::new(),
            workflow_runs: HashMap::new(),
            accounts,
            credential_capture: Arc::new(Mutex::new(Default::default())),
            last_credential_capture: None,
            memory,
            last_memory_activity: Arc::new(Mutex::new(std::time::Instant::now())),
            spend_cache: None,
            automations: startup_automations,
            automation_active: HashMap::new(),
            automation_run_owner: HashMap::new(),
            automation_runs_live: HashMap::new(),
            automation_run_tasks: HashMap::new(),
            automation_run_counters,
        };

        let handle = DaemonHandle { cmd_tx, event_tx };

        // Detect installed agents in background so it doesn't block startup,
        // then emit setup_needed if no agents are configured yet.
        if needs_setup {
            let ev_tx = handle.event_tx.clone();
            tokio::spawn(async move {
                let detected = crate::daemon::agents::detect_agents_local().await;
                let _ = ev_tx.send(Event::AgentsSetupNeeded { detected });
            });
        }

        // Spawn the orchestrator with loaded config.
        let orch_config = daemon.orch_config.clone();
        let orch_handle = handle.clone();
        let (orch_cmd_tx, orch_event_bcast) =
            crate::orchestration::spawn_orchestrator(orch_config, orch_handle);

        // Forward orchestrator events into the daemon broadcast.
        let ev_tx = handle.event_tx.clone();
        let mut orch_event_rx = orch_event_bcast.subscribe();
        tokio::spawn(async move {
            while let Ok(ev) = orch_event_rx.recv().await {
                let _ = ev_tx.send(Event::OrchestrationEvent(ev));
            }
        });

        // Rebuild daemon with orchestrator handles.
        let mut daemon = daemon;
        daemon.orch_tx = Some(orch_cmd_tx);
        daemon.orch_event_rx = None; // receiver moved to forwarder task
                                     // Bring persisted workflow pipelines back: barrier states as-is,
                                     // mid-stage runs paused at their last barrier.
        daemon.restore_workflow_runs();

        // Dreaming idle/cron scheduler (config-driven, enabled false by default)
        let dream_cfg = daemon.memory.config().dreaming.clone();
        let dream_tx = handle.cmd_tx.clone();
        if dream_cfg.enabled && dream_cfg.trigger == "idle" {
            let idle = crate::daemon::memory_dream::parse_idle_after(&dream_cfg.idle_after);
            let last_activity = daemon.last_memory_activity.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(idle).await;
                    let been_idle = last_activity.lock().unwrap().elapsed() >= idle;
                    if !been_idle {
                        continue;
                    }
                    let (tx, _rx) = tokio::sync::oneshot::channel();
                    let _ = dream_tx
                        .send(Command::MemoryDream {
                            dry_run: false,
                            project_id: None,
                            reply: tx,
                        })
                        .await;
                }
            });
        } else if dream_cfg.enabled && dream_cfg.trigger == "cron" {
            let cron_str = dream_cfg.cron.clone();
            tokio::spawn(async move {
                // Full cron parsing is deferred (no extra dep): treat the configured
                // cron (default "0 3 * * *") as a daily-3am stub approximated by a
                // periodic loop. Keeps looping forever; the daemon dedupes via the
                // pending-compaction check. Config change requires restart.
                let _ = cron_str;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let (tx, _rx) = tokio::sync::oneshot::channel();
                    let _ = dream_tx
                        .send(Command::MemoryDream {
                            dry_run: false,
                            project_id: None,
                            reply: tx,
                        })
                        .await;
                }
            });
        }

        // Automation scheduler: every minute, fire due schedules, honour the
        // per-automation timezone and missed-run grace window. Runs left
        // mid-flight by the previous daemon instance are marked failed first.
        let automation_tx = handle.cmd_tx.clone();
        tokio::spawn(async move {
            // Align the tick to wall-clock minute boundaries so scheduled
            // runs fire within a second of their minute, not up to a minute
            // after it (the old phase drifted with daemon start time).
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            let to_next_minute = Duration::from_secs(60 - now.as_secs() % 60);
            tokio::time::sleep(to_next_minute).await;
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                if automation_tx.send(Command::AutomationTick).await.is_err() {
                    break;
                }
                tick.tick().await;
            }
        });

        // History retention sweeps: once at start (so a shortened window
        // applies without waiting a day), then daily.
        let prune_tx = handle.cmd_tx.clone();
        tokio::spawn(async move {
            loop {
                if prune_tx.send(Command::PruneHistory).await.is_err() {
                    break;
                }
                tokio::time::sleep(HISTORY_PRUNE_INTERVAL).await;
            }
        });

        // Initial limits refresh (off-actor) — accounts are known at spawn.
        let init_accounts = daemon.accounts.clone();
        let init_tx = handle.cmd_tx.clone();
        tokio::spawn(async move {
            let fetched = crate::daemon::limits::poll::fetch_all(init_accounts).await;
            let _ = init_tx
                .send(Command::AgentLimitsUpdated { accounts: fetched })
                .await;
        });

        tokio::spawn(daemon.run(cmd_rx, agent_rx, service_rx, pf_rx, acp_rx, policy_rx));

        // Kick off background ACP probes so every enabled agent's model list is
        // whatever the harness reports right now. Probes update the cache via
        // `Command::AgentProbed`; cheap to issue even before `run` is ready.
        let probe_tx = handle.cmd_tx.clone();
        if !probe_candidates.is_empty() {
            tokio::spawn(async move {
                for id in probe_candidates {
                    let _ = probe_tx.send(Command::ProbeAgent { id, reply: None }).await;
                }
            });
        }

        handle
    }
}

pub(crate) fn default_policies() -> PolicyRegistry {
    let mut reg = PolicyRegistry::new();
    reg.push(Box::new(BlastRadiusPolicy::default()));
    reg.push(Box::new(SpawnBoundsPolicy::new(6)));
    // CostBudget disabled by default (max=∞). Enable via config when needed.
    // WorktreeGuard enabled per-task in start_session, not globally.
    reg
}
