//! Multi-agent orchestrator: drives the Planner→Worker→Reviewer pipeline.
//!
//! The orchestrator is a lightweight actor that receives goals, spawns a
//! planner agent to decompose them into a task graph, then dispatches workers
//! and reviewers as nodes become ready.

pub mod config;
pub mod graph;

use std::collections::HashMap;

use tokio::sync::{broadcast, mpsc, oneshot};

use crate::daemon::DaemonHandle;
use graph::{NodeKind, NodeStatus, TaskGraph};

/// Commands sent to the orchestrator.
#[derive(Debug)]
pub enum OrchCommand {
    /// Submit a goal for orchestration.
    StartPlan {
        project: String,
        goal: String,
        reply: oneshot::Sender<String>,
    },
    /// A worker/reviewer node completed its task.
    NodeComplete {
        graph_id: String,
        node_id: String,
        task_id: String,
        result: String,
    },
    /// A node failed.
    NodeFailed {
        graph_id: String,
        node_id: String,
        task_id: String,
        reason: String,
    },
    /// A dispatched daemon task reached a terminal state. The orchestrator maps
    /// the daemon task id back to its graph node (it owns that mapping) and
    /// advances the pipeline. This is the feedback loop that turns a finished
    /// planner into dispatched workers, and finished workers into reviewers.
    TaskFinished {
        task_id: String,
        result: String,
        success: bool,
    },
    /// Cancel an entire orchestration.
    Cancel { graph_id: String },
    /// List active orchestration graphs.
    List(oneshot::Sender<Vec<GraphInfo>>),
}

/// Summary of an active orchestration for display.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GraphInfo {
    pub id: String,
    pub project: String,
    pub goal: String,
    pub total_nodes: usize,
    pub completed_nodes: usize,
    pub failed_nodes: usize,
    pub running_nodes: usize,
}

/// Events emitted by the orchestrator.
#[derive(Debug, Clone)]
pub enum OrchEvent {
    PlanCreated {
        graph_id: String,
        project: String,
        goal: String,
    },
    NodeDispatched {
        graph_id: String,
        node_id: String,
        task_id: String,
        agent: String,
        kind: String,
    },
    NodeCompleted {
        graph_id: String,
        node_id: String,
        task_id: String,
    },
    NodeFailed {
        graph_id: String,
        node_id: String,
        task_id: String,
        reason: String,
    },
    AllComplete {
        graph_id: String,
        project: String,
    },
    Error {
        graph_id: String,
        reason: String,
    },
}

pub struct Orchestrator {
    config: config::OrchestratorConfig,
    daemon: DaemonHandle,
    graphs: HashMap<String, TaskGraph>,
    event_tx: broadcast::Sender<OrchEvent>,
}

impl Orchestrator {
    pub fn new(config: config::OrchestratorConfig, daemon: DaemonHandle) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            config,
            daemon,
            graphs: HashMap::new(),
            event_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OrchEvent> {
        self.event_tx.subscribe()
    }

    pub fn event_sender(&self) -> broadcast::Sender<OrchEvent> {
        self.event_tx.clone()
    }

    /// Start the orchestrator actor loop.
    pub async fn run(mut self, mut cmd_rx: mpsc::Receiver<OrchCommand>) {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                OrchCommand::StartPlan {
                    project,
                    goal,
                    reply,
                } => {
                    let graph_id = self.handle_start_plan(&project, &goal).await;
                    let _ = reply.send(graph_id);
                }
                OrchCommand::NodeComplete {
                    graph_id,
                    node_id,
                    task_id,
                    result,
                } => {
                    self.handle_node_complete(&graph_id, &node_id, &task_id, result)
                        .await;
                }
                OrchCommand::NodeFailed {
                    graph_id,
                    node_id,
                    task_id,
                    reason,
                } => {
                    self.handle_node_failed(&graph_id, &node_id, &task_id, &reason)
                        .await;
                }
                OrchCommand::TaskFinished {
                    task_id,
                    result,
                    success,
                } => {
                    self.handle_task_finished(&task_id, result, success).await;
                }
                OrchCommand::Cancel { graph_id } => {
                    self.graphs.remove(&graph_id);
                }
                OrchCommand::List(reply) => {
                    let infos: Vec<GraphInfo> = self
                        .graphs
                        .values()
                        .map(|g| graph_info(g))
                        .collect();
                    let _ = reply.send(infos);
                }
            }
        }
    }

    async fn handle_start_plan(&mut self, project: &str, goal: &str) -> String {
        let mut graph =
            TaskGraph::new(project, goal, &self.config.planner_agent);
        let graph_id = graph.id.clone();

        // Dispatch the planner node
        let root_id = graph.root_id.clone();
        let planner_prompt = format!(
            "You are the planner agent. Decompose this goal into a task graph.\n\n\
             Goal: {goal}\n\n\
             Return JSON with this structure:\n\
             {{\"tasks\": [{{\"spec\": \"...\", \"depends_on\": [\"0\", ...]}}], \
              \"reviews\": [{{\"diff_ref\": \"HEAD\", \"target\": \"0\"}}]}}\n\n\
             Each task gets a spec (what to do) and depends_on (indices of tasks that must finish first).\n\
             Reviews target the task index they review."
        );

        match self
            .daemon
            .create_task(
                project,
                &planner_prompt,
                &self.config.planner_agent,
                vec!["orchestrator".into(), "planner".into()],
                true,
                false,
                None,
            )
            .await
        {
            task_id if !task_id.is_empty() => {
                if let Some(node) = graph.nodes.get_mut(&root_id) {
                    node.daemon_task_id = Some(task_id.clone());
                    node.status = NodeStatus::Running;
                }
                self.graphs.insert(graph_id.clone(), graph);
                let _ = self.event_tx.send(OrchEvent::PlanCreated {
                    graph_id: graph_id.clone(),
                    project: project.to_string(),
                    goal: goal.to_string(),
                });
                let _ = self.event_tx.send(OrchEvent::NodeDispatched {
                    graph_id: graph_id.clone(),
                    node_id: root_id,
                    task_id,
                    agent: self.config.planner_agent.clone(),
                    kind: "plan".into(),
                });
            }
            _ => {
                let _ = self.event_tx.send(OrchEvent::Error {
                    graph_id: graph_id.clone(),
                    reason: "Failed to create planner task".into(),
                });
            }
        }

        graph_id
    }

    async fn handle_node_complete(
        &mut self,
        graph_id: &str,
        node_id: &str,
        task_id: &str,
        result: String,
    ) {
        let graph = match self.graphs.get_mut(graph_id) {
            Some(g) => g,
            None => return,
        };

        graph.complete(node_id, Some(result.clone()));

        // If this was the planner node, parse its output into subtasks
        let node_kind = graph.nodes.get(node_id).map(|n| n.kind.clone());
        if matches!(node_kind, Some(NodeKind::Plan)) {
            graph.parse_plan_output(&result, &self.config);
        }

        let _ = self.event_tx.send(OrchEvent::NodeCompleted {
            graph_id: graph_id.to_string(),
            node_id: node_id.to_string(),
            task_id: task_id.to_string(),
        });

        // Check if all done
        if graph.all_done() {
            let project = graph.project.clone();
            let _ = self.event_tx.send(OrchEvent::AllComplete {
                graph_id: graph_id.to_string(),
                project,
            });
            return;
        }

        // Dispatch any newly ready nodes
        self.dispatch_ready_nodes(graph_id).await;
    }

    async fn handle_node_failed(
        &mut self,
        graph_id: &str,
        node_id: &str,
        task_id: &str,
        reason: &str,
    ) {
        let graph = match self.graphs.get_mut(graph_id) {
            Some(g) => g,
            None => return,
        };

        graph.fail(node_id, reason);

        let _ = self.event_tx.send(OrchEvent::NodeFailed {
            graph_id: graph_id.to_string(),
            node_id: node_id.to_string(),
            task_id: task_id.to_string(),
            reason: reason.to_string(),
        });

        // Skip dependent nodes
        let failed_id = node_id.to_string();
        let to_skip: Vec<String> = graph
            .nodes
            .values()
            .filter(|n| n.depends_on.contains(&failed_id))
            .map(|n| n.id.clone())
            .collect();
        for skip_id in to_skip {
            graph.fail(&skip_id, &format!("dependency {failed_id} failed"));
        }

        if graph.all_done() {
            let project = graph.project.clone();
            let _ = self.event_tx.send(OrchEvent::AllComplete {
                graph_id: graph_id.to_string(),
                project,
            });
        }
    }

    /// Map a finished daemon task back to its graph node and advance. The
    /// `Running` guard makes this idempotent: once the node is Complete/Failed a
    /// second `TurnEnded` (e.g. a multi-turn agent) no longer matches, so we
    /// never re-parse a plan or re-dispatch.
    async fn handle_task_finished(&mut self, task_id: &str, result: String, success: bool) {
        let found = self.graphs.iter().find_map(|(gid, g)| {
            g.nodes
                .values()
                .find(|n| {
                    n.daemon_task_id.as_deref() == Some(task_id)
                        && n.status == NodeStatus::Running
                })
                .map(|n| (gid.clone(), n.id.clone()))
        });
        let Some((graph_id, node_id)) = found else {
            return;
        };
        if success {
            self.handle_node_complete(&graph_id, &node_id, task_id, result)
                .await;
        } else {
            self.handle_node_failed(&graph_id, &node_id, task_id, &result)
                .await;
        }
    }

    async fn dispatch_ready_nodes(&mut self, graph_id: &str) {
        let ready: Vec<(String, String, String, bool)> = {
            let graph = match self.graphs.get(graph_id) {
                Some(g) => g,
                None => return,
            };
            graph
                .ready_nodes()
                .iter()
                .map(|n| {
                    let worktree = matches!(n.kind, NodeKind::Implement { .. })
                        && self.config.worktrees_enabled;
                    (
                        n.id.clone(),
                        n.agent.clone(),
                        node_prompt(n),
                        worktree,
                    )
                })
                .collect()
        };

        for (node_id, agent, prompt, worktree) in ready {
            let project = self
                .graphs
                .get(graph_id)
                .map(|g| g.project.clone())
                .unwrap_or_default();

            let kind_str = match &self
                .graphs
                .get(graph_id)
                .and_then(|g| g.nodes.get(&node_id))
                .map(|n| &n.kind)
            {
                Some(NodeKind::Plan) => "plan",
                Some(NodeKind::Implement { .. }) => "implement",
                Some(NodeKind::Review { .. }) => "review",
                Some(NodeKind::Merge) => "merge",
                None => "unknown",
            };

            match self
                .daemon
                .create_task(
                    &project,
                    &prompt,
                    &agent,
                    vec!["orchestrator".into(), kind_str.into()],
                    true,
                    worktree,
                    None,
                )
                .await
            {
                task_id if !task_id.is_empty() => {
                    if let Some(graph) = self.graphs.get_mut(graph_id) {
                        if let Some(node) = graph.nodes.get_mut(&node_id) {
                            node.daemon_task_id = Some(task_id.clone());
                            node.status = NodeStatus::Running;
                        }
                    }
                    let _ = self.event_tx.send(OrchEvent::NodeDispatched {
                        graph_id: graph_id.to_string(),
                        node_id,
                        task_id,
                        agent,
                        kind: kind_str.to_string(),
                    });
                }
                _ => {
                    if let Some(graph) = self.graphs.get_mut(graph_id) {
                        graph.fail(&node_id, "Failed to create daemon task");
                    }
                }
            }
        }
    }
}

/// Build the prompt for a task node.
fn node_prompt(node: &graph::TaskNode) -> String {
    match &node.kind {
        NodeKind::Plan => {
            unreachable!("plan nodes are dispatched separately")
        }
        NodeKind::Implement { spec } => {
            format!(
                "You are a worker agent. Implement this task:\n\n{spec}\n\n\
                 When done, commit your changes with a descriptive message."
            )
        }
        NodeKind::Review { diff_ref } => {
            format!(
                "You are a code reviewer. Review the changes referenced by {diff_ref}.\n\n\
                 Provide structured feedback: approve or request changes with specific reasons."
            )
        }
        NodeKind::Merge => {
            "Merge all worktree branches back into the base branch.".to_string()
        }
    }
}

fn graph_info(g: &TaskGraph) -> GraphInfo {
    GraphInfo {
        id: g.id.clone(),
        project: g.project.clone(),
        goal: g.goal.clone(),
        total_nodes: g.nodes.len(),
        completed_nodes: g
            .nodes
            .values()
            .filter(|n| n.status == NodeStatus::Complete)
            .count(),
        failed_nodes: g
            .nodes
            .values()
            .filter(|n| n.status == NodeStatus::Failed)
            .count(),
        running_nodes: g
            .nodes
            .values()
            .filter(|n| n.status == NodeStatus::Running)
            .count(),
    }
}

pub fn spawn_orchestrator(
    config: config::OrchestratorConfig,
    daemon: DaemonHandle,
) -> (mpsc::Sender<OrchCommand>, broadcast::Sender<OrchEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let orchestrator = Orchestrator::new(config, daemon);
    let event_tx = orchestrator.event_sender();
    tokio::spawn(async move {
        orchestrator.run(cmd_rx).await;
    });
    (cmd_tx, event_tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::Store;

    fn test_daemon() -> DaemonHandle {
        let projects = vec![crate::registry::ProjectEntry {
            name: "demo".into(),
            path: ".".into(),
            added_at: "0".into(),
        }];
        let store = Store::open_at(std::path::Path::new(":memory:")).ok();
        crate::daemon::Daemon::spawn(projects, store)
    }

    #[tokio::test]
    async fn start_plan_creates_graph() {
        let daemon = test_daemon();
        let config = config::OrchestratorConfig::default();
        let (cmd_tx, _event_tx) = spawn_orchestrator(config, daemon);

        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(OrchCommand::StartPlan {
                project: "demo".into(),
                goal: "add error handling".into(),
                reply: reply_tx,
            })
            .await
            .unwrap();

        let graph_id = reply_rx.await.unwrap();
        assert!(graph_id.starts_with("g_"), "graph id: {graph_id}");
    }

    #[tokio::test]
    async fn list_returns_active_graphs() {
        let daemon = test_daemon();
        let config = config::OrchestratorConfig::default();
        let (cmd_tx, _event_tx) = spawn_orchestrator(config, daemon);

        // Start a plan
        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(OrchCommand::StartPlan {
                project: "demo".into(),
                goal: "test".into(),
                reply: reply_tx,
            })
            .await
            .unwrap();
        let _graph_id = reply_rx.await.unwrap();

        // List
        let (list_tx, list_rx) = oneshot::channel();
        cmd_tx
            .send(OrchCommand::List(list_tx))
            .await
            .unwrap();
        let infos = list_rx.await.unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].project, "demo");
    }

    #[tokio::test]
    async fn planner_completion_dispatches_worker() {
        let daemon = test_daemon();
        // Keep the test hermetic: no real git worktrees in the repo.
        let config = config::OrchestratorConfig {
            worktrees_enabled: false,
            ..Default::default()
        };
        let (cmd_tx, event_tx) = spawn_orchestrator(config, daemon);
        let mut events = event_tx.subscribe();

        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(OrchCommand::StartPlan {
                project: "demo".into(),
                goal: "g".into(),
                reply: reply_tx,
            })
            .await
            .unwrap();
        let _graph_id = reply_rx.await.unwrap();

        // Capture the planner's daemon task id from its dispatch event.
        let planner_task = loop {
            if let OrchEvent::NodeDispatched { task_id, kind, .. } = events.recv().await.unwrap() {
                if kind == "plan" {
                    break task_id;
                }
            }
        };

        // Feed back a planner result — fenced JSON, exactly as real agents emit.
        let plan = "```json\n{\"tasks\":[{\"spec\":\"do a\",\"depends_on\":[]}],\"reviews\":[]}\n```";
        cmd_tx
            .send(OrchCommand::TaskFinished {
                task_id: planner_task,
                result: plan.into(),
                success: true,
            })
            .await
            .unwrap();

        // The feedback loop must now parse the plan and dispatch an implement node.
        let dispatched_implement = loop {
            match events.recv().await.unwrap() {
                OrchEvent::NodeDispatched { kind, .. } if kind == "implement" => break true,
                OrchEvent::AllComplete { .. } => break false,
                _ => {}
            }
        };
        assert!(
            dispatched_implement,
            "planner completion should dispatch a worker node"
        );
    }
}
