use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Margin},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};

use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent::AgentManager;
use crate::app::AppState;
use crate::service::{ServiceManager, ServiceStatus};

pub fn render(
    frame: &mut Frame,
    state: &AppState,
    agents: &AgentManager,
    services: &ServiceManager,
) {
    let area = frame.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // header
            Constraint::Min(0),     // project list
            Constraint::Length(2),  // help bar
        ])
        .split(area);

    // ── Header ───────────────────────────────────────────────────────────────
    let header = Paragraph::new(Line::from(vec![
        Span::styled("⚡ WarpForge", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
        Span::raw("  workspace orchestrator"),
    ]))
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, chunks[0]);

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // ── Project list ─────────────────────────────────────────────────────────
    let items: Vec<ListItem> = state
        .projects
        .iter()
        .map(|p| {
            let mut lines = vec![Line::from(vec![
                Span::styled(&p.name, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                Span::raw("  "),
                Span::styled(&p.path, Style::default().fg(Color::DarkGray)),
            ])];

            let svc_list = services.list_for_project(&p.name);
            let agent_list = agents.list_for_project(&p.name);

            if svc_list.is_empty() && agent_list.is_empty() {
                lines.push(Line::from(Span::styled("    ○ idle", Style::default().fg(Color::DarkGray))));
            } else {
                for svc in &svc_list {
                    let (icon, color) = match svc.status {
                        ServiceStatus::Running  => ("●", Color::Green),
                        ServiceStatus::Starting => ("◌", Color::Yellow),
                        ServiceStatus::Failed   => ("✗", Color::Red),
                        ServiceStatus::Stopped  => ("○", Color::DarkGray),
                    };
                    let port_str = if svc.allocated_port > 0 {
                        if svc.original_port > 0 && svc.original_port != svc.allocated_port {
                            format!(" :{}->{}", svc.original_port, svc.allocated_port)
                        } else {
                            format!(" :{}", svc.allocated_port)
                        }
                    } else { String::new() };
                    lines.push(Line::from(vec![
                        Span::raw("    "),
                        Span::styled(icon, Style::default().fg(color)),
                        Span::raw(" "),
                        Span::styled(&svc.name, Style::default().fg(Color::White)),
                        Span::styled(port_str, Style::default().fg(Color::DarkGray)),
                    ]));
                }
                for agent in &agent_list {
                    let elapsed_min = now_secs.saturating_sub(agent.started_at) / 60;
                    let elapsed_str = if elapsed_min > 0 { format!("{}m", elapsed_min) } else { "<1m".to_string() };
                    lines.push(Line::from(vec![
                        Span::raw("    "),
                        Span::styled("▶", Style::default().fg(Color::Green)),
                        Span::raw(" agent "),
                        Span::styled(&agent.description, Style::default().fg(Color::Yellow)),
                        Span::styled(format!(" ({})", elapsed_str), Style::default().fg(Color::DarkGray)),
                    ]));
                }
            }

            ListItem::new(lines)
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .title(" Projects ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)),
        )
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▶ ");

    let mut list_state = ListState::default();
    if !state.projects.is_empty() {
        list_state.select(Some(state.selected_project));
    }

    frame.render_stateful_widget(list, chunks[1].inner(Margin::new(0, 0)), &mut list_state);

    if state.projects.is_empty() {
        let hint = Paragraph::new("  No projects. Run `warpforge add <path>` to register one.")
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(hint, chunks[1].inner(Margin::new(1, 1)));
    }

    // ── Help bar ─────────────────────────────────────────────────────────────
    let help = Paragraph::new(Line::from(vec![
        help_key("↑↓/jk", "navigate"),
        Span::raw("  "),
        help_key("Enter", "open"),
        Span::raw("  "),
        help_key("q", "quit"),
    ]));
    frame.render_widget(help, chunks[2]);
}

fn help_key<'a>(key: &'a str, desc: &'a str) -> Span<'a> {
    Span::raw(format!("[{key}] {desc}  "))
}
