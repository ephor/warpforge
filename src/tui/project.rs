use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs},
};

use crate::agent::{AgentManager, AgentStatus};
use crate::app::{AppState, InputMode, ProjectFocus, SpawnOption};
use crate::portforward::{PfStatus, PortForwardManager};
use crate::service::{ServiceManager, ServiceStatus};
use crate::tui::terminal::TerminalPane;

pub fn render(
    frame: &mut Frame,
    state: &AppState,
    agents: &AgentManager,
    services: &ServiceManager,
    portforwards: &PortForwardManager,
    project_name: &str,
) {
    let area = frame.area();
    let focus = state.project_focus.get(project_name).cloned().unwrap_or(ProjectFocus::Agents);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header
            Constraint::Min(0),    // main content
            Constraint::Length(2), // help bar
        ])
        .split(area);

    // ── Header ───────────────────────────────────────────────────────────────
    let mode_label = match (&focus, &state.input_mode) {
        (_, InputMode::Terminal)          => Span::styled(" TERMINAL ",     Style::default().fg(Color::Black).bg(Color::Yellow)),
        (ProjectFocus::Agents, _)         => Span::styled(" AGENTS ",       Style::default().fg(Color::Black).bg(Color::Green)),
        (ProjectFocus::ServicesBrowse, _) => Span::styled(" SERVICES ",     Style::default().fg(Color::Black).bg(Color::Cyan)),
        (ProjectFocus::ServiceDetail, _)  => Span::styled(" SERVICE LOGS ", Style::default().fg(Color::Black).bg(Color::Cyan)),
        (ProjectFocus::PfBrowse, _)       => Span::styled(" PORT-FWD ",     Style::default().fg(Color::Black).bg(Color::Magenta)),
        (ProjectFocus::PfDetail, _)       => Span::styled(" PORT-FWD LOGS ",Style::default().fg(Color::Black).bg(Color::Magenta)),
    };

    let header = Paragraph::new(Line::from(vec![
        Span::styled("⚡ ", Style::default().fg(Color::Yellow)),
        Span::styled(project_name, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw("  "),
        mode_label,
    ]))
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, chunks[0]);

    // ── Main split ───────────────────────────────────────────────────────────
    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(28), Constraint::Min(0)])
        .split(chunks[1]);

    render_sidebar(frame, state, agents, services, portforwards, project_name, &focus, main_chunks[0]);

    match &focus {
        ProjectFocus::Agents         => render_agent_pane(frame, state, agents, project_name, main_chunks[1]),
        ProjectFocus::ServicesBrowse => render_log_tail(frame, state, services, project_name, main_chunks[1]),
        ProjectFocus::ServiceDetail  => render_log_detail(frame, state, services, project_name, main_chunks[1]),
        ProjectFocus::PfBrowse       => render_pf_tail(frame, state, portforwards, project_name, main_chunks[1]),
        ProjectFocus::PfDetail       => render_pf_detail(frame, state, portforwards, project_name, main_chunks[1]),
    }

    // ── Help bar ─────────────────────────────────────────────────────────────
    let help = if state.input_mode == InputMode::Terminal {
        Paragraph::new(Line::from(vec![
            Span::styled("TERMINAL  ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            help_key("Esc / Ctrl+B", "exit"),
            Span::raw("   "),
            help_key("Ctrl+C", "quit app"),
        ]))
    } else {
        match focus {
            ProjectFocus::Agents => Paragraph::new(Line::from(vec![
                help_active("a", "agents"),
                Span::raw("  "),
                help_key("s", "services"),
                Span::raw("   "),
                help_key("i", "type"),
                Span::raw("  "),
                help_key("n", "new agent"),
                Span::raw("  "),
                help_key("Tab/1-9", "switch"),
                Span::raw("  "),
                help_key("x", "kill agent"),
                Span::raw("   "),
                help_key("Esc", "dashboard"),
            ])),
            ProjectFocus::ServicesBrowse => Paragraph::new(Line::from(vec![
                help_active("s", "services"),
                Span::raw("  "),
                help_key("p", "port-fwd"),
                Span::raw("  "),
                help_key("a", "agents"),
                Span::raw("   "),
                help_key("↑↓", "navigate"),
                Span::raw("  "),
                help_key("Enter", "detail"),
                Span::raw("  "),
                help_key("R", "restart all"),
                Span::raw("  "),
                help_key("X", "stop all"),
                Span::raw("   "),
                help_key("Esc", "→ agents"),
            ])),
            ProjectFocus::ServiceDetail => Paragraph::new(Line::from(vec![
                help_key("↑↓", "scroll"),
                Span::raw("   "),
                help_key("u", "start"),
                Span::raw("  "),
                help_key("x", "stop"),
                Span::raw("  "),
                help_key("r", "restart"),
                Span::raw("   "),
                help_key("Esc", "← browse"),
            ])),
            ProjectFocus::PfBrowse => Paragraph::new(Line::from(vec![
                help_key("s", "services"),
                Span::raw("  "),
                help_active("p", "port-fwd"),
                Span::raw("  "),
                help_key("a", "agents"),
                Span::raw("   "),
                help_key("↑↓", "navigate"),
                Span::raw("  "),
                help_key("Enter", "logs"),
                Span::raw("   "),
                help_key("Esc", "→ agents"),
            ])),
            ProjectFocus::PfDetail => Paragraph::new(Line::from(vec![
                help_key("↑↓", "scroll logs"),
                Span::raw("   "),
                help_key("Esc", "← port-fwd"),
            ])),
        }
    };
    frame.render_widget(help, chunks[2]);

    // ── Spawn picker popup (rendered on top of everything) ────────────────────
    if let Some(ref options) = state.spawn_picker {
        render_spawn_picker(frame, options, area);
    }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

fn render_sidebar(
    frame: &mut Frame,
    state: &AppState,
    agents: &AgentManager,
    services: &ServiceManager,
    portforwards: &PortForwardManager,
    project_name: &str,
    focus: &ProjectFocus,
    area: ratatui::layout::Rect,
) {
    let svc_list = services.list_for_project(project_name);
    let agent_list = agents.list_for_project(project_name);
    let pf_list = portforwards.list_for_project(project_name);
    let selected_svc = state.selected_service.get(project_name).copied().unwrap_or(0);

    let pf_height = if pf_list.is_empty() { 0 } else { pf_list.len() as u16 + 2 };
    let svc_height = (svc_list.len() as u16 + 2).max(3);
    let sidebar_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(svc_height),
            Constraint::Length(pf_height),
            Constraint::Min(0),
        ])
        .split(area);

    // ── Services list ─────────────────────────────────────────────────────────
    let svc_focused = matches!(focus, ProjectFocus::ServicesBrowse | ProjectFocus::ServiceDetail);
    let svc_border = if svc_focused { Color::Cyan } else { Color::DarkGray };

    let mut sorted_svcs = svc_list.clone();
    sorted_svcs.sort_by_key(|s| &s.name);

    let svc_items: Vec<ListItem> = sorted_svcs
        .iter()
        .map(|svc| {
            let (icon, icon_color) = match svc.status {
                ServiceStatus::Running  => ("● ", Color::Green),
                ServiceStatus::Starting => ("◌ ", Color::Yellow),
                ServiceStatus::Failed   => ("✗ ", Color::Red),
                ServiceStatus::Stopped  => ("○ ", Color::DarkGray),
            };
            let port_label = if svc.allocated_port > 0 {
                if svc.original_port > 0 && svc.original_port != svc.allocated_port {
                    format!(" :{}->{}", svc.original_port, svc.allocated_port)
                } else {
                    format!(" :{}", svc.allocated_port)
                }
            } else {
                String::new()
            };
            ListItem::new(Line::from(vec![
                Span::styled(icon, Style::default().fg(icon_color)),
                Span::raw(&svc.name),
                Span::styled(port_label, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();

    let svc_title = if svc_focused {
        format!(" Services ({}/{}) ", selected_svc + 1, sorted_svcs.len().max(1))
    } else {
        " Services ".to_string()
    };

    let svc_widget = List::new(svc_items)
        .block(Block::default().title(svc_title).borders(Borders::ALL)
            .border_style(Style::default().fg(svc_border)))
        .highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
        .highlight_symbol("▶ ");
    let mut svc_state = ListState::default();
    if !sorted_svcs.is_empty() {
        svc_state.select(Some(selected_svc.min(sorted_svcs.len() - 1)));
    }
    frame.render_stateful_widget(svc_widget, sidebar_chunks[0], &mut svc_state);

    // ── Port-forwards ─────────────────────────────────────────────────────────
    if !pf_list.is_empty() {
        let pf_focused = matches!(focus, ProjectFocus::PfBrowse | ProjectFocus::PfDetail);
        let pf_border = if pf_focused { Color::Magenta } else { Color::DarkGray };
        let selected_pf = state.selected_pf.get(project_name).copied().unwrap_or(0);

        let pf_items: Vec<ListItem> = pf_list.iter().map(|pf| {
            let (icon, color) = match pf.status {
                PfStatus::Active     => ("⇌ ", Color::Green),
                PfStatus::Starting   => ("◌ ", Color::Yellow),
                PfStatus::Restarting => ("⟳ ", Color::Yellow),
                PfStatus::Failed     => ("✗ ", Color::Red),
                PfStatus::Stopped    => ("○ ", Color::DarkGray),
            };
            let label = format!(":{} {}", pf.local_port, pf.name);
            ListItem::new(Line::from(vec![
                Span::styled(icon, Style::default().fg(color)),
                Span::raw(label),
            ]))
        }).collect();

        let pf_title = if pf_focused {
            format!(" Port-fwd ({}/{}) ", selected_pf + 1, pf_list.len())
        } else {
            " Port-fwd ".to_string()
        };

        let pf_widget = List::new(pf_items)
            .block(Block::default().title(pf_title).borders(Borders::ALL)
                .border_style(Style::default().fg(pf_border)))
            .highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
            .highlight_symbol("▶ ");
        let mut pf_state = ListState::default();
        if !pf_list.is_empty() {
            pf_state.select(Some(selected_pf.min(pf_list.len() - 1)));
        }
        frame.render_stateful_widget(pf_widget, sidebar_chunks[1], &mut pf_state);
    }

    // ── Agents list ───────────────────────────────────────────────────────────
    let agent_focused = matches!(focus, ProjectFocus::Agents);
    let agent_border = if agent_focused { Color::Green } else { Color::DarkGray };
    let active_tab = state.active_agent_tab.get(project_name).copied().unwrap_or(0);

    let agent_items: Vec<ListItem> = agent_list.iter().enumerate().map(|(i, a)| {
        let (icon, color) = match a.status {
            AgentStatus::Running     => ("▶ ", Color::Green),
            AgentStatus::NeedsReview => ("● ", Color::Yellow),
            AgentStatus::Completed   => ("✓ ", Color::DarkGray),
            AgentStatus::Failed      => ("✗ ", Color::Red),
            AgentStatus::Spawning    => ("◌ ", Color::Cyan),
        };
        let label = if a.description.is_empty() { &a.command } else { &a.description };
        let text_style = if i == active_tab && agent_focused {
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        ListItem::new(Line::from(vec![
            Span::styled(icon, Style::default().fg(color)),
            Span::styled(label.as_str(), text_style),
        ]))
    }).collect();

    let agents_title = if agent_list.is_empty() {
        " Agents ".to_string()
    } else {
        format!(" Agents ({}/{}) ", active_tab + 1, agent_list.len())
    };

    let agents_widget = List::new(agent_items)
        .block(Block::default().title(agents_title).borders(Borders::ALL)
            .border_style(Style::default().fg(agent_border)));
    frame.render_widget(agents_widget, sidebar_chunks[2]);
}

// ── Right pane: agent terminal ────────────────────────────────────────────────

fn render_agent_pane(
    frame: &mut Frame,
    state: &AppState,
    agents: &AgentManager,
    project_name: &str,
    area: ratatui::layout::Rect,
) {
    let agent_list = agents.list_for_project(project_name);

    if agent_list.is_empty() {
        let hint = Paragraph::new(vec![
            Line::raw(""),
            Line::from(Span::styled("  No agents running.", Style::default().fg(Color::DarkGray))),
            Line::from(Span::styled("  [n] spawn claude   [s] view services", Style::default().fg(Color::DarkGray))),
        ])
        .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::DarkGray)));
        frame.render_widget(hint, area);
        return;
    }

    let active_tab = state.active_agent_tab.get(project_name).copied().unwrap_or(0)
        .min(agent_list.len().saturating_sub(1));

    // Tab bar (only when >1 agent)
    let content_area = if agent_list.len() > 1 {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(1), Constraint::Min(0)])
            .split(area);

        let tab_titles: Vec<Line> = agent_list.iter().enumerate().map(|(i, a)| {
            let label = format!(" {} ", if a.description.is_empty() { &a.command } else { &a.description });
            if i == active_tab {
                Line::from(Span::styled(label, Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)))
            } else {
                Line::from(Span::styled(label, Style::default().fg(Color::DarkGray)))
            }
        }).collect();

        let tabs = Tabs::new(tab_titles)
            .select(active_tab)
            .style(Style::default().fg(Color::DarkGray))
            .highlight_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD));
        frame.render_widget(tabs, split[0]);
        split[1]
    } else {
        area
    };

    let border_style = if state.input_mode == InputMode::Terminal {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default().fg(Color::Green)
    };
    let block = Block::default().borders(Borders::ALL).border_style(border_style);
    let inner = block.inner(content_area);
    frame.render_widget(block, content_area);

    if let Some(agent) = agent_list.get(active_tab) {
        let parser = agent.screen.lock().unwrap();
        frame.render_widget(TerminalPane::new(parser.screen()), inner);
    }
}

// ── Right pane: live log tail (ServicesBrowse — no scroll, auto-follow) ───────

fn render_log_tail(
    frame: &mut Frame,
    _state: &AppState,
    services: &ServiceManager,
    project_name: &str,
    area: ratatui::layout::Rect,
) {
    let mut svc_list = services.list_for_project(project_name);
    svc_list.sort_by_key(|s| &s.name);
    let selected = _state.selected_service.get(project_name).copied().unwrap_or(0);

    if svc_list.is_empty() {
        let hint = Paragraph::new(" No services.  [u] start   [Esc] back to agents")
            .style(Style::default().fg(Color::DarkGray))
            .block(Block::default().title(" Logs ").borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)));
        frame.render_widget(hint, area);
        return;
    }

    let svc = match svc_list.get(selected.min(svc_list.len() - 1)) {
        Some(s) => s,
        None => return,
    };

    let inner_height = area.height.saturating_sub(2) as usize;
    // Auto-follow: always show the last N lines
    let start = svc.logs.len().saturating_sub(inner_height);
    let log_lines: Vec<Line> = svc.logs[start..]
        .iter()
        .map(|l| {
            let color = if l.contains("[err]") { Color::Red } else { Color::Reset };
            Line::from(Span::styled(l.as_str(), Style::default().fg(color)))
        })
        .collect();

    let title = format!(" {} — tail  [Enter] scroll & actions ", svc.name);
    let widget = Paragraph::new(log_lines)
        .block(Block::default().title(title).borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan)));
    frame.render_widget(widget, area);
}

// ── Right pane: scrollable logs (ServiceDetail) ───────────────────────────────

fn render_log_detail(
    frame: &mut Frame,
    state: &AppState,
    services: &ServiceManager,
    project_name: &str,
    area: ratatui::layout::Rect,
) {
    let mut svc_list = services.list_for_project(project_name);
    svc_list.sort_by_key(|s| &s.name);
    let selected = state.selected_service.get(project_name).copied().unwrap_or(0);

    if svc_list.is_empty() {
        frame.render_widget(
            Paragraph::new(" No services.")
                .block(Block::default().title(" Logs ").borders(Borders::ALL)),
            area,
        );
        return;
    }

    let svc = match svc_list.get(selected.min(svc_list.len() - 1)) {
        Some(s) => s,
        None => return,
    };

    let inner_height = area.height.saturating_sub(2) as usize;
    let total = svc.logs.len();
    let max_scroll = total.saturating_sub(inner_height);
    // log_scroll stores offset-from-bottom: 0 = follow tail, N = scrolled N lines up
    let scroll_up = state.log_scroll.get(project_name).copied().unwrap_or(0).min(max_scroll);
    let offset = max_scroll.saturating_sub(scroll_up) as u16;

    let scroll_info = if total > inner_height {
        let current_end = (offset as usize + inner_height).min(total);
        format!(" {}/{} ", current_end, total)
    } else {
        String::new()
    };

    let status_color = match svc.status {
        ServiceStatus::Running  => Color::Green,
        ServiceStatus::Starting => Color::Yellow,
        ServiceStatus::Failed   => Color::Red,
        ServiceStatus::Stopped  => Color::DarkGray,
    };
    let title = format!(" {} [{}]{} ", svc.name, svc.status, scroll_info);

    let log_lines: Vec<Line> = svc.logs.iter().map(|l| {
        let color = if l.contains("[err]") { Color::Red } else { Color::Reset };
        Line::from(Span::styled(l.as_str(), Style::default().fg(color)))
    }).collect();

    let widget = Paragraph::new(log_lines)
        .scroll((offset, 0))
        .block(Block::default().title(title).borders(Borders::ALL)
            .border_style(Style::default().fg(status_color)));
    frame.render_widget(widget, area);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Right pane: port-forward log tail (PfBrowse) ─────────────────────────────

fn render_pf_tail(
    frame: &mut Frame,
    state: &AppState,
    portforwards: &PortForwardManager,
    project_name: &str,
    area: ratatui::layout::Rect,
) {
    let pf_list = portforwards.list_for_project(project_name);
    let selected = state.selected_pf.get(project_name).copied().unwrap_or(0);

    if pf_list.is_empty() {
        let hint = Paragraph::new(" No port-forwards configured in .workspace.yaml")
            .style(Style::default().fg(Color::DarkGray))
            .block(Block::default().title(" Port-forward Logs ").borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)));
        frame.render_widget(hint, area);
        return;
    }

    let pf = match pf_list.get(selected.min(pf_list.len() - 1)) {
        Some(p) => p,
        None => return,
    };

    let inner_height = area.height.saturating_sub(2) as usize;
    let start = pf.logs.len().saturating_sub(inner_height);
    let log_lines: Vec<Line> = pf.logs[start..].iter().map(|l| {
        let color = if l.contains("[err]") || l.contains("[error]") { Color::Red }
                    else if l.contains("[warn]") { Color::Yellow }
                    else if l.contains("✓") { Color::Green }
                    else { Color::Reset };
        Line::from(Span::styled(l.as_str(), Style::default().fg(color)))
    }).collect();

    let title = format!(" {} [{}]  [Enter] scroll ", pf.name, pf.status);
    let widget = Paragraph::new(log_lines)
        .block(Block::default().title(title).borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Magenta)));
    frame.render_widget(widget, area);
}

// ── Right pane: scrollable port-forward logs (PfDetail) ───────────────────────

fn render_pf_detail(
    frame: &mut Frame,
    state: &AppState,
    portforwards: &PortForwardManager,
    project_name: &str,
    area: ratatui::layout::Rect,
) {
    let pf_list = portforwards.list_for_project(project_name);
    let selected = state.selected_pf.get(project_name).copied().unwrap_or(0);

    if pf_list.is_empty() {
        frame.render_widget(
            Paragraph::new(" No port-forwards.")
                .block(Block::default().title(" Logs ").borders(Borders::ALL)),
            area,
        );
        return;
    }

    let pf = match pf_list.get(selected.min(pf_list.len() - 1)) {
        Some(p) => p,
        None => return,
    };

    let inner_height = area.height.saturating_sub(2) as usize;
    let total = pf.logs.len();
    let max_scroll = total.saturating_sub(inner_height);
    let scroll_up = state.log_scroll.get(project_name).copied().unwrap_or(0).min(max_scroll);
    let offset = max_scroll.saturating_sub(scroll_up) as u16;

    let scroll_info = if total > inner_height {
        let current_end = (offset as usize + inner_height).min(total);
        format!(" {}/{} ", current_end, total)
    } else {
        String::new()
    };

    let status_color = match pf.status {
        PfStatus::Active     => Color::Green,
        PfStatus::Starting | PfStatus::Restarting => Color::Yellow,
        PfStatus::Failed     => Color::Red,
        PfStatus::Stopped    => Color::DarkGray,
    };
    let title = format!(" {} [{}]{} ", pf.name, pf.status, scroll_info);

    let log_lines: Vec<Line> = pf.logs.iter().map(|l| {
        let color = if l.contains("[err]") || l.contains("[error]") { Color::Red }
                    else if l.contains("[warn]") { Color::Yellow }
                    else if l.contains("✓") || l.contains("Forwarding") { Color::Green }
                    else { Color::Reset };
        Line::from(Span::styled(l.as_str(), Style::default().fg(color)))
    }).collect();

    let widget = Paragraph::new(log_lines)
        .scroll((offset, 0))
        .block(Block::default().title(title).borders(Borders::ALL)
            .border_style(Style::default().fg(status_color)));
    frame.render_widget(widget, area);
}

// ── Spawn picker popup ────────────────────────────────────────────────────────

fn render_spawn_picker(frame: &mut Frame, options: &[SpawnOption], parent: Rect) {
    let width: u16 = 36;
    let height: u16 = options.len() as u16 + 4; // title + items + hint

    // Center horizontally, place in upper third vertically
    let x = parent.x + parent.width.saturating_sub(width) / 2;
    let y = parent.y + parent.height / 4;
    let area = Rect { x, y, width: width.min(parent.width), height: height.min(parent.height) };

    let items: Vec<ListItem> = options.iter().enumerate().map(|(i, opt)| {
        let key_style = Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD);
        let desc = if opt.description.is_empty() { opt.command.as_str() } else { opt.description.as_str() };
        ListItem::new(Line::from(vec![
            Span::raw("  "),
            Span::styled(format!("[{}]", i + 1), key_style),
            Span::raw(format!("  {:<12} {}", opt.command, desc)),
        ]))
    }).collect();

    let block = Block::default()
        .title(" New agent ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));

    // Clear background first so popup doesn't bleed through
    frame.render_widget(Clear, area);

    // Split into list area + hint line at bottom
    let inner = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(block.inner(area));

    frame.render_widget(block, area);
    frame.render_widget(List::new(items), inner[0]);
    frame.render_widget(
        Paragraph::new(Span::styled("  Esc to cancel", Style::default().fg(Color::DarkGray))),
        inner[1],
    );
}

fn help_key<'a>(key: &'a str, desc: &'a str) -> Span<'a> {
    Span::raw(format!("[{key}] {desc}"))
}

fn help_active<'a>(key: &'a str, desc: &'a str) -> Span<'a> {
    Span::styled(
        format!("[{key}] {desc}"),
        Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
    )
}
