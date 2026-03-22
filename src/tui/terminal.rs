use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},

    widgets::Widget,
};
use vt100::Screen;

/// Renders a vt100 Screen directly into a ratatui Buffer.
/// This is the core of the terminal pane — no xterm/headless, no polling.
pub struct TerminalPane<'a> {
    pub screen: &'a Screen,
}

impl<'a> TerminalPane<'a> {
    pub fn new(screen: &'a Screen) -> Self {
        Self { screen }
    }
}

impl Widget for TerminalPane<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (cursor_row, cursor_col) = self.screen.cursor_position();

        for row in 0..area.height {
            let screen_row = row as u16;
            if screen_row >= self.screen.size().0 {
                break;
            }

            let y = area.y + row;
            let mut col = 0u16;

            while col < area.width {
                let screen_col = col;
                if screen_col >= self.screen.size().1 {
                    break;
                }

                let cell = self.screen.cell(screen_row, screen_col);
                let x = area.x + col;

                if x >= buf.area.right() || y >= buf.area.bottom() {
                    col += 1;
                    continue;
                }

                let (ch, style) = if let Some(cell) = cell {
                    let text = cell.contents();
                    let ch = if text.is_empty() { " ".to_string() } else { text };

                    let fg = vt100_color_to_ratatui(cell.fgcolor());
                    let bg = vt100_color_to_ratatui(cell.bgcolor());

                    let mut style = Style::default().fg(fg).bg(bg);
                    if cell.bold() {
                        style = style.add_modifier(Modifier::BOLD);
                    }
                    if cell.italic() {
                        style = style.add_modifier(Modifier::ITALIC);
                    }
                    if cell.underline() {
                        style = style.add_modifier(Modifier::UNDERLINED);
                    }
                    if cell.inverse() {
                        style = style.add_modifier(Modifier::REVERSED);
                    }

                    // Cursor highlight
                    if screen_row == cursor_row && screen_col == cursor_col {
                        style = style.add_modifier(Modifier::REVERSED);
                    }

                    (ch, style)
                } else {
                    (" ".to_string(), Style::default())
                };

                let buf_cell = buf.cell_mut((x, y));
                if let Some(bc) = buf_cell {
                    bc.set_symbol(&ch);
                    bc.set_style(style);
                }

                col += 1;
            }
        }
    }
}

fn vt100_color_to_ratatui(color: vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
