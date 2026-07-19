mod agent;
mod app;
mod bootstrap;
mod client;
mod config;
mod daemon;
mod mcp;
#[allow(dead_code)]
mod orchestration;
#[allow(dead_code)]
mod policies;
mod portforward;
mod ports;
mod registry;
mod service;
mod tui;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "warpforge",
    about = "Workspace orchestrator with embedded agent terminals"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Register a project directory
    Add {
        path: String,
        #[arg(short, long)]
        name: Option<String>,
    },
    /// Remove a registered project
    Remove { name: String },
    /// List registered projects
    List,
    /// Generate .warpforge.yaml in the current (or given) directory
    Init {
        /// Directory to init (defaults to current directory)
        path: Option<String>,
        /// Also register the project
        #[arg(short, long)]
        add: bool,
    },
    /// Interactively generate a .warpforge.yaml with an agent. Registers the
    /// project if needed, asks the daemon to run a bootstrap task, then lets you
    /// accept / edit / discard the proposed config.
    Bootstrap {
        /// Project directory to bootstrap
        path: String,
    },
    /// Start the TUI (default)
    Ui,
    /// Run the daemon: owns all state, serves the local WebSocket API for
    /// clients (desktop app, TUI). Publishes ~/.warpforge/daemon.json.
    Daemon {
        /// Bind a fixed local port with no auth token, so a browser (vite dev,
        /// no Tauri) can connect. For development only.
        #[arg(long)]
        dev: bool,
        /// Marks a daemon bundled and launched by the desktop application.
        /// Only such a daemon accepts an in-app update handoff.
        #[arg(long, value_enum, default_value_t = DaemonOwnerArg::External)]
        owner: DaemonOwnerArg,
    },
    /// (internal) MCP server bridging an orchestrator agent to the daemon.
    /// Spawned by the daemon via an orchestrator session's mcpServers config,
    /// not meant to be run by hand.
    #[command(name = "__mcp-orchestrator", hide = true)]
    McpOrchestrator,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum DaemonOwnerArg {
    Desktop,
    External,
}

impl From<DaemonOwnerArg> for warpforge_protocol::DaemonOwner {
    fn from(value: DaemonOwnerArg) -> Self {
        match value {
            DaemonOwnerArg::Desktop => Self::Desktop,
            DaemonOwnerArg::External => Self::External,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Ui) {
        Commands::Add { path, name } => {
            let entry = registry::add_project(&path, name.as_deref())?;
            println!("Registered \"{}\" at {}", entry.name, entry.path);
            let config_file = config::find_config_file(std::path::Path::new(&entry.path));
            if !config_file.exists() {
                match config::generate_workspace_yaml(std::path::Path::new(&entry.path)) {
                    Ok(_) => println!("Created .warpforge.yaml — edit it to configure services"),
                    Err(e) => println!("Note: could not create .warpforge.yaml: {}", e),
                }
            }
        }
        Commands::Remove { name } => {
            registry::remove_project(&name)?;
            println!("Removed project \"{}\"", name);
        }
        Commands::List => {
            let projects = registry::list_projects()?;
            if projects.is_empty() {
                println!("No projects registered. Use `warpforge add <path>` to add one.");
            } else {
                for (i, p) in projects.iter().enumerate() {
                    let (start, end) = ports::port_range(i);
                    println!("  {} → {}  (ports {}-{})", p.name, p.path, start, end);
                }
            }
        }
        Commands::Init { path, add } => {
            let dir = path.unwrap_or_else(|| ".".to_string());
            config::generate_workspace_yaml(std::path::Path::new(&dir))?;
            if add {
                let entry = registry::add_project(&dir, None)?;
                println!("Registered \"{}\" at {}", entry.name, entry.path);
            }
        }
        Commands::Bootstrap { path } => {
            run_bootstrap(&path).await?;
        }
        Commands::Ui => {
            app::run().await?;
        }
        Commands::Daemon { dev, owner } => {
            let projects = registry::list_projects().unwrap_or_default();
            let store = daemon::Store::open().ok();
            let handle = daemon::Daemon::spawn(projects, store);
            daemon::server::serve(handle, dev, owner.into()).await?;
        }
        Commands::McpOrchestrator => {
            mcp::run().await?;
        }
    }

    Ok(())
}

/// Interactive CLI bootstrap: register the project, ask a few runtime
/// questions, run a config-gen task on the daemon, then review + write the
/// proposed `.warpforge.yaml`. The daemon owns the repo scan, prompt building,
/// and validation (see `bootstrap.*` RPCs); this only drives the flow.
async fn run_bootstrap(path: &str) -> Result<()> {
    use std::io::{self, Write};
    use std::time::Duration;
    use warpforge_protocol::TaskStatus;

    let ask = |question: &str, default: &str| -> String {
        if default.is_empty() {
            print!("{question}: ");
        } else {
            print!("{question} [{default}]: ");
        }
        let _ = io::stdout().flush();
        let mut line = String::new();
        io::stdin().read_line(&mut line).ok();
        let line = line.trim();
        if line.is_empty() {
            default.to_string()
        } else {
            line.to_string()
        }
    };

    let client = client::Client::connect().await?;
    let name = client
        .add_project(path, None)
        .await
        .ok_or_else(|| anyhow!("could not register project at {path}"))?;
    println!("Registered project \"{name}\".\n");

    let agent = ask("Agent (claude/codex/opencode/qwen/goose)", "claude");
    let runtime_kind = ask("Runtime (local/docker-compose/kubernetes/mixed)", "local");
    let dev_commands = ask("Dev commands (comma-separated)", "");
    let notes = ask("Notes", "");

    let answers = serde_json::json!({
        "agent": agent,
        "runtimeKind": runtime_kind,
        "devCommands": dev_commands,
        "notes": notes,
    });

    println!("\nAsking {agent} to propose a config… (this can take a minute)");
    let task_id = client
        .bootstrap_start(&name, answers)
        .await
        .ok_or_else(|| anyhow!("daemon did not create a bootstrap task"))?;

    // Wait for the agent to finish its turn, accumulating its text.
    let mut waited = Duration::ZERO;
    let limit = Duration::from_secs(300);
    loop {
        let done = {
            let state = client.state();
            state
                .tasks
                .iter()
                .find(|t| t.id == task_id)
                .map(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Idle
                            | TaskStatus::Done
                            | TaskStatus::NeedsReview
                            | TaskStatus::Blocked
                            | TaskStatus::Interrupted
                    )
                })
                .unwrap_or(false)
        };
        let has_text = client
            .state()
            .bootstrap_results
            .get(&task_id)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if done && has_text {
            break;
        }
        if waited >= limit {
            client.cancel_task(&task_id);
            return Err(anyhow!("timed out waiting for the agent to respond"));
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), client.redraw.notified()).await;
        waited += Duration::from_secs(2);
    }

    let response = client
        .state()
        .bootstrap_results
        .get(&task_id)
        .cloned()
        .unwrap_or_default();
    let yaml = bootstrap::extract_yaml_from_response(&response);

    println!("\n── Proposed .warpforge.yaml ──\n{yaml}\n──────────────────────────────");
    match bootstrap::validate_config_yaml(&yaml) {
        Ok((_, issues)) => {
            for issue in &issues {
                let tag = match issue.severity {
                    bootstrap::IssueSeverity::Error => "error",
                    bootstrap::IssueSeverity::Warning => "warning",
                };
                println!("  {tag}: {}", issue.message);
            }
        }
        Err(e) => println!("  error: {e}"),
    }

    if ask("\nWrite this config? (y/N)", "N")
        .to_lowercase()
        .starts_with('y')
    {
        let target = config::find_config_file(std::path::Path::new(path));
        std::fs::write(&target, &yaml).with_context(|| format!("writing {}", target.display()))?;
        println!("Wrote {}", target.display());
    } else {
        println!("Discarded.");
    }

    Ok(())
}
