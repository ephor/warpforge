//! Render a serialized `wire::TerminalScreen` (styled span rows from the
//! daemon) into a ratatui buffer — the client-side counterpart of the daemon's
//! vt100 serializer, so the TUI shows remote PTY panes without its own emulator.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::Widget,
};
use warpforge_protocol::TerminalScreen;

pub struct WireTerminalPane<'a> {
    pub screen: &'a TerminalScreen,
}

impl<'a> WireTerminalPane<'a> {
    pub fn new(screen: &'a TerminalScreen) -> Self {
        Self { screen }
    }
}

impl Widget for WireTerminalPane<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (cur_row, cur_col) = self.screen.cursor;
        for (r, row) in self.screen.rows_content.iter().enumerate() {
            if r as u16 >= area.height {
                break;
            }
            let y = area.y + r as u16;
            let mut col: u16 = 0;
            for span in row {
                let mut style = Style::default();
                if let Some(fg) = decode_color(span.fg.as_deref()) {
                    style = style.fg(fg);
                }
                if let Some(bg) = decode_color(span.bg.as_deref()) {
                    style = style.bg(bg);
                }
                if span.bold {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if span.inverse {
                    style = style.add_modifier(Modifier::REVERSED);
                }
                for ch in span.text.chars() {
                    if col >= area.width {
                        break;
                    }
                    let x = area.x + col;
                    if x < buf.area.right() && y < buf.area.bottom() {
                        let mut cell_style = style;
                        if r as u16 == cur_row && col == cur_col {
                            cell_style = cell_style.add_modifier(Modifier::REVERSED);
                        }
                        if let Some(cell) = buf.cell_mut((x, y)) {
                            cell.set_char(ch);
                            cell.set_style(cell_style);
                        }
                    }
                    col += 1;
                }
            }
        }
    }
}

fn decode_color(s: Option<&str>) -> Option<Color> {
    let s = s?;
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            return Some(Color::Rgb(r, g, b));
        }
        return None;
    }
    if let Some(idx) = s.strip_prefix('i') {
        return idx.parse::<u8>().ok().map(Color::Indexed);
    }
    None
}
