mod agent;
mod app;
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

use anyhow::Result;
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
    /// Start the TUI (default)
    Ui,
    /// Run the daemon: owns all state, serves the local WebSocket API for
    /// clients (desktop app, TUI). Publishes ~/.warpforge/daemon.json.
    Daemon {
        /// Bind a fixed local port with no auth token, so a browser (vite dev,
        /// no Tauri) can connect. For development only.
        #[arg(long)]
        dev: bool,
    },
    /// (internal) MCP server bridging an orchestrator agent to the daemon.
    /// Spawned by the daemon via an orchestrator session's mcpServers config,
    /// not meant to be run by hand.
    #[command(name = "__mcp-orchestrator", hide = true)]
    McpOrchestrator,
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
        Commands::Ui => {
            app::run().await?;
        }
        Commands::Daemon { dev } => {
            let projects = registry::list_projects().unwrap_or_default();
            let store = daemon::Store::open().ok();
            let handle = daemon::Daemon::spawn(projects, store);
            daemon::server::serve(handle, dev).await?;
        }
        Commands::McpOrchestrator => {
            mcp::run().await?;
        }
    }

    Ok(())
}
