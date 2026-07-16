use std::collections::HashMap;
use uuid::Uuid;

/// A directed acyclic graph of orchestration steps.
#[derive(Debug, Clone)]
pub struct TaskGraph {
    pub id: String,
    pub project: String,
    pub goal: String,
    pub nodes: HashMap<String, TaskNode>,
    pub root_id: String,
    /// The daemon task that owns this orchestration on the board. All child
    /// tasks created by the graph carry `parent_task_id` pointing here.
    pub parent_task_id: String,
}

#[derive(Debug, Clone)]
pub struct TaskNode {
    pub id: String,
    pub kind: NodeKind,
    pub agent: String,
    pub status: NodeStatus,
    /// IDs of nodes that must complete before this one starts.
    pub depends_on: Vec<String>,
    /// Associated worktree path (if worktree is enabled).
    pub worktree: Option<String>,
    /// Task ID in the daemon (set when dispatched).
    pub daemon_task_id: Option<String>,
    /// Node result text from the agent.
    pub result: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    /// The planner node: decomposes goal into subtasks.
    Plan,
    /// A worker node: implement a specific piece.
    Implement { spec: String },
    /// A reviewer node: review a specific diff.
    Review { diff_ref: String },
    /// Merge node: merge all worktree branches.
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Skipped,
}

impl TaskGraph {
    /// Create a new graph with a root Plan node.
    pub fn new(project: &str, goal: &str, planner_agent: &str, parent_task_id: String) -> Self {
        let id = format!("g_{}", &Uuid::new_v4().to_string()[..8]);
        let root_id = format!("{id}_plan");
        let root = TaskNode {
            id: root_id.clone(),
            kind: NodeKind::Plan,
            agent: planner_agent.to_string(),
            status: NodeStatus::Pending,
            depends_on: vec![],
            worktree: None,
            daemon_task_id: None,
            result: None,
        };
        let mut nodes = HashMap::new();
        nodes.insert(root_id.clone(), root);

        Self {
            id,
            project: project.to_string(),
            goal: goal.to_string(),
            nodes,
            root_id,
            parent_task_id,
        }
    }

    /// Add a node that depends on `depends_on` IDs.
    pub fn add_node(&mut self, kind: NodeKind, agent: &str, depends_on: Vec<String>) -> String {
        let id = format!("{}_{}", self.id, &Uuid::new_v4().to_string()[..6]);
        let node = TaskNode {
            id: id.clone(),
            kind,
            agent: agent.to_string(),
            status: NodeStatus::Pending,
            depends_on,
            worktree: None,
            daemon_task_id: None,
            result: None,
        };
        self.nodes.insert(id.clone(), node);
        id
    }

    /// Get all nodes that are Pending and whose dependencies are all Complete.
    pub fn ready_nodes(&self) -> Vec<&TaskNode> {
        self.nodes
            .values()
            .filter(|n| {
                n.status == NodeStatus::Pending
                    && n.depends_on.iter().all(|dep_id| {
                        self.nodes
                            .get(dep_id)
                            .is_some_and(|dep| dep.status == NodeStatus::Complete)
                    })
            })
            .collect()
    }

    /// Mark a node as Complete and store its result.
    pub fn complete(&mut self, id: &str, result: Option<String>) {
        if let Some(node) = self.nodes.get_mut(id) {
            node.status = NodeStatus::Complete;
            node.result = result;
        }
    }

    /// Mark a node as Failed.
    pub fn fail(&mut self, id: &str, reason: &str) {
        if let Some(node) = self.nodes.get_mut(id) {
            node.status = NodeStatus::Failed;
            node.result = Some(reason.to_string());
        }
    }

    /// Check if all nodes are in a terminal state (Complete, Failed, or Skipped).
    pub fn all_done(&self) -> bool {
        self.nodes.values().all(|n| {
            matches!(
                n.status,
                NodeStatus::Complete | NodeStatus::Failed | NodeStatus::Skipped
            )
        })
    }

    /// Check if all nodes completed successfully.
    pub fn all_complete(&self) -> bool {
        self.nodes
            .values()
            .all(|n| n.status == NodeStatus::Complete)
    }

    /// Get a topological ordering of nodes (for display / debugging).
    pub fn topo_order(&self) -> Vec<&TaskNode> {
        let mut visited = std::collections::HashSet::new();
        let mut order = Vec::new();
        // Visit from root first, then any unvisited nodes
        self.topo_visit(&self.root_id, &mut visited, &mut order);
        for id in self.nodes.keys() {
            self.topo_visit(id, &mut visited, &mut order);
        }
        order
    }

    fn topo_visit<'a>(
        &'a self,
        id: &str,
        visited: &mut std::collections::HashSet<String>,
        order: &mut Vec<&'a TaskNode>,
    ) {
        if !visited.insert(id.to_string()) {
            return;
        }
        if let Some(node) = self.nodes.get(id) {
            for dep in &node.depends_on {
                self.topo_visit(dep, visited, order);
            }
            order.push(node);
        }
    }

    /// Parse planner output into implement/review nodes.
    /// Expects JSON like: {"tasks": [{"spec": "...", "depends_on": []}], "reviews": [...]}
    pub fn parse_plan_output(
        &mut self,
        output: &str,
        config: &crate::orchestration::config::OrchestratorConfig,
    ) {
        // Agents wrap JSON in ```json fences or surrounding prose; pull the
        // object out before parsing.
        let json = extract_json_object(output);
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(tasks) = val.get("tasks").and_then(|t| t.as_array()) {
                let mut node_ids = Vec::new();
                for task in tasks {
                    let spec = task
                        .get("spec")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown task");
                    let deps: Vec<String> = task
                        .get("depends_on")
                        .and_then(|d| d.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();

                    // Resolve dependency IDs from indices or names
                    let resolved_deps: Vec<String> = deps
                        .iter()
                        .filter_map(|d| {
                            if d.starts_with('g') {
                                Some(d.clone())
                            } else if let Ok(idx) = d.parse::<usize>() {
                                node_ids.get(idx).cloned()
                            } else {
                                None
                            }
                        })
                        .collect();

                    let worker = pick_worker(config);
                    let id = self.add_node(
                        NodeKind::Implement {
                            spec: spec.to_string(),
                        },
                        &worker,
                        resolved_deps,
                    );
                    node_ids.push(id);
                }

                // Add review nodes
                if let Some(reviews) = val.get("reviews").and_then(|r| r.as_array()) {
                    for review in reviews {
                        let diff_ref = review
                            .get("diff_ref")
                            .and_then(|s| s.as_str())
                            .unwrap_or("latest");
                        let target_idx = review
                            .get("target")
                            .and_then(|t| t.as_str())
                            .and_then(|t| t.parse::<usize>().ok())
                            .unwrap_or(0);

                        let target_id = node_ids
                            .get(target_idx)
                            .cloned()
                            .unwrap_or_else(|| self.root_id.clone());

                        let reviewer = pick_reviewer(config);
                        self.add_node(
                            NodeKind::Review {
                                diff_ref: diff_ref.to_string(),
                            },
                            &reviewer,
                            vec![target_id],
                        );
                    }
                }
            }
        }
    }
}

/// Extract a JSON object from an agent's reply. Handles ```json fenced blocks
/// and prose around the object; falls back to the trimmed input.
fn extract_json_object(output: &str) -> String {
    let trimmed = output.trim();
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        // Drop an optional language tag ("json") right after the fence.
        let body = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = body.find("```") {
            return body[..end].trim().to_string();
        }
    }
    if let (Some(s), Some(e)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if e >= s {
            return trimmed[s..=e].to_string();
        }
    }
    trimmed.to_string()
}

/// Pick a worker agent from the pool (planner decides how many to spawn).
fn pick_worker(config: &crate::orchestration::config::OrchestratorConfig) -> String {
    config
        .worker_pool
        .first()
        .map(|w| w.agent.clone())
        .unwrap_or_else(|| "claude".into())
}

fn pick_reviewer(config: &crate::orchestration::config::OrchestratorConfig) -> String {
    config
        .reviewer_pool
        .first()
        .map(|r| r.agent.clone())
        .unwrap_or_else(|| "opencode".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_graph_all_done() {
        let graph = TaskGraph::new("demo", "fix bug", "claude", "t_parent".into());
        // Root is Pending, not Complete — all_done should be false
        assert!(!graph.all_done());
        // But ready_nodes should return the root (no deps)
        assert_eq!(graph.ready_nodes().len(), 1);
    }

    #[test]
    fn parse_plan_strips_markdown_fences() {
        let mut graph = TaskGraph::new("demo", "goal", "claude", "t_parent".into());
        let config = crate::orchestration::config::OrchestratorConfig::default();
        let fenced = "Here's the plan:\n\n```json\n{\"tasks\":[{\"spec\":\"do a\",\
            \"depends_on\":[]}],\"reviews\":[{\"diff_ref\":\"HEAD\",\"target\":\"0\"}]}\n```\ndone";
        graph.parse_plan_output(fenced, &config);
        // root plan + 1 implement + 1 review
        assert_eq!(graph.nodes.len(), 3);
    }

    #[test]
    fn extract_json_handles_prose_and_fences() {
        assert_eq!(extract_json_object("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json_object("text {\"a\":1} tail"), "{\"a\":1}");
        assert_eq!(extract_json_object("  {\"a\":1}  "), "{\"a\":1}");
    }

    #[test]
    fn add_node_and_ready() {
        let mut graph = TaskGraph::new("demo", "fix bug", "claude", "t_parent".into());
        let root = graph.root_id.clone();

        // Complete root
        graph.complete(&root, None);

        // Add child
        let child = graph.add_node(
            NodeKind::Implement {
                spec: "add tests".into(),
            },
            "codex",
            vec![root],
        );

        // Child should now be ready
        let ready = graph.ready_nodes();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, child);

        // Complete child
        graph.complete(&child, None);
        assert!(graph.all_complete());
    }

    #[test]
    fn topo_order_respects_deps() {
        let mut graph = TaskGraph::new("demo", "test", "claude", "t_parent".into());

        let a = graph.add_node(NodeKind::Implement { spec: "a".into() }, "claude", vec![]);
        let b = graph.add_node(
            NodeKind::Implement { spec: "b".into() },
            "codex",
            vec![a.clone()],
        );

        let order: Vec<String> = graph.topo_order().iter().map(|n| n.id.clone()).collect();

        // Root is first, then a, then b (b depends on a)
        let a_pos = order.iter().position(|x| x == &a).unwrap();
        let b_pos = order.iter().position(|x| x == &b).unwrap();
        assert!(a_pos < b_pos, "a must come before b");
    }

    #[test]
    fn parse_simple_plan() {
        let mut graph = TaskGraph::new("demo", "build feature", "claude", "t_parent".into());
        let config = crate::orchestration::config::OrchestratorConfig::default();

        let plan = r#"{
            "tasks": [
                {"spec": "implement feature", "depends_on": []},
                {"spec": "add tests", "depends_on": ["0"]}
            ],
            "reviews": [
                {"diff_ref": "HEAD", "target": "0"}
            ]
        }"#;

        graph.parse_plan_output(plan, &config);

        // Root + 2 implement nodes + 1 review node = 4
        assert_eq!(graph.nodes.len(), 4);
    }
}
