mod dashboard;
mod project;
mod wire_terminal;

use ratatui::Frame;

use crate::app::{AppState, Screen};
use crate::client::ClientState;

pub fn render(frame: &mut Frame, state: &AppState, cs: &ClientState) {
    match &state.screen {
        Screen::Dashboard => dashboard::render(frame, state, &cs.agents, &cs.services),
        Screen::Project(name) => project::render(
            frame,
            state,
            &cs.agents,
            &cs.services,
            &cs.portforwards,
            name,
        ),
    }
}
