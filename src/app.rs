use anyhow::Result;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent, KeyModifiers,
    MouseEventKind,
};
use futures::StreamExt;
use ratatui::DefaultTerminal;
use std::collections::HashMap;
use std::sync::Arc;

use crate::client::Client;
use crate::config::load_workspace_config;
use crate::registry::ProjectEntry;
use crate::tui;

/// Whether keyboard input goes to TUI navigation or directly to the active PTY.
#[derive(Debug, Clone, PartialEq)]
pub enum InputMode {
    Navigate,
    Terminal,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Screen {
    Dashboard,
    Project(String),
}

/// Focus/navigation mode for the project view.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectFocus {
    Agents,
    ServicesBrowse,
    ServiceDetail,
    PfBrowse,
    PfDetail,
}

#[derive(Debug, Clone)]
pub struct SpawnOption {
    pub name: String,
    pub command: String,
    pub description: String,
}

pub struct AppState {
    pub screen: Screen,
    pub input_mode: InputMode,
    /// Cached project list (refreshed from the daemon each frame).
    pub projects: Vec<ProjectEntry>,
    pub selected_project: usize,
    pub active_agent_tab: HashMap<String, usize>,
    pub project_focus: HashMap<String, ProjectFocus>,
    pub selected_service: HashMap<String, usize>,
    pub selected_pf: HashMap<String, usize>,
    pub log_scroll: HashMap<String, usize>,
    pub log_wrap: HashMap<String, bool>,
    pub spawn_picker: Option<Vec<SpawnOption>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            screen: Screen::Dashboard,
            input_mode: InputMode::Navigate,
            projects: Vec::new(),
            selected_project: 0,
            active_agent_tab: HashMap::new(),
            project_focus: HashMap::new(),
            selected_service: HashMap::new(),
            selected_pf: HashMap::new(),
            log_scroll: HashMap::new(),
            log_wrap: HashMap::new(),
            spawn_picker: None,
        }
    }

    pub fn active_project_name(&self) -> Option<&str> {
        if let Screen::Project(ref name) = self.screen {
            Some(name)
        } else {
            None
        }
    }

    fn project_path(&self, name: &str) -> Option<String> {
        self.projects
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.path.clone())
    }
}

pub async fn run() -> Result<()> {
    // Connect to the daemon (spawning it if needed). All process/port/PTY state
    // lives there now — the TUI is a client.
    let client = match Client::connect().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("warpforge: could not reach the daemon: {e}");
            return Ok(());
        }
    };

    let mut state = AppState::new();

    let mut terminal = ratatui::init();
    crossterm::execute!(std::io::stdout(), EnableMouseCapture).ok();
    let result = event_loop(&mut terminal, &mut state, &client).await;
    crossterm::execute!(std::io::stdout(), DisableMouseCapture).ok();
    ratatui::restore();

    // The daemon keeps running after the TUI exits — nothing to tear down here.
    result
}

async fn event_loop(
    terminal: &mut DefaultTerminal,
    state: &mut AppState,
    client: &Arc<Client>,
) -> Result<()> {
    let mut events = EventStream::new();
    let shutdown = os_shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        // Refresh the cached project list from the daemon.
        state.projects = client.state().projects.clone();

        terminal.draw(|frame| {
            let cs = client.state();
            tui::render(frame, state, &cs);
        })?;

        tokio::select! {
            maybe_event = events.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => {
                        if handle_key(key, state, client).await? {
                            return Ok(());
                        }
                    }
                    Some(Ok(Event::Mouse(mouse))) => handle_mouse(mouse, state, client),
                    Some(Ok(Event::Resize(_, _))) => {
                        let (cols, rows) = agent_pty_size();
                        let ids: Vec<String> = client.state().agents.items.iter().map(|t| t.id.clone()).collect();
                        for id in ids {
                            client.terminal_resize(&id, cols, rows);
                        }
                    }
                    _ => {}
                }
            }
            _ = client.redraw.notified() => { /* state changed — redraw */ }
            _ = &mut shutdown => { return Ok(()); }
        }
    }
}

async fn os_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let (Ok(mut term), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
        ) {
            tokio::select! {
                _ = term.recv() => {}
                _ = hup.recv() => {}
            }
            return;
        }
    }
    std::future::pending::<()>().await
}

/// Names of a project's terminals (in list order), for tab indexing.
fn terminal_ids(client: &Arc<Client>, project: &str) -> Vec<String> {
    client
        .state()
        .agents
        .list_for_project(project)
        .iter()
        .map(|t| t.id.clone())
        .collect()
}

/// Sorted service names for a project (matches the sidebar order).
fn service_names(client: &Arc<Client>, project: &str) -> Vec<String> {
    let mut names: Vec<String> = client
        .state()
        .services
        .list_for_project(project)
        .iter()
        .map(|s| s.name.clone())
        .collect();
    names.sort();
    names
}

/// Returns true if the app should quit.
async fn handle_key(key: KeyEvent, state: &mut AppState, client: &Arc<Client>) -> Result<bool> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Ok(true);
    }

    // ── Terminal mode: forward keystrokes to the focused PTY ──
    if state.input_mode == InputMode::Terminal {
        let exit_terminal = key.code == KeyCode::Esc
            || (key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b'));
        if exit_terminal {
            state.input_mode = InputMode::Navigate;
            return Ok(false);
        }
        if let Some(project) = state.active_project_name() {
            let tab = state.active_agent_tab.get(project).copied().unwrap_or(0);
            let ids = terminal_ids(client, project);
            if let Some(id) = ids.get(tab) {
                client.terminal_input(id, &key_to_bytes(key));
            }
        }
        return Ok(false);
    }

    // ── Spawn picker ──
    if state.spawn_picker.is_some() {
        match key.code {
            KeyCode::Esc => {
                state.spawn_picker = None;
            }
            KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
                let idx = (c as usize) - ('1' as usize);
                let options = state.spawn_picker.take().unwrap();
                if let (Some(opt), Some(project)) = (
                    options.get(idx),
                    state.active_project_name().map(str::to_string),
                ) {
                    spawn_terminal(client, &project, &opt.command).await;
                    state.project_focus.insert(project, ProjectFocus::Agents);
                }
            }
            _ => {}
        }
        return Ok(false);
    }

    match &state.screen {
        Screen::Dashboard => handle_dashboard_key(key, state, client).await,
        Screen::Project(_) => handle_project_key(key, state, client).await,
    }
}

async fn handle_dashboard_key(
    key: KeyEvent,
    state: &mut AppState,
    client: &Arc<Client>,
) -> Result<bool> {
    match key.code {
        KeyCode::Char('q') => return Ok(true),
        KeyCode::Up | KeyCode::Char('k') => {
            if state.selected_project > 0 {
                state.selected_project -= 1;
            }
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if state.selected_project + 1 < state.projects.len() {
                state.selected_project += 1;
            }
        }
        KeyCode::Enter => {
            if let Some(proj) = state.projects.get(state.selected_project) {
                let name = proj.name.clone();
                state.screen = Screen::Project(name.clone());
                // Ask the daemon to start declared services + port-forwards.
                client.open_project(&name);
            }
        }
        _ => {}
    }
    Ok(false)
}

async fn handle_project_key(
    key: KeyEvent,
    state: &mut AppState,
    client: &Arc<Client>,
) -> Result<bool> {
    let project = match &state.screen {
        Screen::Project(n) => n.clone(),
        _ => return Ok(false),
    };
    let focus = state
        .project_focus
        .get(&project)
        .cloned()
        .unwrap_or(ProjectFocus::Agents);

    match focus {
        ProjectFocus::ServiceDetail => {
            match key.code {
                KeyCode::Esc => {
                    state
                        .project_focus
                        .insert(project, ProjectFocus::ServicesBrowse);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    *state.log_scroll.entry(project).or_insert(0) += 1;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let off = state.log_scroll.entry(project).or_insert(0);
                    *off = off.saturating_sub(1);
                }
                KeyCode::Char('u') => {
                    if let Some(name) = selected_service_name(state, client, &project) {
                        client.start_service(&project, &name);
                    }
                }
                KeyCode::Char('x') => {
                    if let Some(name) = selected_service_name(state, client, &project) {
                        client.stop_service(&project, &name);
                    }
                }
                KeyCode::Char('r') => {
                    if let Some(name) = selected_service_name(state, client, &project) {
                        client.restart_service(&project, &name);
                    }
                }
                KeyCode::Char('w') => {
                    let wrap = state.log_wrap.entry(project).or_insert(false);
                    *wrap = !*wrap;
                }
                _ => {}
            }
            return Ok(false);
        }
        ProjectFocus::ServicesBrowse => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project, ProjectFocus::Agents);
                }
                KeyCode::Enter => {
                    state.log_scroll.remove(&project);
                    state
                        .project_focus
                        .insert(project, ProjectFocus::ServiceDetail);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    let count = client.state().services.list_for_project(&project).len();
                    if count > 0 {
                        let sel = state.selected_service.entry(project).or_insert(0);
                        if *sel > 0 {
                            *sel -= 1;
                        }
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let count = client.state().services.list_for_project(&project).len();
                    if count > 0 {
                        let sel = state.selected_service.entry(project).or_insert(0);
                        if *sel + 1 < count {
                            *sel += 1;
                        }
                    }
                }
                KeyCode::Char('R') => client.restart_all(&project),
                KeyCode::Char('X') => client.stop_all_services(&project),
                _ => {}
            }
            return Ok(false);
        }
        ProjectFocus::PfBrowse => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project, ProjectFocus::Agents);
                }
                KeyCode::Enter => {
                    state.log_scroll.remove(&project);
                    state.project_focus.insert(project, ProjectFocus::PfDetail);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    let count = client.state().portforwards.list_for_project(&project).len();
                    if count > 0 {
                        let sel = state.selected_pf.entry(project).or_insert(0);
                        if *sel > 0 {
                            *sel -= 1;
                        }
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let count = client.state().portforwards.list_for_project(&project).len();
                    if count > 0 {
                        let sel = state.selected_pf.entry(project).or_insert(0);
                        if *sel + 1 < count {
                            *sel += 1;
                        }
                    }
                }
                _ => {}
            }
            return Ok(false);
        }
        ProjectFocus::PfDetail => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project, ProjectFocus::PfBrowse);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    *state.log_scroll.entry(project).or_insert(0) += 1;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let off = state.log_scroll.entry(project).or_insert(0);
                    *off = off.saturating_sub(1);
                }
                KeyCode::Char('w') => {
                    let wrap = state.log_wrap.entry(project).or_insert(false);
                    *wrap = !*wrap;
                }
                _ => {}
            }
            return Ok(false);
        }
        ProjectFocus::Agents => {}
    }

    // Agents focus / global project keys.
    match key.code {
        KeyCode::Char('q') => return Ok(true),
        KeyCode::Esc => {
            state.screen = Screen::Dashboard;
        }
        KeyCode::Char('s') => {
            state
                .project_focus
                .insert(project, ProjectFocus::ServicesBrowse);
        }
        KeyCode::Char('p') => {
            state.project_focus.insert(project, ProjectFocus::PfBrowse);
        }
        KeyCode::Tab => {
            let count = terminal_ids(client, &project).len();
            if count > 0 {
                let tab = state.active_agent_tab.entry(project).or_insert(0);
                *tab = (*tab + 1) % count;
            }
        }
        KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
            let idx = (c as usize) - ('1' as usize);
            if idx < terminal_ids(client, &project).len() {
                state.active_agent_tab.insert(project, idx);
            }
        }
        KeyCode::Char('n') => {
            let templates = agent_templates(state, &project);
            if templates.len() <= 1 {
                let cmd = templates
                    .first()
                    .map(|t| t.command.clone())
                    .unwrap_or_else(|| "claude".into());
                spawn_terminal(client, &project, &cmd).await;
                state.project_focus.insert(project, ProjectFocus::Agents);
            } else {
                state.spawn_picker = Some(templates);
            }
        }
        KeyCode::Enter | KeyCode::Char('i') => {
            if !terminal_ids(client, &project).is_empty() {
                state.project_focus.insert(project, ProjectFocus::Agents);
                state.input_mode = InputMode::Terminal;
            }
        }
        KeyCode::Char('x') => {
            let tab = state.active_agent_tab.get(&project).copied().unwrap_or(0);
            let ids = terminal_ids(client, &project);
            if let Some(id) = ids.get(tab) {
                client.terminal_kill(id);
                let tab = state.active_agent_tab.entry(project).or_insert(0);
                if *tab > 0 {
                    *tab -= 1;
                }
            }
        }
        _ => {}
    }
    Ok(false)
}

fn handle_mouse(mouse: crossterm::event::MouseEvent, state: &mut AppState, client: &Arc<Client>) {
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let up = matches!(mouse.kind, MouseEventKind::ScrollUp);
            if state.input_mode == InputMode::Terminal {
                if let Some(project) = state.active_project_name() {
                    let tab = state.active_agent_tab.get(project).copied().unwrap_or(0);
                    let ids = terminal_ids(client, project);
                    if let Some(id) = ids.get(tab) {
                        let bytes: &[u8] = if up {
                            b"\x1b[A\x1b[A\x1b[A"
                        } else {
                            b"\x1b[B\x1b[B\x1b[B"
                        };
                        client.terminal_input(id, bytes);
                    }
                }
                return;
            }
            if let Some(project) = state.active_project_name().map(str::to_string) {
                let focus = state
                    .project_focus
                    .get(&project)
                    .cloned()
                    .unwrap_or(ProjectFocus::Agents);
                if matches!(focus, ProjectFocus::ServiceDetail | ProjectFocus::PfDetail) {
                    let off = state.log_scroll.entry(project).or_insert(0);
                    if up {
                        *off += 3;
                    } else {
                        *off = off.saturating_sub(3);
                    }
                }
            }
        }
        _ => {}
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn selected_service_name(state: &AppState, client: &Arc<Client>, project: &str) -> Option<String> {
    let names = service_names(client, project);
    let sel = state.selected_service.get(project).copied().unwrap_or(0);
    names.get(sel).cloned()
}

fn agent_templates(state: &AppState, project: &str) -> Vec<SpawnOption> {
    let Some(path) = state.project_path(project) else {
        return Vec::new();
    };
    load_workspace_config(std::path::Path::new(&path))
        .and_then(|c| c.agent_templates)
        .map(|tmpl| {
            let mut opts: Vec<SpawnOption> = tmpl
                .into_iter()
                .map(|(name, t)| SpawnOption {
                    name,
                    command: t.command,
                    description: t.description.unwrap_or_default(),
                })
                .collect();
            opts.sort_by(|a, b| a.name.cmp(&b.name));
            opts
        })
        .unwrap_or_default()
}

async fn spawn_terminal(client: &Arc<Client>, project: &str, command: &str) {
    if let Some(id) = client.spawn_terminal(project, command).await {
        let (cols, rows) = agent_pty_size();
        client.terminal_resize(&id, cols, rows);
    }
}

fn agent_pty_size() -> (u16, u16) {
    let (term_cols, term_rows) = crossterm::terminal::size().unwrap_or((220, 50));
    let cols = term_cols.saturating_sub(32).max(40);
    let rows = term_rows.saturating_sub(8).max(10);
    (cols, rows)
}

fn key_to_bytes(key: KeyEvent) -> Vec<u8> {
    match key.code {
        KeyCode::Char(c) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                let byte = (c as u8).to_ascii_uppercase().wrapping_sub(b'@');
                vec![byte]
            } else {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf).as_bytes().to_vec()
            }
        }
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Delete => vec![0x1b, b'[', b'3', b'~'],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::BackTab => vec![0x1b, b'[', b'Z'],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => vec![0x1b, b'[', b'A'],
        KeyCode::Down => vec![0x1b, b'[', b'B'],
        KeyCode::Right => vec![0x1b, b'[', b'C'],
        KeyCode::Left => vec![0x1b, b'[', b'D'],
        KeyCode::Home => vec![0x1b, b'[', b'H'],
        KeyCode::End => vec![0x1b, b'[', b'F'],
        KeyCode::PageUp => vec![0x1b, b'[', b'5', b'~'],
        KeyCode::PageDown => vec![0x1b, b'[', b'6', b'~'],
        KeyCode::F(n) => f_key(n),
        _ => vec![],
    }
}

fn f_key(n: u8) -> Vec<u8> {
    match n {
        1 => vec![0x1b, b'O', b'P'],
        2 => vec![0x1b, b'O', b'Q'],
        3 => vec![0x1b, b'O', b'R'],
        4 => vec![0x1b, b'O', b'S'],
        5 => vec![0x1b, b'[', b'1', b'5', b'~'],
        6 => vec![0x1b, b'[', b'1', b'7', b'~'],
        7 => vec![0x1b, b'[', b'1', b'8', b'~'],
        8 => vec![0x1b, b'[', b'1', b'9', b'~'],
        9 => vec![0x1b, b'[', b'2', b'0', b'~'],
        10 => vec![0x1b, b'[', b'2', b'1', b'~'],
        11 => vec![0x1b, b'[', b'2', b'3', b'~'],
        12 => vec![0x1b, b'[', b'2', b'4', b'~'],
        _ => vec![],
    }
}
