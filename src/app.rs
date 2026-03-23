use anyhow::Result;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent,
    KeyModifiers, MouseEventKind,
};
use futures::StreamExt;
use ratatui::DefaultTerminal;
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::agent::{AgentEvent, AgentManager};
use crate::config::{load_workspace_config, sorted_services};
use crate::portforward::{PfEvent, PortForwardManager};
use crate::registry::{list_projects, ProjectEntry};
use crate::service::{ServiceEvent, ServiceManager};
use crate::tui;

/// Whether keyboard input goes to TUI navigation or directly to the active PTY
#[derive(Debug, Clone, PartialEq)]
pub enum InputMode {
    /// Normal TUI navigation
    Navigate,
    /// All keystrokes forwarded to the focused agent PTY
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
    /// Default. Right pane = agent terminal. Tab/1-9 = switch agents.
    Agents,
    /// [s] Browse services. Right pane = live log tail. j/k = navigate. Enter → ServiceDetail.
    ServicesBrowse,
    /// Service focused. Right pane = scrollable logs. r/u/x actions. Esc → ServicesBrowse.
    ServiceDetail,
    /// [p] Browse port-forwards. Right pane = live log tail. j/k = navigate. Enter → PfDetail.
    PfBrowse,
    /// Port-forward focused. Right pane = scrollable kubectl logs. Esc → PfBrowse.
    PfDetail,
}

/// A template option shown in the spawn picker popup
#[derive(Debug, Clone)]
pub struct SpawnOption {
    pub name: String,
    pub command: String,
    pub description: String,
}

pub struct AppState {
    pub screen: Screen,
    pub input_mode: InputMode,
    pub projects: Vec<ProjectEntry>,
    pub selected_project: usize,
    /// Active agent tab per project
    pub active_agent_tab: HashMap<String, usize>,
    /// Focus level per project
    pub project_focus: HashMap<String, ProjectFocus>,
    /// Selected service index per project
    pub selected_service: HashMap<String, usize>,
    /// Selected port-forward index per project
    pub selected_pf: HashMap<String, usize>,
    /// Scroll offset for detail log panes
    pub log_scroll: HashMap<String, usize>,
    /// Word-wrap toggle for log detail panes (per project)
    pub log_wrap: HashMap<String, bool>,
    /// When Some — spawn picker popup is open with these options
    pub spawn_picker: Option<Vec<SpawnOption>>,
}

impl AppState {
    fn new(projects: Vec<ProjectEntry>) -> Self {
        Self {
            screen: Screen::Dashboard,
            input_mode: InputMode::Navigate,
            projects,
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
}

pub async fn run() -> Result<()> {
    let projects = list_projects().unwrap_or_default();

    let (agent_tx, mut agent_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let (service_tx, mut service_rx) = mpsc::unbounded_channel::<ServiceEvent>();

    let (pf_tx, mut pf_rx) = mpsc::unbounded_channel::<PfEvent>();
    let mut agents = AgentManager::new(agent_tx);
    let mut services = ServiceManager::new(service_tx);
    let mut state = AppState::new(projects);
    let mut portforwards = PortForwardManager::new(pf_tx);

    let mut terminal = ratatui::init();
    crossterm::execute!(std::io::stdout(), EnableMouseCapture).ok();
    let result = event_loop(
        &mut terminal,
        &mut state,
        &mut agents,
        &mut services,
        &mut portforwards,
        &mut agent_rx,
        &mut service_rx,
        &mut pf_rx,
    )
    .await;
    crossterm::execute!(std::io::stdout(), DisableMouseCapture).ok();
    ratatui::restore();

    // Cleanup: stop ALL projects and port-forwards regardless of which screen was active
    services.stop_all().await.ok();
    portforwards.stop_all().await.ok();
    agents.kill_all();

    // Background spawn_blocking tasks (PTY readers) cannot be cancelled — force exit
    // so we don't hang waiting for blocking reads that will never complete.
    std::process::exit(0);
}

async fn event_loop(
    terminal: &mut DefaultTerminal,
    state: &mut AppState,
    agents: &mut AgentManager,
    services: &mut ServiceManager,
    portforwards: &mut PortForwardManager,
    agent_rx: &mut mpsc::UnboundedReceiver<AgentEvent>,
    service_rx: &mut mpsc::UnboundedReceiver<ServiceEvent>,
    pf_rx: &mut mpsc::UnboundedReceiver<PfEvent>,
) -> Result<()> {
    let mut events = EventStream::new();
    let shutdown = os_shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        // Render current frame
        terminal.draw(|frame| tui::render(frame, state, agents, services, portforwards))?;

        // Wait for the next event from any source
        tokio::select! {
            // Terminal keyboard/resize events
            maybe_event = events.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => {
                        if handle_key(key, state, agents, services, portforwards).await? {
                            return Ok(());
                        }
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        handle_mouse(mouse, state, agents);
                    }
                    Some(Ok(Event::Resize(_, _))) => {
                        // Resize all active agent PTYs to match new terminal dimensions
                        let (cols, rows) = agent_pty_size();
                        for id in agents.all_ids() {
                            agents.resize(&id, cols, rows);
                        }
                    }
                    _ => {}
                }
            }

            // PTY output — update status + trigger redraw
            Some(event) = agent_rx.recv() => {
                match event {
                    AgentEvent::Data { id, needs_review } => {
                        if let Some(agent) = agents.get_mut(&id) {
                            if needs_review && agent.status == crate::agent::AgentStatus::Running {
                                agent.status = crate::agent::AgentStatus::NeedsReview;
                            } else if !needs_review && agent.status == crate::agent::AgentStatus::NeedsReview {
                                agent.status = crate::agent::AgentStatus::Running;
                            }
                        }
                    }
                    AgentEvent::Exit { id, .. } => {
                        if let Some(agent) = agents.get_mut(&id) {
                            agent.status = crate::agent::AgentStatus::Completed;
                        }
                    }
                }
            }

            // Service log/status events
            Some(event) = service_rx.recv() => {
                services.apply_event(event);
            }

            // Port-forward watcher events (restart / failure notifications)
            Some(event) = pf_rx.recv() => {
                if let Some(project_name) = state.active_project_name() {
                    portforwards.apply_event(project_name, event);
                }
            }

            // Graceful shutdown on SIGTERM (kill <pid>) or SIGHUP (terminal closed)
            _ = &mut shutdown => { return Ok(()); }
        }
    }
}

/// Resolves on SIGTERM or SIGHUP (unix), or never on other platforms.
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

/// Returns true if the app should quit.
async fn handle_key(
    key: KeyEvent,
    state: &mut AppState,
    agents: &mut AgentManager,
    services: &mut ServiceManager,
    portforwards: &mut PortForwardManager,
) -> Result<bool> {
    // Global quit: Ctrl+C always exits regardless of mode
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Ok(true);
    }

    // ── TERMINAL MODE ──────────────────────────────────────────────────────────
    // Esc or Ctrl+B exits terminal mode back to navigate
    if state.input_mode == InputMode::Terminal {
        let exit_terminal = key.code == KeyCode::Esc
            || (key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b'));
        if exit_terminal {
            state.input_mode = InputMode::Navigate;
            return Ok(false);
        }

        // Forward everything else directly to the active agent PTY
        if let Some(project_name) = state.active_project_name() {
            let tab = state.active_agent_tab.get(project_name).copied().unwrap_or(0);
            let agent_ids: Vec<String> = agents
                .list_for_project(project_name)
                .into_iter()
                .map(|a| a.id.clone())
                .collect();
            if let Some(id) = agent_ids.get(tab) {
                let bytes = key_to_bytes(key);
                agents.write(id, bytes);
            }
        }
        return Ok(false);
    }

    // ── SPAWN PICKER ──────────────────────────────────────────────────────────
    if state.spawn_picker.is_some() {
        match key.code {
            KeyCode::Esc => {
                state.spawn_picker = None;
            }
            KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
                let idx = (c as usize) - ('1' as usize);
                let options = state.spawn_picker.take().unwrap();
                if let Some(opt) = options.get(idx) {
                    if let Some(project_name) = state.active_project_name().map(|s| s.to_string()) {
                        if let Some(proj) = state.projects.iter().find(|p| p.name == project_name).cloned() {
                            let (cols, rows) = agent_pty_size();
                            agents.spawn(&project_name, &proj.path, &opt.command, &opt.description, cols, rows).ok();
                            state.project_focus.insert(project_name, ProjectFocus::Agents);
                        }
                    }
                }
            }
            _ => {}
        }
        return Ok(false);
    }

    // ── NAVIGATE MODE ─────────────────────────────────────────────────────────
    match &state.screen {
        Screen::Dashboard => handle_dashboard_key(key, state, agents, services, portforwards).await,
        Screen::Project(_) => handle_project_key(key, state, agents, services, portforwards).await,
    }
}

async fn handle_dashboard_key(
    key: KeyEvent,
    state: &mut AppState,
    _agents: &mut AgentManager,
    _services: &mut ServiceManager,
    portforwards: &mut PortForwardManager,
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
                let path = proj.path.clone();
                let proj_idx = state.selected_project;
                state.screen = Screen::Project(name.clone());
                // Auto-start services if .workspace.yaml exists
                if let Some(config) = load_workspace_config(std::path::Path::new(&path)) {
                    for svc_name in sorted_services(&config) {
                        if let Some(svc_config) = config.services.get(&svc_name) {
                            _services
                                .start(
                                    &name,
                                    &path,
                                    proj_idx,
                                    &svc_name,
                                    &svc_config.command,
                                    svc_config.port.unwrap_or(0),
                                    svc_config.env.as_ref(),
                                    svc_config.ready_pattern.as_deref(),
                                )
                                .await
                                .ok();
                        }
                    }
                    portforwards.start_all(&name, &config.portforwards).await;
                }
            }
        }
        _ => {}
    }
    Ok(false)
}

async fn handle_project_key(
    key: KeyEvent,
    state: &mut AppState,
    agents: &mut AgentManager,
    services: &mut ServiceManager,
    portforwards: &mut PortForwardManager,
) -> Result<bool> {
    let project_name = match &state.screen {
        Screen::Project(n) => n.clone(),
        _ => return Ok(false),
    };

    let focus = state
        .project_focus
        .get(&project_name)
        .cloned()
        .unwrap_or(ProjectFocus::Agents);

    match focus {
        // ── SERVICE DETAIL ─────────────────────────────────────────────────────
        // Esc goes up one level, j/k scroll, service actions live here
        ProjectFocus::ServiceDetail => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project_name, ProjectFocus::ServicesBrowse);
                }
                // scroll_up = offset from bottom; k goes further from bottom (older lines)
                KeyCode::Up | KeyCode::Char('k') => {
                    let off = state.log_scroll.entry(project_name).or_insert(0);
                    *off += 1;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let off = state.log_scroll.entry(project_name).or_insert(0);
                    *off = off.saturating_sub(1);
                }
                // start selected
                KeyCode::Char('u') => start_selected(state, services, &project_name).await,
                // stop selected
                KeyCode::Char('x') => {
                    let sel = state.selected_service.get(&project_name).copied().unwrap_or(0);
                    let names = sorted_service_names(services, &project_name);
                    if let Some(name) = names.get(sel) {
                        services.stop(&project_name, name).await.ok();
                    }
                }
                // restart selected
                KeyCode::Char('r') => {
                    restart_selected(state, services, &project_name).await;
                }
                // toggle word wrap
                KeyCode::Char('w') => {
                    let wrap = state.log_wrap.entry(project_name).or_insert(false);
                    *wrap = !*wrap;
                }
                _ => {}
            }
            return Ok(false);
        }

        // ── SERVICES BROWSE ────────────────────────────────────────────────────
        ProjectFocus::ServicesBrowse => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project_name, ProjectFocus::Agents);
                }
                KeyCode::Enter => {
                    state.log_scroll.remove(&project_name);
                    state.project_focus.insert(project_name, ProjectFocus::ServiceDetail);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    let count = services.list_for_project(&project_name).len();
                    if count > 0 {
                        let sel = state.selected_service.entry(project_name).or_insert(0);
                        if *sel > 0 { *sel -= 1; }
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let count = services.list_for_project(&project_name).len();
                    if count > 0 {
                        let sel = state.selected_service.entry(project_name).or_insert(0);
                        if *sel + 1 < count { *sel += 1; }
                    }
                }
                KeyCode::Char('R') => { restart_all(state, services, &project_name).await; }
                KeyCode::Char('X') => { services.stop_project(&project_name).await.ok(); }
                _ => {}
            }
            return Ok(false);
        }

        // ── PORT-FORWARD BROWSE ────────────────────────────────────────────────
        ProjectFocus::PfBrowse => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project_name, ProjectFocus::Agents);
                }
                KeyCode::Enter => {
                    state.log_scroll.remove(&project_name);
                    state.project_focus.insert(project_name, ProjectFocus::PfDetail);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    let count = portforwards.list_for_project(&project_name).len();
                    if count > 0 {
                        let sel = state.selected_pf.entry(project_name).or_insert(0);
                        if *sel > 0 { *sel -= 1; }
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let count = portforwards.list_for_project(&project_name).len();
                    if count > 0 {
                        let sel = state.selected_pf.entry(project_name).or_insert(0);
                        if *sel + 1 < count { *sel += 1; }
                    }
                }
                _ => {}
            }
            return Ok(false);
        }

        // ── PORT-FORWARD DETAIL ────────────────────────────────────────────────
        ProjectFocus::PfDetail => {
            match key.code {
                KeyCode::Esc => {
                    state.project_focus.insert(project_name, ProjectFocus::PfBrowse);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    let off = state.log_scroll.entry(project_name).or_insert(0);
                    *off += 1;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let off = state.log_scroll.entry(project_name).or_insert(0);
                    *off = off.saturating_sub(1);
                }
                // toggle word wrap
                KeyCode::Char('w') => {
                    let wrap = state.log_wrap.entry(project_name).or_insert(false);
                    *wrap = !*wrap;
                }
                _ => {}
            }
            return Ok(false);
        }

        // ── AGENTS ─────────────────────────────────────────────────────────────
        ProjectFocus::Agents => {}
    }

    // Keys that work in Agents focus (or globally in Navigate mode)
    match key.code {
        KeyCode::Char('q') => return Ok(true),

        // Back to dashboard
        KeyCode::Esc => {
            state.screen = Screen::Dashboard;
        }

        // Switch to services browse
        KeyCode::Char('s') => {
            state.project_focus.insert(project_name, ProjectFocus::ServicesBrowse);
        }
        // Switch to port-forwards browse
        KeyCode::Char('p') => {
            state.project_focus.insert(project_name, ProjectFocus::PfBrowse);
        }

        // Cycle agent tabs
        KeyCode::Tab => {
            let count = agents.list_for_project(&project_name).len();
            if count > 0 {
                let tab = state.active_agent_tab.entry(project_name).or_insert(0);
                *tab = (*tab + 1) % count;
            }
        }

        // Jump to agent tab 1-9
        KeyCode::Char(c) if c.is_ascii_digit() && c != '0' => {
            let idx = (c as usize) - ('1' as usize);
            let count = agents.list_for_project(&project_name).len();
            if idx < count {
                state.active_agent_tab.insert(project_name, idx);
            }
        }

        // Spawn new agent — shows picker if multiple templates, otherwise spawns claude
        KeyCode::Char('n') => {
            if let Some(proj) = state.projects.iter().find(|p| p.name == project_name).cloned() {
                let templates: Vec<SpawnOption> =
                    load_workspace_config(std::path::Path::new(&proj.path))
                        .and_then(|c| c.agent_templates)
                        .map(|tmpl| {
                            let mut opts: Vec<SpawnOption> = tmpl.into_iter().map(|(name, t)| SpawnOption {
                                name,
                                command: t.command,
                                description: t.description.unwrap_or_default(),
                            }).collect();
                            opts.sort_by(|a, b| a.name.cmp(&b.name));
                            opts
                        })
                        .unwrap_or_default();

                if templates.len() <= 1 {
                    // 0 or 1 template — spawn directly (use template or fall back to claude)
                    let (cmd, desc) = templates.first()
                        .map(|t| (t.command.as_str(), t.description.as_str()))
                        .unwrap_or(("claude", ""));
                    let (cols, rows) = agent_pty_size();
                    agents.spawn(&project_name, &proj.path, cmd, desc, cols, rows).ok();
                    state.project_focus.insert(project_name, ProjectFocus::Agents);
                } else {
                    // Multiple templates — open picker
                    state.spawn_picker = Some(templates);
                }
            }
        }

        // Enter terminal mode for current agent
        KeyCode::Enter | KeyCode::Char('i') => {
            let has_agents = !agents.list_for_project(&project_name).is_empty();
            if has_agents {
                state.project_focus.insert(project_name, ProjectFocus::Agents);
                state.input_mode = InputMode::Terminal;
            }
        }

        // Kill current agent
        KeyCode::Char('x') => {
            let tab = state.active_agent_tab.get(&project_name).copied().unwrap_or(0);
            let id = agents.list_for_project(&project_name).get(tab).map(|a| a.id.clone());
            if let Some(id) = id {
                agents.kill(&id);
                let tab = state.active_agent_tab.entry(project_name).or_insert(0);
                if *tab > 0 { *tab -= 1; }
            }
        }

        _ => {}
    }
    Ok(false)
}

/// Handle mouse scroll events — scroll logs in ServiceDetail / PfDetail,
/// forward scroll bytes to PTY in Terminal mode.
fn handle_mouse(
    mouse: crossterm::event::MouseEvent,
    state: &mut AppState,
    agents: &mut AgentManager,
) {
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let scroll_up_delta = matches!(mouse.kind, MouseEventKind::ScrollUp);

            // In terminal mode: forward as ANSI scroll escape to the active PTY
            if state.input_mode == InputMode::Terminal {
                if let Some(project_name) = state.active_project_name() {
                    let tab = state.active_agent_tab.get(project_name).copied().unwrap_or(0);
                    let ids: Vec<String> = agents
                        .list_for_project(project_name)
                        .into_iter()
                        .map(|a| a.id.clone())
                        .collect();
                    if let Some(id) = ids.get(tab) {
                        // xterm mouse scroll: ESC [ M (btn+32) col row  — or simpler arrow keys
                        let bytes: &[u8] = if scroll_up_delta { b"\x1b[A\x1b[A\x1b[A" } else { b"\x1b[B\x1b[B\x1b[B" };
                        agents.write(id, bytes.to_vec());
                    }
                }
                return;
            }

            // In Navigate mode: scroll log panes
            if let Some(project_name) = state.active_project_name().map(|s| s.to_string()) {
                let focus = state.project_focus.get(&project_name).cloned().unwrap_or(ProjectFocus::Agents);
                match focus {
                    ProjectFocus::ServiceDetail | ProjectFocus::PfDetail => {
                        let off = state.log_scroll.entry(project_name).or_insert(0);
                        if scroll_up_delta {
                            *off += 3; // scroll up = further from bottom
                        } else {
                            *off = off.saturating_sub(3); // scroll down = toward tail
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// PTY size for agent terminals: must match the actual inner area of the agent pane.
/// Layout: header(3) + help(2) = 5, pane borders(2), tab bar(1) = 8 rows overhead.
/// Cols: sidebar(28) + sidebar-borders(2) + pane-borders(2) = 32 overhead.
fn agent_pty_size() -> (u16, u16) {
    let (term_cols, term_rows) = crossterm::terminal::size().unwrap_or((220, 50));
    let cols = term_cols.saturating_sub(32).max(40);
    let rows = term_rows.saturating_sub(8).max(10);
    (cols, rows)
}

fn sorted_service_names(services: &ServiceManager, project_name: &str) -> Vec<String> {
    let mut names: Vec<String> = services
        .list_for_project(project_name)
        .iter()
        .map(|s| s.name.clone())
        .collect();
    names.sort();
    names
}

async fn start_selected(state: &mut AppState, services: &mut ServiceManager, project_name: &str) {
    let proj = state.projects.iter().find(|p| p.name == project_name).cloned();
    let proj_idx = state.projects.iter().position(|p| p.name == project_name).unwrap_or(0);
    if let Some(proj) = proj {
        if let Some(config) = load_workspace_config(std::path::Path::new(&proj.path)) {
            let names = sorted_services(&config);
            let sel = state.selected_service.get(project_name).copied().unwrap_or(0);
            if let Some(svc_name) = names.get(sel) {
                if let Some(svc) = config.services.get(svc_name) {
                    services.start(project_name, &proj.path, proj_idx, svc_name,
                        &svc.command, svc.port.unwrap_or(0),
                        svc.env.as_ref(), svc.ready_pattern.as_deref()).await.ok();
                }
            }
        }
    }
}

async fn restart_selected(state: &mut AppState, services: &mut ServiceManager, project_name: &str) {
    // Stop first
    let sel = state.selected_service.get(project_name).copied().unwrap_or(0);
    let names = sorted_service_names(services, project_name);
    if let Some(name) = names.get(sel) {
        services.stop(project_name, name).await.ok();
    }
    // Then start
    start_selected(state, services, project_name).await;
}

async fn restart_all(state: &mut AppState, services: &mut ServiceManager, project_name: &str) {
    services.stop_project(project_name).await.ok();
    let proj = state.projects.iter().find(|p| p.name == project_name).cloned();
    let proj_idx = state.projects.iter().position(|p| p.name == project_name).unwrap_or(0);
    if let Some(proj) = proj {
        if let Some(config) = load_workspace_config(std::path::Path::new(&proj.path)) {
            for svc_name in sorted_services(&config) {
                if let Some(svc) = config.services.get(&svc_name) {
                    services.start(project_name, &proj.path, proj_idx, &svc_name,
                        &svc.command, svc.port.unwrap_or(0),
                        svc.env.as_ref(), svc.ready_pattern.as_deref()).await.ok();
                }
            }
        }
    }
}

/// Convert a crossterm KeyEvent into the raw bytes to send to a PTY
fn key_to_bytes(key: KeyEvent) -> Vec<u8> {
    match key.code {
        KeyCode::Char(c) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                // Ctrl+A = 0x01, Ctrl+Z = 0x1A, etc.
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
