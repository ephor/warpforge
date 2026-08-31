use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// A project's committed port range: `size` ports starting at `start`,
/// inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PortRange {
    pub start: u16,
    pub size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "addedAt")]
    pub added_at: String,
    /// Sticky auto-assigned range; absent for old projects.json files.
    #[serde(rename = "portRange", default, skip_serializing_if = "Option::is_none")]
    pub port_range: Option<PortRange>,
    /// Local override; beats any declared config range.
    #[serde(
        rename = "portRangeOverride",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub port_range_override: Option<PortRange>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ProjectsData {
    projects: Vec<ProjectEntry>,
}

fn warpforge_dir() -> PathBuf {
    // Test seam: lets the suite point the registry at a throwaway directory.
    if let Ok(dir) = std::env::var("WARPFORGE_HOME") {
        return PathBuf::from(dir);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".warpforge")
}

fn projects_file() -> PathBuf {
    warpforge_dir().join("projects.json")
}

fn load() -> Result<ProjectsData> {
    let path = projects_file();
    if !path.exists() {
        return Ok(ProjectsData::default());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).context("parsing projects.json")
}

fn save(data: &ProjectsData) -> Result<()> {
    let dir = warpforge_dir();
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(data)? + "\n";
    fs::write(projects_file(), text)?;
    Ok(())
}

pub fn add_project(
    path: &str,
    name: Option<&str>,
    port_range: Option<PortRange>,
) -> Result<ProjectEntry> {
    let abs = Path::new(path)
        .canonicalize()
        .with_context(|| format!("path does not exist: {path}"))?;

    let abs_str = abs.to_string_lossy().to_string();
    let project_name = name.map(|s| s.to_string()).unwrap_or_else(|| {
        abs.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let mut data = load()?;

    if data.projects.iter().any(|p| p.name == project_name) {
        bail!("Project \"{}\" already registered", project_name);
    }
    if data.projects.iter().any(|p| p.path == abs_str) {
        bail!("Path already registered as another project");
    }

    let entry = ProjectEntry {
        name: project_name,
        path: abs_str,
        added_at: chrono_now(),
        port_range,
        port_range_override: None,
    };
    data.projects.push(entry.clone());
    save(&data)?;
    Ok(entry)
}

/// Set (or clear) a project's sticky auto-assigned port range.
pub fn set_port_range(name: &str, range: Option<PortRange>) -> Result<()> {
    mutate_project(name, move |entry| entry.port_range = range)
}

/// Set (or clear) a project's local port-range override.
pub fn set_port_range_override(name: &str, range: Option<PortRange>) -> Result<()> {
    mutate_project(name, move |entry| entry.port_range_override = range)
}

fn mutate_project(name: &str, f: impl FnOnce(&mut ProjectEntry)) -> Result<()> {
    let mut data = load()?;
    let entry = match data.projects.iter_mut().find(|p| p.name == name) {
        Some(entry) => entry,
        None => bail!("Project \"{}\" not found", name),
    };
    f(entry);
    save(&data)
}

pub fn remove_project(name: &str) -> Result<()> {
    let mut data = load()?;
    let before = data.projects.len();
    data.projects.retain(|p| p.name != name);
    if data.projects.len() == before {
        bail!("Project \"{}\" not found", name);
    }
    save(&data)
}

pub fn list_projects() -> Result<Vec<ProjectEntry>> {
    Ok(load()?.projects)
}

#[allow(dead_code)]
pub fn get_project(name: &str) -> Result<Option<ProjectEntry>> {
    Ok(load()?.projects.into_iter().find(|p| p.name == name))
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
