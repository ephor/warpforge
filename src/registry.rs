use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "addedAt")]
    pub added_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ProjectsData {
    projects: Vec<ProjectEntry>,
}

fn warpforge_dir() -> PathBuf {
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
    let text = fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).context("parsing projects.json")
}

fn save(data: &ProjectsData) -> Result<()> {
    let dir = warpforge_dir();
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(data)? + "\n";
    fs::write(projects_file(), text)?;
    Ok(())
}

pub fn add_project(path: &str, name: Option<&str>) -> Result<ProjectEntry> {
    let abs = Path::new(path)
        .canonicalize()
        .with_context(|| format!("path does not exist: {path}"))?;

    let abs_str = abs.to_string_lossy().to_string();
    let project_name = name
        .map(|s| s.to_string())
        .unwrap_or_else(|| abs.file_name().unwrap_or_default().to_string_lossy().to_string());

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
    };
    data.projects.push(entry.clone());
    save(&data)?;
    Ok(entry)
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
