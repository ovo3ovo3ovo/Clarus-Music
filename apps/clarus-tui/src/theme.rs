use std::{
    fmt,
    io::{self, Write},
    time::{Duration, Instant},
};

/// The palette policy selected at startup.
///
/// `Auto` asks a capable terminal for its default foreground and background
/// colors once, then falls back to terminal-native rendering if the terminal
/// does not answer. `Terminal` avoids the query altogether, while
/// `ClarusBlack` preserves the deliberately black Clarus presentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Auto,
    Terminal,
    ClarusBlack,
}

impl ThemeMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "terminal" => Some(Self::Terminal),
            "clarus-black" | "black" => Some(Self::ClarusBlack),
            _ => None,
        }
    }
}

impl fmt::Display for ThemeMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Auto => "auto",
            Self::Terminal => "terminal",
            Self::ClarusBlack => "clarus-black",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: Rgb,
    pub background: Rgb,
}

/// The resolved palette. It is intentionally immutable: querying terminal
/// color state during normal rendering would add terminal I/O and can leak
/// escape-sequence replies into the event stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    ClarusBlack,
    Terminal { defaults: Option<TerminalColors> },
}

impl Theme {
    pub const fn clarus_black() -> Self {
        Self::ClarusBlack
    }

    pub const fn terminal() -> Self {
        Self::Terminal { defaults: None }
    }

    pub const fn terminal_with_defaults(defaults: TerminalColors) -> Self {
        Self::Terminal {
            defaults: Some(defaults),
        }
    }

    pub const fn is_clarus_black(self) -> bool {
        matches!(self, Self::ClarusBlack)
    }

    pub const fn terminal_defaults(self) -> Option<TerminalColors> {
        match self {
            Self::ClarusBlack => None,
            Self::Terminal { defaults } => defaults,
        }
    }

    /// Smooth grayscale interpolation is safe for the fixed Clarus palette or
    /// when Auto obtained the terminal's actual defaults. A terminal-native
    /// fallback intentionally uses only reset/ANSI colors instead of guessing
    /// RGB grays that may disappear on a light profile.
    pub const fn supports_smooth_neutral_animation(self) -> bool {
        matches!(
            self,
            Self::ClarusBlack | Self::Terminal { defaults: Some(_) }
        )
    }
}

/// Resolves the selected palette after raw mode is enabled and before the
/// alternate screen is entered. This ordering lets the probe read OSC replies
/// directly, before crossterm owns stdin for normal key and mouse events.
pub fn resolve(mode: ThemeMode) -> Theme {
    match mode {
        ThemeMode::ClarusBlack => Theme::clarus_black(),
        ThemeMode::Terminal => Theme::terminal(),
        ThemeMode::Auto => probe_terminal_defaults()
            .map(Theme::terminal_with_defaults)
            .unwrap_or_else(Theme::terminal),
    }
}

const OSC_DEFAULT_FOREGROUND_QUERY: &[u8] = b"\x1b]10;?\x07";
const OSC_DEFAULT_BACKGROUND_QUERY: &[u8] = b"\x1b]11;?\x07";
const OSC_PROBE_TIMEOUT: Duration = Duration::from_millis(90);
const MAX_OSC_RESPONSE_BYTES: usize = 1024;

#[cfg(unix)]
fn probe_terminal_defaults() -> Option<TerminalColors> {
    use std::os::fd::AsRawFd;

    let term = std::env::var("TERM").unwrap_or_default();
    if !osc_color_query_supported_for_term(&term) {
        return None;
    }

    let stdin = io::stdin();
    let stdin_fd = stdin.as_raw_fd();
    // Do not steal a key that was already typed while the process was
    // starting. The probe is optional, so a pending byte means a clean
    // terminal-native fallback is preferable to inspecting stdin.
    if poll_stdin(stdin_fd, Duration::ZERO).unwrap_or(true) {
        return None;
    }

    let mut stdout = io::stdout();
    stdout.write_all(OSC_DEFAULT_FOREGROUND_QUERY).ok()?;
    stdout.write_all(OSC_DEFAULT_BACKGROUND_QUERY).ok()?;
    stdout.flush().ok()?;

    let deadline = Instant::now() + OSC_PROBE_TIMEOUT;
    let mut reply = Vec::with_capacity(128);
    while Instant::now() < deadline && reply.len() < MAX_OSC_RESPONSE_BYTES {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !poll_stdin(stdin_fd, remaining).ok()? {
            break;
        }

        let mut chunk = [0_u8; 256];
        // SAFETY: stdin_fd comes from a live `Stdin` value, `chunk` is valid
        // writable memory for its full length, and `read` does not outlive it.
        let count = unsafe {
            libc::read(
                stdin_fd,
                chunk.as_mut_ptr().cast::<libc::c_void>(),
                chunk.len(),
            )
        };
        if count == 0 {
            break;
        }
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        reply.extend_from_slice(&chunk[..count as usize]);
        if let Some(colors) = parse_osc_default_colors(&reply) {
            return Some(colors);
        }
    }
    parse_osc_default_colors(&reply)
}

#[cfg(not(unix))]
fn probe_terminal_defaults() -> Option<TerminalColors> {
    // Reading raw terminal replies without racing the normal input reader is
    // platform-specific. Terminal-native rendering remains a safe fallback on
    // platforms where this compact Unix probe is unavailable.
    None
}

#[cfg(unix)]
fn poll_stdin(fd: std::os::fd::RawFd, timeout: Duration) -> io::Result<bool> {
    let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        // SAFETY: `descriptor` points to initialized memory and remains valid
        // for the one-item `poll` call.
        let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
        if result >= 0 {
            return Ok(result > 0 && (descriptor.revents & (libc::POLLIN | libc::POLLPRI)) != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn osc_color_query_supported_for_term(term: &str) -> bool {
    let term = term.trim().to_ascii_lowercase();
    !term.is_empty()
        && !matches!(
            term.as_str(),
            "dumb" | "vt100" | "vt102" | "cons25" | "linux"
        )
}

fn parse_osc_default_colors(reply: &[u8]) -> Option<TerminalColors> {
    let reply = String::from_utf8_lossy(reply);
    Some(TerminalColors {
        foreground: parse_osc_color(&reply, "10")?,
        background: parse_osc_color(&reply, "11")?,
    })
}

fn parse_osc_color(reply: &str, code: &str) -> Option<Rgb> {
    let marker = format!("\x1b]{code};");
    let (_, value) = reply.rsplit_once(&marker)?;
    let value = value
        .split('\x07')
        .next()
        .unwrap_or_default()
        .split("\x1b\\")
        .next()
        .unwrap_or_default();
    parse_rgb(value)
}

fn parse_rgb(value: &str) -> Option<Rgb> {
    let value = value.trim();
    if let Some(value) = value.strip_prefix("rgb:") {
        let mut channels = value.split('/').map(parse_hex_channel);
        let color = Rgb {
            red: channels.next()??,
            green: channels.next()??,
            blue: channels.next()??,
        };
        return channels.next().is_none().then_some(color);
    }
    let value = value.strip_prefix('#')?;
    match value.len() {
        3 => Some(Rgb {
            red: parse_hex_channel(&value[0..1])?,
            green: parse_hex_channel(&value[1..2])?,
            blue: parse_hex_channel(&value[2..3])?,
        }),
        6 => Some(Rgb {
            red: parse_hex_channel(&value[0..2])?,
            green: parse_hex_channel(&value[2..4])?,
            blue: parse_hex_channel(&value[4..6])?,
        }),
        _ => None,
    }
}

fn parse_hex_channel(value: &str) -> Option<u8> {
    if value.is_empty() || value.len() > 4 {
        return None;
    }
    let source = u32::from_str_radix(value, 16).ok()?;
    let maximum = (1_u32 << (value.len() * 4)) - 1;
    Some(((source * 255 + maximum / 2) / maximum) as u8)
}

#[cfg(test)]
mod tests {
    use super::{
        osc_color_query_supported_for_term, parse_osc_default_colors, parse_rgb, Rgb,
        TerminalColors, Theme, ThemeMode,
    };

    #[test]
    fn parses_bel_terminated_osc_default_colors() {
        let colors = parse_osc_default_colors(
            b"\x1b]10;rgb:ffff/8000/0000\x07\x1b]11;rgb:0000/1111/2222\x07",
        );
        assert_eq!(
            colors,
            Some(TerminalColors {
                foreground: Rgb {
                    red: 255,
                    green: 128,
                    blue: 0,
                },
                background: Rgb {
                    red: 0,
                    green: 17,
                    blue: 34,
                },
            })
        );
    }

    #[test]
    fn parses_st_terminated_and_hash_osc_colors() {
        let colors = parse_osc_default_colors(b"\x1b]10;#f0a\x1b\\\x1b]11;#102030\x1b\\");
        assert_eq!(
            colors,
            Some(TerminalColors {
                foreground: Rgb {
                    red: 255,
                    green: 0,
                    blue: 170,
                },
                background: Rgb {
                    red: 16,
                    green: 32,
                    blue: 48,
                },
            })
        );
    }

    #[test]
    fn ignores_malformed_or_incomplete_replies() {
        assert!(parse_osc_default_colors(b"\x1b]10;rgb:ffff/ffff/ffff\x07").is_none());
        assert!(parse_rgb("rgb:ffff/nope/0000").is_none());
        assert!(parse_rgb("#00ff").is_none());
    }

    #[test]
    fn theme_modes_are_explicit_and_terminal_safe() {
        assert_eq!(ThemeMode::parse("AUTO"), Some(ThemeMode::Auto));
        assert_eq!(ThemeMode::parse("black"), Some(ThemeMode::ClarusBlack));
        assert_eq!(ThemeMode::parse("unknown"), None);
        assert_eq!(Theme::terminal().terminal_defaults(), None);
        assert!(Theme::clarus_black().is_clarus_black());
        assert!(!Theme::terminal().supports_smooth_neutral_animation());
    }

    #[test]
    fn probe_skips_known_legacy_terminals() {
        for term in ["", "dumb", "vt100", "linux"] {
            assert!(!osc_color_query_supported_for_term(term));
        }
        for term in ["xterm-256color", "screen", "tmux-256color", "kitty"] {
            assert!(osc_color_query_supported_for_term(term));
        }
    }
}
