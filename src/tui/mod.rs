mod dashboard;
mod project;
mod terminal;

use ratatui::Frame;

use crate::agent::AgentManager;
use crate::app::{AppState, Screen};
use crate::portforward::PortForwardManager;
use crate::service::ServiceManager;

pub fn render(
    frame: &mut Frame,
    state: &AppState,
    agents: &AgentManager,
    services: &ServiceManager,
    portforwards: &PortForwardManager,
) {
    match &state.screen {
        Screen::Dashboard => dashboard::render(frame, state, agents, services),
        Screen::Project(name) => project::render(frame, state, agents, services, portforwards, name),
    }
}
