mod app;
mod audio;
mod benchmark;
mod qr;
mod theme;
mod ui;

use std::{
    future::pending,
    io::{self, IsTerminal, Write},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{bail, Result};
use app::{App, Message};
use clarus_core::MusicCore;
use crossterm::{
    event::{Event, EventStream},
    execute,
    style::Print,
    style::{Color, ResetColor, SetBackgroundColor},
    terminal::{
        disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use futures_util::StreamExt;
use ratatui::{backend::CrosstermBackend, Terminal};
use theme::{Theme, ThemeMode};
use tokio::sync::mpsc;

// Enable only the mouse reports the TUI actually consumes: button presses for
// pane-divider dragging, button motion while a divider is held, and wheel/
// trackpad events. Crossterm's broad mouse-capture preset also enables 1003
// all-motion reporting, which produces a stream of useless events while the
// pointer moves over the terminal and needlessly wakes the event loop.
const ENABLE_TUI_MOUSE: &str = "\u{1b}[?1000h\u{1b}[?1002h\u{1b}[?1006h";
const DISABLE_TUI_MOUSE: &str = "\u{1b}[?1006l\u{1b}[?1002l\u{1b}[?1000l";
const ENABLE_BRACKETED_PASTE: &str = "\u{1b}[?2004h";
const DISABLE_BRACKETED_PASTE: &str = "\u{1b}[?2004l";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartupOptions {
    theme_mode: ThemeMode,
}

fn main() -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--benchmark-audio")
    {
        return benchmark::run(&arguments[1..]);
    }
    let options = parse_startup_options(&arguments)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let result = runtime.block_on(async_main(options));
    // Live requests are aborted by App::drop before this deadline, so terminal
    // restoration and a user-requested exit never wait for background work.
    runtime.shutdown_timeout(Duration::from_millis(300));
    result
}

fn parse_startup_options(arguments: &[String]) -> Result<StartupOptions> {
    let mut options = StartupOptions {
        theme_mode: ThemeMode::Auto,
    };
    let mut iterator = arguments.iter();
    while let Some(argument) = iterator.next() {
        match argument.as_str() {
            "--theme" => {
                let value = iterator.next().ok_or_else(|| {
                    anyhow::anyhow!("--theme 需要 auto、terminal 或 clarus-black 参数")
                })?;
                options.theme_mode = parse_theme_mode(value)?;
            }
            value if value.starts_with("--theme=") => {
                options.theme_mode = parse_theme_mode(&value["--theme=".len()..])?;
            }
            _ => bail!(
                "用法：clarus-tui [--theme auto|terminal|clarus-black]\n      clarus-tui --benchmark-audio <本地音频文件> [秒数]"
            ),
        }
    }
    Ok(options)
}

fn parse_theme_mode(value: &str) -> Result<ThemeMode> {
    ThemeMode::parse(value)
        .ok_or_else(|| anyhow::anyhow!("未知主题“{value}”；可用值：auto、terminal、clarus-black"))
}

async fn async_main(options: StartupOptions) -> Result<()> {
    if !io::stdout().is_terminal()
        || !io::stdin().is_terminal()
        || std::env::var("TERM").ok().as_deref() == Some("dumb")
    {
        print_non_tty_help();
        return Ok(());
    }

    let terminal_capabilities = ui::Capabilities::from_environment();
    let (mut terminal, theme) = match enter_terminal(mouse_capture_supported(), options.theme_mode)
    {
        Ok(terminal) => terminal,
        Err(error) => {
            leave_terminal();
            return Err(error);
        }
    };
    // A true-color transport alone is not enough for terminal-native lyric
    // interpolation: without the terminal's default colors there is no safe
    // RGB gray that works on both light and dark profiles. Keep that fallback
    // event-driven instead of waking at 120Hz for visually identical frames.
    let capabilities = ui::Capabilities {
        unicode: terminal_capabilities.unicode,
        true_color: terminal_capabilities.true_color && theme.supports_smooth_neutral_animation(),
    };
    let result = run(&mut terminal, capabilities, theme).await;
    leave_terminal();
    result
}

fn print_non_tty_help() {
    println!("Clarus Music TUI 需要交互式终端。请在 TTY 中运行 clarus-tui。\n");
    println!("核心入口：每日推荐、我最喜欢、收藏的歌单、创建的歌单");
}

fn enter_terminal(
    enable_mouse: bool,
    theme_mode: ThemeMode,
) -> Result<(Terminal<CrosstermBackend<io::Stdout>>, Theme)> {
    install_panic_restore_hook();
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    // OSC replies are read only during this bounded startup probe, before the
    // normal event stream exists. A terminal that cannot answer simply uses
    // its native colors without delaying or changing interaction.
    let theme = theme::resolve(theme_mode);
    let mouse_mode = if enable_mouse { ENABLE_TUI_MOUSE } else { "" };
    execute!(
        stdout,
        EnterAlternateScreen,
        Print(mouse_mode),
        Print(ENABLE_BRACKETED_PASTE)
    )?;
    if theme.is_clarus_black() {
        execute!(stdout, SetBackgroundColor(Color::Black))?;
    } else {
        // No painted application surface in terminal-native mode: the
        // terminal's configured background remains visible around every pane.
        execute!(stdout, ResetColor)?;
    }
    execute!(stdout, Clear(ClearType::All), crossterm::cursor::Hide)?;
    let backend = CrosstermBackend::new(stdout);
    Ok((Terminal::new(backend)?, theme))
}

fn mouse_capture_supported() -> bool {
    let term = std::env::var("TERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    mouse_capture_supported_for_term(&term)
}

fn mouse_capture_supported_for_term(term: &str) -> bool {
    // Legacy serial/console terminals do not reliably understand SGR mouse
    // reports. Keep the keyboard/ASCII UI usable there and only request the
    // reports needed by the pane divider and wheel paths on modern terminals.
    !term.is_empty() && !matches!(term, "dumb" | "vt100" | "vt102" | "cons25")
}

fn leave_terminal() {
    let _ = disable_raw_mode();
    let mut stdout = io::stdout();
    let _ = execute!(
        stdout,
        Print(DISABLE_BRACKETED_PASTE),
        Print(DISABLE_TUI_MOUSE),
        LeaveAlternateScreen,
        ResetColor,
        crossterm::cursor::Show
    );
    let _ = stdout.flush();
}

fn install_panic_restore_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        leave_terminal();
        previous(panic);
    }));
}

async fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    capabilities: ui::Capabilities,
    theme: Theme,
) -> Result<()> {
    let core = Arc::new(MusicCore::new());
    let (tx, mut messages) = mpsc::channel::<Message>(64);
    // The normal constructor restores an existing session and falls back to
    // the QR login screen. No SMS constructor or command-line flag is wired
    // into the executable.
    let mut app = App::new(core, tx);
    let mut events = EventStream::new();
    let mut ctrl_c = Box::pin(tokio::signal::ctrl_c());
    let mut terminate = Box::pin(termination_signal());
    let mut dirty = true;

    loop {
        if dirty {
            terminal.draw(|frame| ui::render_with_theme(frame, &mut app, capabilities, theme))?;
            dirty = false;
        }
        // The active transition has a tiny bounded lifetime. True-color
        // terminals get the 120Hz timing target; capability-limited renderers
        // use the App's lower-rate fallback instead of spending CPU on frames
        // whose visual interpolation cannot be represented.
        let sleep_for = app.next_wake_after(Instant::now(), capabilities.true_color);
        let timer = tokio::time::sleep(sleep_for);
        tokio::pin!(timer);
        tokio::select! {
            event = events.next() => {
                match event {
                    Some(Ok(Event::Key(key))) => {
                        if app.handle_key(key) {
                            break;
                        }
                        dirty |= app.key_changed();
                    }
                    Some(Ok(Event::Mouse(mouse))) => {
                        dirty |= app.handle_mouse(mouse);
                    }
                    Some(Ok(Event::Paste(value))) => {
                        dirty |= app.handle_paste(&value);
                    }
                    Some(Ok(Event::Resize(_, _))) => dirty = true,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error.into()),
                    None => break,
                }
            }
            message = messages.recv() => {
                match message {
                    Some(message) => {
                        app.handle_message(message);
                        dirty = true;
                    }
                    None => break,
                }
            }
            _ = &mut timer => {
                let animated = app.wants_animation();
                dirty |= app.tick(Instant::now());
                // A transition has visual state even when the model did not change.
                dirty |= animated;
            }
            _ = &mut ctrl_c => break,
            _ = &mut terminate => break,
        }
    }
    Ok(())
}

async fn termination_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            let _ = signal.recv().await;
            return;
        }
    }
    pending::<()>().await;
}

#[cfg(test)]
mod tests {
    use super::{mouse_capture_supported_for_term, parse_startup_options};
    use crate::theme::ThemeMode;

    #[test]
    fn mouse_reports_are_disabled_for_legacy_terminal_types() {
        for term in ["", "dumb", "vt100", "vt102", "cons25"] {
            assert!(!mouse_capture_supported_for_term(term));
        }
        for term in ["xterm-256color", "screen", "tmux-256color", "kitty"] {
            assert!(mouse_capture_supported_for_term(term));
        }
    }

    #[test]
    fn startup_options_default_to_auto_theme_and_accept_overrides() {
        let options = parse_startup_options(&[]).expect("default options should parse");
        assert_eq!(options.theme_mode, ThemeMode::Auto);

        let options = parse_startup_options(&["--theme=clarus-black".to_string()])
            .expect("theme option should parse");
        assert_eq!(options.theme_mode, ThemeMode::ClarusBlack);
        assert!(parse_startup_options(&["--phone-login".to_string()]).is_err());
    }
}
