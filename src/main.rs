mod app;
mod config;
mod portforward;
mod ports;
mod registry;
mod agent;
mod service;
mod tui;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "warpforge", about = "Workspace orchestrator with embedded agent terminals")]
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
    /// Generate .workspace.yaml in the current (or given) directory
    Init {
        /// Directory to init (defaults to current directory)
        path: Option<String>,
    },
    /// Start the TUI (default)
    Ui,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Ui) {
        Commands::Add { path, name } => {
            let entry = registry::add_project(&path, name.as_deref())?;
            println!("Registered \"{}\" at {}", entry.name, entry.path);
            let workspace_yaml = std::path::Path::new(&entry.path).join(".workspace.yaml");
            if !workspace_yaml.exists() {
                match config::generate_workspace_yaml(std::path::Path::new(&entry.path)) {
                    Ok(_) => println!("Created .workspace.yaml — edit it to configure services"),
                    Err(e) => println!("Note: could not create .workspace.yaml: {}", e),
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
        Commands::Init { path } => {
            let dir = path.unwrap_or_else(|| ".".to_string());
            config::generate_workspace_yaml(std::path::Path::new(&dir))?;
        }
        Commands::Ui => {
            app::run().await?;
        }
    }

    Ok(())
}
