//! Terminal QR rendering with an explicit white quiet zone.
//!
//! QR codes are data, not image assets in the TUI. The renderer keeps their
//! modules as terminal cells, which avoids any dependency on image protocols.

use qrcode::{types::Color as ModuleColor, EcLevel, QrCode};
use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};

const QUIET_ZONE: usize = 4;
// Keep QR colors out of the terminal-theme remapping pass. The xterm cube
// endpoints remain high contrast on modern terminals and degrade to the
// nearest black/white pair on simpler ANSI implementations.
const QR_BLACK: Color = Color::Indexed(16);
const QR_WHITE: Color = Color::Indexed(231);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrRenderMode {
    /// Two terminal cells per QR module. This preserves a nearly square module.
    #[allow(dead_code)]
    DoubleWidth,
    /// A Unicode half-block combines two vertical modules on narrow terminals.
    HalfBlock,
    /// Printable ASCII fallback for terminals without a usable Unicode font.
    Ascii,
}

#[derive(Debug, Clone)]
pub struct TerminalQr {
    width: usize,
    modules: Vec<bool>,
}

impl TerminalQr {
    pub fn encode(value: &str) -> Result<Self, String> {
        // The code is rendered directly on a stable terminal surface, so low
        // error correction is the appropriate tradeoff: it keeps a normal
        // NetEase key within the 80×24 compact layout without compromising
        // the mandatory quiet zone or module contrast.
        let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::L)
            .map_err(|error| error.to_string())?;
        let width = code.width();
        let modules = code
            .to_colors()
            .into_iter()
            .map(|color| color == ModuleColor::Dark)
            .collect();
        Ok(Self { width, modules })
    }

    pub fn double_width_cells(&self) -> u16 {
        self.module_width().saturating_mul(2).min(u16::MAX as usize) as u16
    }

    pub fn half_block_cells(&self) -> u16 {
        self.module_width().min(u16::MAX as usize) as u16
    }

    pub fn double_width_rows(&self) -> u16 {
        self.module_width().min(u16::MAX as usize) as u16
    }

    pub fn half_block_rows(&self) -> u16 {
        self.module_width().div_ceil(2).min(u16::MAX as usize) as u16
    }

    pub fn lines(&self, mode: QrRenderMode) -> Vec<Line<'static>> {
        match mode {
            QrRenderMode::DoubleWidth => self.double_width_lines(),
            QrRenderMode::HalfBlock => self.half_block_lines(),
            QrRenderMode::Ascii => self.ascii_lines(),
        }
    }

    fn module_width(&self) -> usize {
        self.width + QUIET_ZONE * 2
    }

    fn dark_at(&self, x: usize, y: usize) -> bool {
        if x < QUIET_ZONE
            || y < QUIET_ZONE
            || x >= self.width + QUIET_ZONE
            || y >= self.width + QUIET_ZONE
        {
            return false;
        }
        self.modules[(y - QUIET_ZONE) * self.width + (x - QUIET_ZONE)]
    }

    fn double_width_lines(&self) -> Vec<Line<'static>> {
        (0..self.module_width())
            .map(|y| {
                let spans: Vec<Span<'static>> = (0..self.module_width())
                    .map(|x| module_span(self.dark_at(x, y)))
                    .collect();
                Line::from(spans)
            })
            .collect()
    }

    fn half_block_lines(&self) -> Vec<Line<'static>> {
        (0..self.module_width())
            .step_by(2)
            .map(|y| {
                let spans: Vec<Span<'static>> = (0..self.module_width())
                    .map(|x| half_block_span(self.dark_at(x, y), self.dark_at(x, y + 1)))
                    .collect();
                Line::from(spans)
            })
            .collect()
    }

    fn ascii_lines(&self) -> Vec<Line<'static>> {
        (0..self.module_width())
            .map(|y| {
                let spans: Vec<Span<'static>> = (0..self.module_width())
                    .map(|x| ascii_span(self.dark_at(x, y)))
                    .collect();
                Line::from(spans)
            })
            .collect()
    }
}

fn module_span(dark: bool) -> Span<'static> {
    let color = if dark { QR_BLACK } else { QR_WHITE };
    Span::styled("  ", Style::default().fg(color).bg(color))
}

fn half_block_span(top_dark: bool, bottom_dark: bool) -> Span<'static> {
    match (top_dark, bottom_dark) {
        (false, false) => Span::styled(" ", Style::default().fg(QR_WHITE).bg(QR_WHITE)),
        (true, true) => Span::styled(" ", Style::default().fg(QR_BLACK).bg(QR_BLACK)),
        (true, false) => Span::styled("▀", Style::default().fg(QR_BLACK).bg(QR_WHITE)),
        (false, true) => Span::styled("▄", Style::default().fg(QR_BLACK).bg(QR_WHITE)),
    }
}

fn ascii_span(dark: bool) -> Span<'static> {
    let color = if dark { QR_BLACK } else { QR_WHITE };
    Span::styled(
        if dark { "##" } else { "  " },
        Style::default().fg(color).bg(QR_WHITE),
    )
}

#[cfg(test)]
mod tests {
    use super::{QrRenderMode, TerminalQr};

    #[test]
    fn qr_has_a_quiet_zone_and_a_narrow_terminal_fallback() {
        let qr = TerminalQr::encode("https://music.163.com/login?codekey=test").unwrap();
        assert!(qr.double_width_cells() > qr.half_block_cells());
        assert_eq!(
            qr.lines(QrRenderMode::DoubleWidth).len() as u16,
            qr.double_width_rows()
        );
        assert_eq!(
            qr.lines(QrRenderMode::HalfBlock).len() as u16,
            qr.half_block_rows()
        );
        let ordinary_key = TerminalQr::encode(&format!(
            "https://music.163.com/login?codekey={}",
            "a".repeat(48)
        ))
        .unwrap();
        assert!(ordinary_key.half_block_cells() <= 80);
        assert!(ordinary_key.half_block_rows() <= 23);
    }
}
