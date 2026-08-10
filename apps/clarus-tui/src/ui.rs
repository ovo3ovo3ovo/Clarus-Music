use std::{borrow::Cow, time::Instant};

use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    app::{format_time, App, AuthState, Content, Focus, HitAreas, NavItem},
    qr::{QrRenderMode, TerminalQr},
};

const BACKGROUND: Color = Color::Black;
const FOREGROUND: Color = Color::White;
const MUTED: Color = Color::DarkGray;
const SUCCESS: Color = Color::White;
const WARNING: Color = Color::Yellow;
const ERROR: Color = Color::Red;
const MIN_WIDTH: u16 = 52;
const MIN_HEIGHT: u16 = 13;
// A three-pane player needs enough cells for the navigation, a readable song
// row, and a lyric line. Below this width the one-pane lyric fallback is more
// useful than squeezing three columns into an unreadable table.
const MIN_WIDE_LIBRARY_WIDTH: u16 = 120;

#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    pub unicode: bool,
    pub true_color: bool,
}

impl Capabilities {
    pub fn from_environment() -> Self {
        // A terminal advertises only a transport, not the encoding used by the
        // user's locale.  In a C/POSIX locale Unicode glyphs are not a safe
        // default (and often render as two replacement cells), so use the
        // printable ASCII path unless the caller explicitly provides a UTF
        // locale.  An unset locale remains optimistic for GUI terminals and
        // CI shells that inherit no locale variables at all.
        let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .into_iter()
            .find_map(|key| std::env::var_os(key).filter(|value| !value.is_empty()));
        let unicode = std::env::var_os("CLARUS_TUI_ASCII").is_none()
            && locale_supports_unicode(locale.as_deref());
        let color_term = std::env::var("COLORTERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let term = std::env::var("TERM")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let true_color = color_term.contains("truecolor")
            || color_term.contains("24bit")
            || term.contains("direct")
            || term.contains("kitty")
            || term.contains("wezterm");
        Self {
            unicode,
            true_color,
        }
    }
}

fn locale_supports_unicode(locale: Option<&std::ffi::OsStr>) -> bool {
    let Some(locale) = locale.and_then(|value| value.to_str()) else {
        return true;
    };
    let normalized = locale.trim().to_ascii_lowercase();
    !normalized.is_empty()
        && normalized != "c"
        && normalized != "posix"
        && !normalized.starts_with("c.")
}

pub fn render(frame: &mut Frame, app: &mut App, capabilities: Capabilities) {
    let area = frame.area();
    // A terminal cell that no widget touches keeps ratatui's `Reset` style.
    // Paint the complete frame first so the black/white visual system also
    // applies to intentional empty space around compact layouts.
    frame.buffer_mut().set_style(area, base_style());
    // A previous narrow render may have put the content list into a
    // lyrics-only presentation. Reset it before handling another screen so
    // keyboard routing never gets stuck in that mode.
    app.set_lyrics_only(false);
    frame.render_widget(Block::default().style(base_style()), area);

    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        render_too_small(frame, area);
        normalize_frame_style(frame, area);
        return;
    }

    match &app.auth {
        AuthState::Authenticated(_) => render_library(frame, app, area, capabilities),
        _ => render_login(frame, app, area, capabilities),
    }
    normalize_frame_style(frame, area);
}

fn normalize_frame_style(frame: &mut Frame, area: Rect) {
    // Ratatui clears the trailing cell after a wide grapheme (for example a
    // CJK character) to keep the cell available for the next render. That
    // continuation cell also loses its style, so inherit the preceding wide
    // cell's style before restoring the explicit monochrome defaults. This
    // keeps reverse-video selection and the QR quiet zone visually contiguous.
    let buffer = frame.buffer_mut();
    for y in area.top()..area.bottom() {
        let mut continuation_style = None;
        let mut continuation_cells = 0_usize;
        for x in area.left()..area.right() {
            let cell = &mut buffer[(x, y)];
            if continuation_cells > 0 {
                if let Some((fg, bg, modifier)) = continuation_style {
                    if cell.fg == Color::Reset {
                        cell.fg = fg;
                    }
                    if cell.bg == Color::Reset {
                        cell.bg = bg;
                    }
                    if cell.modifier.is_empty() {
                        cell.modifier = modifier;
                    }
                }
                continuation_cells = continuation_cells.saturating_sub(1);
            } else {
                if cell.bg == Color::Reset {
                    cell.set_bg(BACKGROUND);
                }
                if cell.fg == Color::Reset {
                    cell.set_fg(FOREGROUND);
                }
                let width = UnicodeWidthStr::width(cell.symbol());
                if width > 1 {
                    continuation_style = Some((cell.fg, cell.bg, cell.modifier));
                    continuation_cells = width.saturating_sub(1);
                } else {
                    continuation_style = None;
                }
            }
        }
    }
}

fn render_too_small(frame: &mut Frame, area: Rect) {
    let message = format!(
        "终端至少需要 {MIN_WIDTH}×{MIN_HEIGHT}（当前 {}×{}）",
        area.width, area.height
    );
    frame.render_widget(
        Paragraph::new(message)
            .style(Style::default().fg(WARNING).bg(BACKGROUND))
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true }),
        centered(area, area.width.saturating_sub(2), 3),
    );
}

fn render_login(frame: &mut Frame, app: &mut App, area: Rect, capabilities: Capabilities) {
    let sections = Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).split(area);
    render_header(frame, sections[0], "登录", None, &app.status);

    let (qr_url, qr_status) = match &app.auth {
        AuthState::Login {
            qr: Some(qr),
            status,
            ..
        } => (Some(qr.login_url.as_str()), status.as_str()),
        AuthState::Login { status, .. } => (None, status.as_str()),
        AuthState::Restoring => (None, "正在从系统 Keychain 恢复登录态…"),
        AuthState::Failed(message) => (None, message.as_str()),
        AuthState::Authenticated(_) => return,
    };

    let panel = sections[1];
    let headline = if qr_status.contains("二维码已过期") {
        "二维码已过期，请按 r 重新生成"
    } else if qr_url.is_some() {
        "使用网易云音乐扫描二维码"
    } else if matches!(app.auth, AuthState::Failed(_)) {
        "无法恢复登录状态"
    } else {
        "正在准备登录"
    };
    frame.render_widget(
        Paragraph::new(headline)
            .style(
                Style::default()
                    .fg(FOREGROUND)
                    .bg(BACKGROUND)
                    .add_modifier(Modifier::BOLD),
            )
            .alignment(Alignment::Center),
        Rect {
            x: panel.x,
            y: panel.y.saturating_add(1),
            width: panel.width,
            height: 1,
        },
    );

    if let Some(url) = qr_url {
        render_qr(frame, panel, url, capabilities);
    }

    let help_y = panel.bottom().saturating_sub(3);
    frame.render_widget(
        Paragraph::new(truncate_display(
            qr_status,
            panel.width.saturating_sub(4) as usize,
        ))
        .style(Style::default().fg(status_color(qr_status)).bg(BACKGROUND))
        .alignment(Alignment::Center),
        Rect {
            x: panel.x.saturating_add(2),
            y: help_y,
            width: panel.width.saturating_sub(4),
            height: 1,
        },
    );
    let login_help = match &app.auth {
        AuthState::Restoring => "r / Enter / Esc 改用二维码    Ctrl+X 退出",
        AuthState::Failed(_) => "r / Enter / Esc 使用二维码登录    Ctrl+X 退出",
        AuthState::Login { .. } => "r / Enter 重新生成二维码    Esc 取消    Ctrl+X 退出",
        AuthState::Authenticated(_) => "Ctrl+X 退出",
    };
    frame.render_widget(
        Paragraph::new(truncate_display(
            login_help,
            panel.width.saturating_sub(2) as usize,
        ))
        .style(Style::default().fg(MUTED).bg(BACKGROUND))
        .alignment(Alignment::Center),
        Rect {
            x: panel.x,
            y: help_y.saturating_add(1),
            width: panel.width,
            height: 1,
        },
    );
}

fn render_qr(frame: &mut Frame, panel: Rect, url: &str, capabilities: Capabilities) {
    let Ok(qr) = TerminalQr::encode(url) else {
        frame.render_widget(
            Paragraph::new("二维码编码失败；按 r 重试")
                .style(Style::default().fg(ERROR).bg(BACKGROUND))
                .alignment(Alignment::Center),
            centered(panel, panel.width.saturating_sub(4), 1),
        );
        return;
    };
    let available_width = panel.width.saturating_sub(4);
    let available_height = panel.height.saturating_sub(7);
    let mode = if capabilities.unicode
        && qr.double_width_cells() <= available_width
        && qr.double_width_rows() <= available_height
    {
        QrRenderMode::DoubleWidth
    } else if capabilities.unicode
        && qr.half_block_cells() <= available_width
        && qr.half_block_rows() <= available_height
    {
        QrRenderMode::HalfBlock
    } else if !capabilities.unicode
        && qr.double_width_cells() <= available_width
        && qr.double_width_rows() <= available_height
    {
        QrRenderMode::Ascii
    } else {
        frame.render_widget(
            Paragraph::new("终端太窄，无法安全显示二维码；请放大窗口后按 r 重试")
                .style(Style::default().fg(WARNING).bg(BACKGROUND))
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: true }),
            centered(panel, available_width, 3),
        );
        return;
    };
    let lines = qr.lines(mode);
    let (width, height) = match mode {
        QrRenderMode::DoubleWidth => (qr.double_width_cells(), qr.double_width_rows()),
        QrRenderMode::HalfBlock => (qr.half_block_cells(), qr.half_block_rows()),
        QrRenderMode::Ascii => (qr.double_width_cells(), qr.double_width_rows()),
    };
    let qr_area = centered(
        Rect {
            x: panel.x,
            y: panel.y.saturating_add(3),
            width: panel.width,
            height: panel.height.saturating_sub(7),
        },
        width,
        height,
    );
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(Color::White))
            .alignment(Alignment::Center),
        qr_area,
    );
}

fn render_library(frame: &mut Frame, app: &mut App, area: Rect, capabilities: Capabilities) {
    let sections = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(5),
        Constraint::Length(5),
    ])
    .split(area);
    let user = app.current_user().map(|user| user.nickname.as_str());
    render_header(frame, sections[0], app.content.title(), user, &app.status);

    // Do not reserve a lyric column before anything is playing: it would
    // shrink the library for a placeholder the listener cannot use yet.
    // Once playback has a current track, keep three panes only when every
    // pane remains readable. Smaller terminals deliberately switch lyrics
    // into the main pane instead of squeezing three columns together.
    let wide = app.lyrics_visible
        && app.player.current.is_some()
        && sections[1].width >= MIN_WIDE_LIBRARY_WIDTH;
    let body_width = sections[1].width;
    let sidebar_max = body_width
        .saturating_sub(34)
        .saturating_sub(if wide { 28 } else { 0 })
        .max(18);
    app.sidebar_width = app.sidebar_width.clamp(18, sidebar_max);
    if wide {
        let lyrics_max = body_width
            .saturating_sub(app.sidebar_width)
            .saturating_sub(34)
            .max(28);
        app.lyrics_width = app.lyrics_width.clamp(28, lyrics_max);
    }
    let body = if wide {
        Layout::horizontal([
            Constraint::Length(app.sidebar_width),
            Constraint::Min(34),
            Constraint::Length(app.lyrics_width),
        ])
        .split(sections[1])
    } else {
        Layout::horizontal([Constraint::Length(app.sidebar_width), Constraint::Min(1)])
            .split(sections[1])
    };

    let navigation = body[0];
    let content = body[1];
    // On a narrow terminal keep the library usable before a song is chosen;
    // after playback starts `v` switches between the list and the single
    // lyrics pane.  This is the deliberate one-pane degradation strategy.
    let compact_lyrics = !wide && app.lyrics_visible && app.player.current.is_some();
    app.set_lyrics_only(compact_lyrics);
    // The content list is not merely hidden behind the lyrics pane: it is not
    // an interactive surface in this presentation. If a resize happens while
    // the list owns focus, move focus to the visible player pane immediately
    // so every key still has an obvious target and the footer remains truthful.
    if compact_lyrics && app.focus == Focus::Content {
        app.focus = Focus::Player;
    }
    let lyrics = if wide { body[2] } else { Rect::default() };
    let sidebar_divider = Rect {
        x: navigation.right().saturating_sub(1),
        y: navigation.y,
        width: 1,
        height: navigation.height,
    };
    let lyrics_divider = if wide {
        Rect {
            x: lyrics.x,
            y: lyrics.y,
            width: 1,
            height: lyrics.height,
        }
    } else {
        Rect::default()
    };
    app.set_hit_areas(HitAreas {
        body: sections[1],
        navigation,
        content,
        sidebar_divider,
        lyrics_divider,
    });

    render_navigation(frame, app, navigation, capabilities);
    if compact_lyrics {
        render_lyrics(frame, app, content, true, capabilities);
    } else {
        render_content(frame, app, content, capabilities);
        if wide {
            render_lyrics(frame, app, lyrics, false, capabilities);
        }
    }
    render_player(frame, app, sections[2], capabilities);
}

fn render_header(frame: &mut Frame, area: Rect, title: &str, user: Option<&str>, status: &str) {
    let inner_width = area.width.saturating_sub(4) as usize;
    let brand_separator = "CLARUS MUSIC  /  ";
    let title_budget =
        inner_width.saturating_sub(UnicodeWidthStr::width(brand_separator).saturating_add(1));
    let title = truncate_display(title, title_budget);
    let used = UnicodeWidthStr::width(brand_separator) + UnicodeWidthStr::width(title.as_str());
    let identity_budget = inner_width.saturating_sub(used.saturating_add(2));
    let identity = user
        .map(|name| {
            let name_budget = identity_budget.saturating_sub(2);
            format!("  {}", truncate_display(name, name_budget))
        })
        .unwrap_or_default();
    let left = Line::from(vec![
        Span::styled(
            "CLARUS MUSIC",
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  /  ", Style::default().fg(MUTED).bg(BACKGROUND)),
        Span::styled(title, Style::default().fg(FOREGROUND).bg(BACKGROUND)),
        Span::styled(identity, Style::default().fg(MUTED).bg(BACKGROUND)),
    ]);
    frame.render_widget(
        Paragraph::new(left),
        Rect {
            x: area.x.saturating_add(2),
            y: area.y,
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
    let status_width = area.width.saturating_sub(4).min(42) as usize;
    frame.render_widget(
        Paragraph::new(truncate_display(status, status_width))
            .style(Style::default().fg(status_color(status)).bg(BACKGROUND))
            .alignment(Alignment::Right),
        Rect {
            x: area.x.saturating_add(2),
            y: area.y.saturating_add(1),
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
}

fn render_navigation(frame: &mut Frame, app: &App, area: Rect, capabilities: Capabilities) {
    frame.render_widget(
        Block::default().borders(Borders::RIGHT).border_style(
            Style::default()
                .fg(divider_color(capabilities))
                .bg(BACKGROUND),
        ),
        area,
    );
    frame.render_widget(
        Paragraph::new("音乐库").style(
            Style::default()
                .fg(MUTED)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ),
        Rect {
            x: area.x.saturating_add(2),
            y: area.y,
            width: area.width.saturating_sub(3),
            height: 1,
        },
    );
    for (index, item) in NavItem::ALL.iter().enumerate() {
        let selected = app.nav == *item;
        let focused = app.focus == Focus::Navigation && selected;
        let prefix = if selected {
            if capabilities.unicode {
                "›"
            } else {
                ">"
            }
        } else {
            " "
        };
        let line = format!("{prefix} {}  {}", item.number(), item.label());
        let style = if focused {
            selected_style()
        } else if selected {
            selected_unfocused_style()
        } else {
            // Navigation and content use the same neutral text hierarchy;
            // focus is carried by the shared reverse-video selected style.
            Style::default().fg(FOREGROUND).bg(BACKGROUND)
        };
        frame.render_widget(
            Paragraph::new(truncate_display(
                &line,
                area.width.saturating_sub(3) as usize,
            ))
            .style(style),
            Rect {
                x: area.x.saturating_add(1),
                y: area.y.saturating_add(2 + index as u16),
                width: area.width.saturating_sub(2),
                height: 1,
            },
        );
    }
    // The four navigation entries have priority over discovery help.  At the
    // smallest supported body height there is no room for a two-row footer;
    // hiding it is safer than overlapping the last entry or clipping a pane.
    if area.height >= 9 {
        let help = if app.focus == Focus::Navigation {
            if capabilities.unicode {
                "↑↓ 选择 · Enter 打开"
            } else {
                "j/k 选择 · Enter 打开"
            }
        } else {
            "Tab 切换焦点"
        };
        frame.render_widget(
            Paragraph::new(truncate_display(
                help,
                area.width.saturating_sub(3) as usize,
            ))
            .style(Style::default().fg(MUTED).bg(BACKGROUND))
            .wrap(Wrap { trim: true }),
            Rect {
                x: area.x.saturating_add(1),
                y: area.bottom().saturating_sub(3),
                width: area.width.saturating_sub(2),
                height: 2,
            },
        );
    }
}

fn render_content(frame: &mut Frame, app: &mut App, area: Rect, capabilities: Capabilities) {
    let heading = content_heading(&app.content);
    let heading_inset = if app.focus == Focus::Content { 3 } else { 2 };
    if app.focus == Focus::Content {
        // Empty/loading/error states have no selectable row to carry focus.
        // Keep the keyboard target visible with the same restrained prefix
        // used by navigation and lyrics instead of adding another border.
        let marker = if capabilities.unicode { "›" } else { ">" };
        frame.render_widget(
            Paragraph::new(marker).style(selected_unfocused_style()),
            Rect {
                x: area.x.saturating_add(1),
                y: area.y,
                width: 1,
                height: 1,
            },
        );
    }
    frame.render_widget(
        Paragraph::new(heading).style(
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ),
        Rect {
            x: area.x.saturating_add(heading_inset),
            y: area.y,
            width: area.width.saturating_sub(heading_inset.saturating_add(2)),
            height: 1,
        },
    );

    let rows_area = Rect {
        x: area.x.saturating_add(1),
        y: area.y.saturating_add(2),
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(3),
    };
    app.set_content_viewport_rows(rows_area.height as usize);

    match &app.content {
        Content::Loading { label } => render_centered_state(frame, rows_area, label, MUTED),
        Content::Error { message } => {
            render_centered_state(frame, rows_area, &format!("{message}\n\n按 r 重试"), ERROR)
        }
        Content::NoPermission { message } => render_centered_state(
            frame,
            rows_area,
            &format!("{message}\n\nEsc 使用二维码重新登录 · r 重试"),
            WARNING,
        ),
        Content::Offline { message } => render_centered_state(
            frame,
            rows_area,
            &format!("{message}\n\n检查网络后按 r 重试"),
            WARNING,
        ),
        Content::Empty => render_centered_state(frame, rows_area, "没有可显示的内容", MUTED),
        Content::Daily { tracks } => {
            render_tracks(frame, app, rows_area, tracks, false, false, capabilities)
        }
        Content::Playlist {
            tracks,
            loading_more,
            has_more,
            ..
        } => render_tracks(
            frame,
            app,
            rows_area,
            tracks,
            *loading_more,
            *has_more,
            capabilities,
        ),
        Content::PlaylistList {
            kind: _,
            items,
            loading_more,
            has_more,
            ..
        } => render_playlists(
            frame,
            app,
            rows_area,
            items,
            *loading_more,
            *has_more,
            capabilities,
        ),
    }
}

fn content_heading(content: &Content) -> Line<'static> {
    match content {
        Content::Daily { tracks } => Line::from(vec![
            Span::raw("每日推荐"),
            Span::styled(format!("  {} 首", tracks.len()), Style::default().fg(MUTED)),
        ]),
        Content::Playlist { detail, tracks, .. } => Line::from(vec![
            Span::raw(truncate_display(&detail.name, 44)),
            Span::styled(
                format!("  {} / {} 首", tracks.len(), detail.track_count),
                Style::default().fg(MUTED),
            ),
        ]),
        Content::PlaylistList { kind, items, .. } => Line::from(vec![
            Span::raw(kind.label()),
            Span::styled(format!("  {} 个", items.len()), Style::default().fg(MUTED)),
        ]),
        _ => Line::from(content.title().to_string()),
    }
}

fn render_centered_state(frame: &mut Frame, area: Rect, message: &str, color: Color) {
    frame.render_widget(
        Paragraph::new(sanitize_multiline(message))
            .style(Style::default().fg(color).bg(BACKGROUND))
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true }),
        centered(area, area.width.saturating_sub(4), 3),
    );
}

fn render_tracks(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    tracks: &[clarus_core::Track],
    loading_more: bool,
    has_more: bool,
    capabilities: Capabilities,
) {
    if tracks.is_empty() {
        let message = if loading_more {
            "正在加载更多歌曲…"
        } else if has_more {
            "正在准备歌曲列表…"
        } else {
            "这个列表目前没有歌曲"
        };
        render_centered_state(frame, area, message, MUTED);
        return;
    }
    let viewport = area.height as usize;
    let duration_column =
        compact_duration_column(tracks, app.content_scroll, viewport, area.width as usize);
    for (row, (index, track)) in tracks
        .iter()
        .enumerate()
        .skip(app.content_scroll)
        .take(viewport)
        .enumerate()
    {
        let selected = index == app.content_index;
        let current = app.player.current.as_ref().map(|item| item.id) == Some(track.id);
        let pending = !current && app.queue.is_queued_after(track.id);
        let width = area.width as usize;
        let prefix = if current {
            if capabilities.unicode {
                "▶"
            } else {
                ">"
            }
        } else if selected {
            if capabilities.unicode {
                "›"
            } else {
                ">"
            }
        } else if pending {
            if capabilities.unicode {
                "·"
            } else {
                "."
            }
        } else {
            " "
        };
        let line = track_row_with_duration_column(
            track,
            index,
            tracks.len(),
            width,
            prefix,
            duration_column,
        );
        let style = if selected && app.focus == Focus::Content {
            selected_style()
        } else if selected {
            selected_unfocused_style()
        } else if !track.playable {
            Style::default().fg(MUTED).bg(BACKGROUND)
        } else if current {
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FOREGROUND).bg(BACKGROUND)
        };
        frame.render_widget(
            Paragraph::new(line).style(style),
            Rect {
                x: area.x,
                y: area.y.saturating_add(row as u16),
                width: area.width,
                height: 1,
            },
        );
    }
    if (loading_more || has_more) && tracks.len().saturating_sub(app.content_scroll) < viewport {
        let message = if loading_more {
            "正在加载更多歌曲…"
        } else {
            "继续向下可加载更多"
        };
        let y = area
            .y
            .saturating_add(tracks.len().saturating_sub(app.content_scroll) as u16);
        if y < area.bottom() {
            frame.render_widget(
                Paragraph::new(message).style(Style::default().fg(MUTED).bg(BACKGROUND)),
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
            );
        }
    }
}

fn render_playlists(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    items: &[clarus_core::PlaylistSummary],
    loading_more: bool,
    has_more: bool,
    capabilities: Capabilities,
) {
    if items.is_empty() && !loading_more {
        render_centered_state(frame, area, "这里还没有歌单", MUTED);
        return;
    }
    let viewport = area.height as usize;
    for (row, (index, item)) in items
        .iter()
        .enumerate()
        .skip(app.content_scroll)
        .take(viewport)
        .enumerate()
    {
        let selected = index == app.content_index;
        let prefix = if selected {
            if capabilities.unicode {
                "›"
            } else {
                ">"
            }
        } else {
            " "
        };
        let line = playlist_row(item, index, items.len(), area.width as usize, prefix);
        let style = if selected && app.focus == Focus::Content {
            selected_style()
        } else if selected {
            selected_unfocused_style()
        } else {
            Style::default().fg(FOREGROUND).bg(BACKGROUND)
        };
        frame.render_widget(
            Paragraph::new(line).style(style),
            Rect {
                x: area.x,
                y: area.y.saturating_add(row as u16),
                width: area.width,
                height: 1,
            },
        );
    }
    if (loading_more || has_more) && items.len().saturating_sub(app.content_scroll) < viewport {
        let message = if loading_more {
            "正在加载更多歌单…"
        } else {
            "继续向下可加载更多"
        };
        let y = area
            .y
            .saturating_add(items.len().saturating_sub(app.content_scroll) as u16);
        if y < area.bottom() {
            frame.render_widget(
                Paragraph::new(message).style(Style::default().fg(MUTED).bg(BACKGROUND)),
                Rect {
                    x: area.x,
                    y,
                    width: area.width,
                    height: 1,
                },
            );
        }
    }
}

fn track_column_widths(width: usize, track_count: usize) -> (usize, usize, usize) {
    let number_width = digits(track_count).max(2);
    // Prefix, compact separators, number, one duration gap, and a seven-cell
    // duration reserve. These are budgets, not padding widths: rows only use
    // the space their actual title and artist text needs. The renderer places
    // the fixed-width duration column just after the widest visible row,
    // falling back to the right edge only when long content needs the room.
    let flexible = width.saturating_sub(1 + 6 + number_width + 7);
    let name_width = if flexible < 8 {
        flexible
    } else {
        flexible.saturating_mul(3).saturating_div(5).clamp(8, 56)
    };
    let artist_width = flexible.saturating_sub(name_width).min(36);
    (number_width, name_width, artist_width)
}

#[cfg(test)]
fn track_row(
    track: &clarus_core::Track,
    index: usize,
    track_count: usize,
    width: usize,
    prefix: &str,
) -> String {
    if width == 0 {
        return String::new();
    }
    let duration_width = 7.min(width);
    track_row_with_duration_column(
        track,
        index,
        track_count,
        width,
        prefix,
        width.saturating_sub(duration_width),
    )
}

fn track_row_with_duration_column(
    track: &clarus_core::Track,
    index: usize,
    track_count: usize,
    width: usize,
    prefix: &str,
    duration_column: usize,
) -> String {
    if width == 0 {
        return String::new();
    }
    let middle = track_middle(track, index, track_count, width, prefix);
    let middle_width = UnicodeWidthStr::width(middle.as_str());
    let duration = if track.playable {
        format_time(track.duration_ms)
    } else {
        "不可".to_string()
    };
    let duration_width = UnicodeWidthStr::width(duration.as_str()).max(7).min(width);
    let last_column = width.saturating_sub(duration_width);
    let minimum_column = middle_width.saturating_add(1).min(last_column);
    let column = duration_column.clamp(minimum_column, last_column);
    let gap = column.saturating_sub(middle_width).max(1);
    let duration = pad_left_display(&duration, duration_width);
    let mut line = format!("{middle}{}{}", " ".repeat(gap), duration);
    let padding = width.saturating_sub(UnicodeWidthStr::width(line.as_str()));
    line.push_str(&" ".repeat(padding));
    line
}

fn track_middle(
    track: &clarus_core::Track,
    index: usize,
    track_count: usize,
    width: usize,
    prefix: &str,
) -> String {
    let (number_width, name_width, artist_width) = track_column_widths(width, track_count);
    let number = pad_display(&(index + 1).to_string(), number_width);
    let name = truncate_display(&track.name, name_width);
    let artist = truncate_display(&track.artist_text(), artist_width);
    let mut middle = format!("{prefix} {number}  {name}");
    if !artist.is_empty() {
        middle.push_str("  ");
        middle.push_str(&artist);
    }
    middle
}

fn compact_duration_column(
    tracks: &[clarus_core::Track],
    scroll: usize,
    viewport: usize,
    width: usize,
) -> usize {
    if width == 0 {
        return 0;
    }
    let max_middle = tracks
        .iter()
        .enumerate()
        .skip(scroll)
        .take(viewport)
        .map(|(index, track)| {
            UnicodeWidthStr::width(track_middle(track, index, tracks.len(), width, " ").as_str())
        })
        .max()
        .unwrap_or_default();
    let duration_width = 7.min(width);
    max_middle
        .saturating_add(2)
        .min(width.saturating_sub(duration_width))
}

fn playlist_row(
    item: &clarus_core::PlaylistSummary,
    index: usize,
    item_count: usize,
    width: usize,
    prefix: &str,
) -> String {
    if width == 0 {
        return String::new();
    }
    let number_width = digits(item_count).max(2);
    let detail = format!("{} 首", item.track_count);
    let detail_width = UnicodeWidthStr::width(detail.as_str());
    let name_budget = width.saturating_sub(1 + 1 + number_width + 2 + detail_width + 1);
    let number = pad_display(&(index + 1).to_string(), number_width);
    let mut middle = format!(
        "{prefix} {number}  {}",
        truncate_display(&item.name, name_budget)
    );
    let gap = width
        .saturating_sub(detail_width)
        .saturating_sub(UnicodeWidthStr::width(middle.as_str()))
        .max(1);
    middle.push_str(&" ".repeat(gap));
    middle.push_str(&detail);
    middle
}

fn digits(value: usize) -> usize {
    value.max(1).to_string().len()
}

fn render_lyrics(
    frame: &mut Frame,
    app: &mut App,
    area: Rect,
    compact: bool,
    capabilities: Capabilities,
) {
    if !compact {
        frame.render_widget(
            Block::default().borders(Borders::LEFT).border_style(
                Style::default()
                    .fg(divider_color(capabilities))
                    .bg(BACKGROUND),
            ),
            area,
        );
    }
    let x_padding = 2;
    let heading = if compact {
        "歌词 · 原文"
    } else {
        "歌词"
    };
    frame.render_widget(
        Paragraph::new(heading).style(
            Style::default()
                .fg(MUTED)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ),
        Rect {
            x: area.x.saturating_add(x_padding),
            y: area.y,
            width: area.width.saturating_sub(x_padding + 1),
            height: 1,
        },
    );
    let rows_area = Rect {
        x: area.x.saturating_add(x_padding),
        y: area.y.saturating_add(2),
        width: area.width.saturating_sub(x_padding + 2),
        height: area.height.saturating_sub(3),
    };
    let now = Instant::now();
    let active = app.lyric_index;
    let previous = app.previous_lyric_index;
    let phase = app.lyric_transition_progress(now).unwrap_or(1.0);
    let lines = wrapped_lyrics(
        app.lyrics.as_ref().map(|lyrics| lyrics.lines.as_slice()),
        active,
        rows_area.height as usize,
        rows_area.width.saturating_sub(2) as usize,
    );
    if lines.is_empty() {
        let message = match &app.lyrics {
            Some(lyrics) if lyrics.instrumental => "纯音乐，没有歌词",
            Some(_) => "暂无原文歌词",
            None if app.lyrics_error.is_some() => "歌词加载失败；切歌后可重试",
            None if app.player.current.is_some() => "正在加载歌词…",
            None => "播放歌曲后显示原文歌词",
        };
        render_centered_state(frame, rows_area, message, MUTED);
        return;
    }
    for (row, lyric) in lines.into_iter().enumerate() {
        let is_active = active == Some(lyric.index);
        let is_previous = previous == Some(lyric.index) && phase < 1.0;
        let style = if is_active {
            let gray = (176.0 + 66.0 * phase) as u8;
            let foreground = if capabilities.true_color {
                Color::Rgb(gray, gray, gray)
            } else {
                FOREGROUND
            };
            Style::default()
                .fg(foreground)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD)
        } else if is_previous {
            let gray = (160.0 * (1.0 - phase)).max(72.0) as u8;
            let foreground = if capabilities.true_color {
                Color::Rgb(gray, gray, gray)
            } else {
                MUTED
            };
            Style::default().fg(foreground).bg(BACKGROUND)
        } else {
            Style::default().fg(MUTED).bg(BACKGROUND)
        };
        let prefix = if is_active && !lyric.continuation {
            if capabilities.unicode {
                "› "
            } else {
                "> "
            }
        } else {
            "  "
        };
        frame.render_widget(
            Paragraph::new(format!("{prefix}{}", lyric.text)).style(style),
            Rect {
                x: rows_area.x,
                y: rows_area.y.saturating_add(row as u16),
                width: rows_area.width,
                height: 1,
            },
        );
    }
    frame.render_widget(
        Paragraph::new("v 隐藏歌词")
            .style(Style::default().fg(MUTED).bg(BACKGROUND))
            .alignment(Alignment::Right),
        Rect {
            x: area.x.saturating_add(1),
            y: area.bottom().saturating_sub(1),
            width: area.width.saturating_sub(2),
            height: 1,
        },
    );
}

#[derive(Debug, Clone)]
struct WrappedLyricRow {
    index: usize,
    text: String,
    continuation: bool,
}

fn wrapped_lyrics(
    lyrics: Option<&[clarus_core::LyricLine]>,
    active: Option<usize>,
    height: usize,
    width: usize,
) -> Vec<WrappedLyricRow> {
    let Some(lyrics) = lyrics else {
        return Vec::new();
    };
    if lyrics.is_empty() || height == 0 || width == 0 {
        return Vec::new();
    }

    // Only wrap the active line and the small visual neighborhood around it.
    // A dense lyric file must never be rescanned on every redraw.
    let active_index = active.unwrap_or_default().min(lyrics.len() - 1);
    let mut active_rows = lyric_rows(active_index, &lyrics[active_index].original, width);
    if active_rows.len() > height {
        let start = active_rows.len().saturating_sub(height) / 2;
        active_rows = active_rows.into_iter().skip(start).take(height).collect();
    }

    let context_rows = height.saturating_sub(active_rows.len());
    let before_budget = context_rows / 2;
    let after_budget = context_rows.saturating_sub(before_budget);
    let mut before = Vec::new();
    let mut remaining = before_budget;
    for (index, line) in lyrics.iter().enumerate().take(active_index).rev() {
        if remaining == 0 {
            break;
        }
        let rows = lyric_rows(index, &line.original, width);
        let skip = rows.len().saturating_sub(remaining);
        for row in rows.into_iter().skip(skip).rev() {
            before.insert(0, row);
        }
        remaining = before_budget.saturating_sub(before.len());
    }

    let mut after = Vec::new();
    let mut remaining = after_budget;
    for (index, line) in lyrics
        .iter()
        .enumerate()
        .skip(active_index.saturating_add(1))
    {
        if remaining == 0 {
            break;
        }
        let rows = lyric_rows(index, &line.original, width);
        after.extend(rows.into_iter().take(remaining));
        remaining = after_budget.saturating_sub(after.len());
    }

    before.extend(active_rows);
    before.extend(after);
    before
}

fn lyric_rows(index: usize, value: &str, width: usize) -> Vec<WrappedLyricRow> {
    wrap_display_text(value, width)
        .into_iter()
        .enumerate()
        .map(|(chunk_index, text)| WrappedLyricRow {
            index,
            text,
            continuation: chunk_index > 0,
        })
        .collect()
}

fn wrap_display_text(value: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let value = sanitize_inline(value);
    let mut rows = Vec::new();
    let mut current = String::new();
    let mut used = 0_usize;
    for grapheme in UnicodeSegmentation::graphemes(value.as_ref(), true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if grapheme_width > 0 && used > 0 && used.saturating_add(grapheme_width) > width {
            rows.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push_str(grapheme);
        used = used.saturating_add(grapheme_width);
    }
    if current.is_empty() {
        rows.push(String::new());
    } else {
        rows.push(current);
    }
    rows
}

fn render_player(frame: &mut Frame, app: &App, area: Rect, capabilities: Capabilities) {
    frame.render_widget(
        Block::default().borders(Borders::TOP).border_style(
            Style::default()
                .fg(if app.focus == Focus::Player {
                    FOREGROUND
                } else {
                    divider_color(capabilities)
                })
                .bg(BACKGROUND),
        ),
        area,
    );
    let main_y = area.y.saturating_add(1);
    let (title, artist) = app
        .player
        .current
        .as_ref()
        .map(|track| (track.name.as_str(), track.artist_text()))
        .unwrap_or(("尚未选择歌曲", String::new()));
    let state = if app.player.loading {
        "正在准备"
    } else if app.player.playing {
        "播放中"
    } else if app.player.current.is_some() {
        "已暂停"
    } else {
        "就绪"
    };
    let right = format!(
        "音量 {:>3}%  {:>5} / {:>5}",
        (app.player.volume * 100.0).round() as u8,
        format_time(app.player.elapsed_ms),
        format_time(app.player.duration_ms)
    );
    let title_width =
        area.width
            .saturating_sub(UnicodeWidthStr::width(right.as_str()) as u16 + 12) as usize;
    let line = Line::from(vec![
        Span::styled(
            format!("{state}  "),
            Style::default().fg(status_color(state)).bg(BACKGROUND),
        ),
        Span::styled(
            truncate_display(title, title_width),
            Style::default()
                .fg(FOREGROUND)
                .bg(BACKGROUND)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  {}", truncate_display(&artist, 24)),
            Style::default().fg(MUTED).bg(BACKGROUND),
        ),
        Span::styled(
            format!("  {right}"),
            Style::default().fg(MUTED).bg(BACKGROUND),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line),
        Rect {
            x: area.x.saturating_add(2),
            y: main_y,
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
    let progress_width = area.width.saturating_sub(4) as usize;
    let progress = progress_bar_line(
        progress_width,
        app.player.elapsed_ms,
        app.player.duration_ms,
        capabilities.unicode,
        capabilities.true_color,
    );
    frame.render_widget(
        Paragraph::new(progress.clone()),
        Rect {
            x: area.x.saturating_add(2),
            y: main_y.saturating_add(1),
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
    frame.render_widget(
        Paragraph::new(progress),
        Rect {
            x: area.x.saturating_add(2),
            y: main_y.saturating_add(2),
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
    let queue = app
        .queue
        .current_index()
        .map(|index| {
            let next = app
                .queue
                .track_at(index.saturating_add(1))
                .map(|track| truncate_display(&track.name, 18))
                .unwrap_or_else(|| "队列末尾".to_string());
            let separator = if capabilities.unicode { "·" } else { "|" };
            format!(
                "队列 {}/{} {separator} 下一首 {next}",
                index + 1,
                app.queue.len()
            )
        })
        .unwrap_or_else(|| "队列为空".to_string());
    let controls = match (app.focus, capabilities.unicode) {
        (Focus::Navigation, true) => "↑↓ 选 · Enter 开 · Tab · 1–4 · Ctrl+X",
        (Focus::Navigation, false) => "j/k 选 · Enter 开 · Tab · 1–4 · Ctrl+X",
        (Focus::Content, true) => "↑↓ 选 · Enter 播放 · Space · Tab · Ctrl+X",
        (Focus::Content, false) => "j/k 选 · Enter 播放 · Space · Tab · Ctrl+X",
        (Focus::Player, true) => "Space · ←→ ±5s · n/p · v 歌词 · Ctrl+X",
        (Focus::Player, false) => "Space · h/l ±5s · n/p · v 歌词 · Ctrl+X",
    };
    frame.render_widget(
        Paragraph::new(truncate_display(
            &format!("{queue} · {controls}"),
            area.width.saturating_sub(4) as usize,
        ))
        .style(Style::default().fg(MUTED).bg(BACKGROUND)),
        Rect {
            x: area.x.saturating_add(2),
            y: main_y.saturating_add(3),
            width: area.width.saturating_sub(4),
            height: 1,
        },
    );
}

#[cfg(test)]
fn progress_bar(width: usize, elapsed_ms: u64, duration_ms: u64, unicode: bool) -> String {
    if width == 0 {
        return String::new();
    }
    let filled = progress_filled_width(width, elapsed_ms, duration_ms);
    format!(
        "{}{}",
        if unicode { "█" } else { "#" }.repeat(filled),
        if unicode { "·" } else { "." }.repeat(width.saturating_sub(filled))
    )
}

fn progress_bar_line(
    width: usize,
    elapsed_ms: u64,
    duration_ms: u64,
    unicode: bool,
    true_color: bool,
) -> Line<'static> {
    let filled = progress_filled_width(width, elapsed_ms, duration_ms);
    let (filled_glyph, empty_glyph) = if unicode { ("█", "░") } else { ("#", ".") };
    let filled_style = Style::default().fg(FOREGROUND).bg(BACKGROUND);
    let empty_style = Style::default()
        .fg(if true_color {
            Color::Rgb(64, 64, 64)
        } else {
            MUTED
        })
        .bg(BACKGROUND);
    Line::from(vec![
        Span::styled(filled_glyph.repeat(filled), filled_style),
        Span::styled(
            empty_glyph.repeat(width.saturating_sub(filled)),
            empty_style,
        ),
    ])
}

fn progress_filled_width(width: usize, elapsed_ms: u64, duration_ms: u64) -> usize {
    if width == 0 || duration_ms == 0 {
        return 0;
    }
    ((elapsed_ms as f64 / duration_ms as f64) * width as f64)
        .round()
        .clamp(0.0, width as f64) as usize
}

fn truncate_display(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let value = sanitize_inline(value);
    if UnicodeWidthStr::width(value.as_ref()) <= width {
        return value.into_owned();
    }
    if width == 1 {
        return "…".to_string();
    }
    let mut result = String::new();
    let mut used = 0;
    for grapheme in UnicodeSegmentation::graphemes(value.as_ref(), true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used + grapheme_width + 1 > width {
            break;
        }
        result.push_str(grapheme);
        used += grapheme_width;
    }
    result.push('…');
    result
}

/// Converts untrusted single-line service text into terminal-safe text. ANSI
/// control characters are removed (horizontal whitespace becomes one space)
/// instead of being written to the crossterm backend, while ordinary Unicode
/// (including combining marks and emoji) is preserved for display-width
/// accounting.
fn sanitize_inline(value: &str) -> Cow<'_, str> {
    if !value.chars().any(char::is_control) {
        return Cow::Borrowed(value);
    }
    Cow::Owned(
        value
            .chars()
            .filter_map(|character| {
                if matches!(character, '\t' | '\n' | '\r') {
                    Some(' ')
                } else if character.is_control() {
                    None
                } else {
                    Some(character)
                }
            })
            .collect(),
    )
}

fn sanitize_multiline(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            if character == '\n' {
                Some(character)
            } else if matches!(character, '\t' | '\r') {
                Some(' ')
            } else if character.is_control() {
                None
            } else {
                Some(character)
            }
        })
        .collect()
}

fn pad_display(value: &str, width: usize) -> String {
    let value = truncate_display(value, width);
    let padding = width.saturating_sub(UnicodeWidthStr::width(value.as_str()));
    format!("{value}{}", " ".repeat(padding))
}

fn pad_left_display(value: &str, width: usize) -> String {
    let value = truncate_display(value, width);
    let padding = width.saturating_sub(UnicodeWidthStr::width(value.as_str()));
    format!("{}{}", " ".repeat(padding), value)
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x.saturating_add(area.width.saturating_sub(width) / 2),
        y: area
            .y
            .saturating_add(area.height.saturating_sub(height) / 2),
        width,
        height,
    }
}

fn base_style() -> Style {
    Style::default().fg(FOREGROUND).bg(BACKGROUND)
}

fn divider_color(capabilities: Capabilities) -> Color {
    if capabilities.true_color {
        Color::Rgb(38, 38, 38)
    } else {
        Color::DarkGray
    }
}

fn selected_style() -> Style {
    Style::default()
        .fg(BACKGROUND)
        .bg(FOREGROUND)
        .add_modifier(Modifier::BOLD)
}

fn selected_unfocused_style() -> Style {
    Style::default()
        .fg(FOREGROUND)
        .bg(BACKGROUND)
        .add_modifier(Modifier::BOLD)
}

fn status_color(status: &str) -> Color {
    if status.contains("失败")
        || status.contains("无法")
        || status.contains("错误")
        || status.contains("不可")
    {
        ERROR
    } else if status.contains("等待")
        || status.contains("加载")
        || status.contains("准备")
        || status.contains("扫描")
    {
        WARNING
    } else if status.contains("成功")
        || status.contains("播放中")
        || status.contains("正在播放")
        || status.contains("已恢复")
        || status.contains("已加载")
    {
        SUCCESS
    } else {
        MUTED
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use clarus_core::{
        Album, Artist, AuthUser, LyricLine, MusicCore, PlaylistSummary, Track, TrackLyrics,
    };
    use ratatui::{backend::TestBackend, style::Color, Terminal};
    use tokio::sync::mpsc;
    use unicode_width::UnicodeWidthStr;

    use crate::app::{App, AuthState, Content, Focus};

    use super::{
        compact_duration_column, playlist_row, progress_bar, render, sanitize_inline,
        sanitize_multiline, track_column_widths, track_middle, track_row,
        track_row_with_duration_column, truncate_display, wrap_display_text, Capabilities,
    };

    fn test_track(id: i64) -> Track {
        Track {
            id,
            name: format!("track-{id}"),
            duration_ms: 120_000,
            artists: vec![Artist {
                id: 1,
                name: "artist".to_string(),
            }],
            album: Album {
                id: 1,
                name: "album".to_string(),
            },
            aliases: Vec::new(),
            translated_names: Vec::new(),
            explicit: false,
            playable: true,
            unavailable_reason: None,
        }
    }

    #[test]
    fn c_and_posix_locales_use_the_ascii_capability_fallback() {
        use std::ffi::OsStr;

        assert!(super::locale_supports_unicode(None));
        assert!(super::locale_supports_unicode(Some(OsStr::new(
            "en_US.UTF-8"
        ))));
        assert!(!super::locale_supports_unicode(Some(OsStr::new("C"))));
        assert!(!super::locale_supports_unicode(Some(OsStr::new("POSIX"))));
        assert!(!super::locale_supports_unicode(Some(OsStr::new(
            "C.ISO8859-1"
        ))));
    }

    #[test]
    fn truncation_uses_terminal_display_width() {
        let value = truncate_display("每日推荐 / A very long title", 10);
        assert!(UnicodeWidthStr::width(value.as_str()) <= 10);
        let cjk = truncate_display("周杰伦 - 晴天", 8);
        assert!(UnicodeWidthStr::width(cjk.as_str()) <= 8);
    }

    #[test]
    fn terminal_text_replaces_control_sequences_without_losing_unicode() {
        let inline = sanitize_inline("中文\u{1b}[31m歌曲\t名");
        assert_eq!(inline, "中文[31m歌曲 名");
        assert!(!inline.chars().any(char::is_control));

        let multiline = sanitize_multiline("第一行\n第二\u{7f}行");
        assert_eq!(multiline, "第一行\n第二行");
    }

    #[test]
    fn wide_character_continuation_keeps_the_selected_style() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        let mut track = test_track(1);
        track.name = "中文".to_string();
        app.content = Content::Daily {
            tracks: vec![track],
        };
        app.focus = Focus::Content;

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut selected_continuation_bg = None;
        terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: true,
                        true_color: true,
                    },
                );
                let buffer = &*frame.buffer_mut();
                let (x, y) = buffer
                    .content()
                    .iter()
                    .enumerate()
                    .find_map(|(index, cell)| {
                        (cell.symbol() == "中")
                            .then_some(((index % 80) as u16, (index / 80) as u16))
                    })
                    .expect("the selected CJK title should be rendered");
                selected_continuation_bg = Some(buffer[(x + 1, y)].bg);
            })
            .unwrap();
        assert_eq!(selected_continuation_bg, Some(Color::White));
    }

    #[test]
    fn progress_bar_has_a_stable_width() {
        assert_eq!(
            UnicodeWidthStr::width(progress_bar(12, 50, 100, true).as_str()),
            12
        );
        assert_eq!(
            UnicodeWidthStr::width(progress_bar(12, 50, 100, false).as_str()),
            12
        );
    }

    #[test]
    fn track_columns_fit_the_narrowest_supported_content_pane() {
        for width in 34..=160 {
            let (number, name, artist) = track_column_widths(width, 100);
            let row_width = 1 + 4 + number + name + artist + 7;
            assert!(
                row_width <= width,
                "track row width {row_width} exceeded pane width {width}"
            );
        }
    }

    #[test]
    fn track_rows_keep_numbers_left_aligned_and_duration_visible() {
        let mut first = test_track(1);
        first.name = "短标题".to_string();
        first.artists[0].name = "艺人".to_string();
        let mut second = first.clone();
        second.id = 2;
        second.name = "这是一个很长但仍然应该尽量完整显示的歌曲标题".to_string();
        let first_row = track_row(&first, 0, 99, 72, " ");
        let second_row = track_row(&second, 8, 99, 72, " ");
        assert_eq!(UnicodeWidthStr::width(first_row.as_str()), 72);
        assert_eq!(UnicodeWidthStr::width(second_row.as_str()), 72);
        assert!(first_row.starts_with("  1 "));
        assert!(second_row.starts_with("  9 "));
        assert!(first_row.ends_with("2:00"));
        assert!(second_row.ends_with("2:00"));
        assert!(!first_row.contains("..."));
    }

    #[test]
    fn long_track_durations_keep_a_real_duration_column_instead_of_ellipsis() {
        let mut track = test_track(1);
        // The feedback screenshot included multi-hour playlist durations
        // rendered as dots. Their duration column must grow before title or
        // artist text is considered for truncation.
        track.duration_ms = 63_000_000; // 1050:00
        let row = track_row(&track, 0, 32, 72, " ");
        assert_eq!(UnicodeWidthStr::width(row.as_str()), 72);
        assert!(row.ends_with("1050:00"));
        assert!(!row.contains('…'));
    }

    #[test]
    fn visible_track_rows_place_duration_after_content_without_a_large_gap() {
        let first = test_track(1);
        let second = test_track(2);
        let tracks = vec![first.clone(), second];
        let width = 72;
        let column = compact_duration_column(&tracks, 0, 2, width);
        let middle_width = UnicodeWidthStr::width(track_middle(&first, 0, 2, width, " ").as_str());
        assert_eq!(column, middle_width + 2);

        let row = track_row_with_duration_column(&first, 0, 2, width, " ", column);
        assert_eq!(UnicodeWidthStr::width(row.as_str()), width);
        assert!(row[middle_width..].starts_with("  "));
        assert!(row[middle_width + 2..].contains("2:00"));
    }

    #[test]
    fn playlist_rows_are_compact_and_right_align_counts() {
        let item = PlaylistSummary {
            id: 1,
            name: "短歌单".to_string(),
            creator_id: 7,
            creator_name: "owner".to_string(),
            track_count: 32,
            owned: false,
            subscribed: true,
            liked: false,
        };
        let row = playlist_row(&item, 0, 32, 72, " ");
        assert_eq!(UnicodeWidthStr::width(row.as_str()), 72);
        assert!(row.starts_with("  1 "));
        assert!(row.ends_with("32 首"));
        assert!(!row.contains("…"));
    }

    #[test]
    fn lyric_wrap_preserves_wide_text_without_ellipsis() {
        let value = "这是一个不会被省略的歌词";
        let rows = wrap_display_text(value, 8);
        assert!(rows.len() > 1);
        assert_eq!(rows.concat(), value);
        assert!(rows
            .iter()
            .all(|row| UnicodeWidthStr::width(row.as_str()) <= 8));
    }

    #[test]
    fn lyric_wrap_handles_cjk_emoji_and_combining_widths() {
        let value = "A\u{030A} 🐈 中文";
        let rows = wrap_display_text(value, 4);
        assert_eq!(rows.concat(), value);
        assert!(rows
            .iter()
            .all(|row| UnicodeWidthStr::width(row.as_str()) <= 4));
    }

    #[test]
    fn wrapping_and_truncation_do_not_split_zwj_emoji_clusters() {
        let family = "👨\u{200d}👩\u{200d}👧\u{200d}👦";
        let value = format!("A{family}B");
        let rows = wrap_display_text(&value, 2);
        assert_eq!(rows.concat(), value);
        assert!(rows.iter().any(|row| row == family));
        assert!(rows
            .iter()
            .all(|row| !row.contains('\u{200d}') || row.contains(family)));

        let truncated = truncate_display(&value, 4);
        assert!(truncated.contains(family));
        assert!(
            !truncated.contains('\u{200d}') || truncated.contains(family),
            "a truncation may omit a grapheme but must never retain only part of it"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn compact_layout_renders_inside_80_by_24() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Empty;
        app.focus = Focus::Content;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let completed = terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: true,
                        true_color: true,
                    },
                )
            })
            .unwrap();
        assert_eq!(completed.buffer.area().width, 80);
        assert_eq!(completed.buffer.area().height, 24);
        if let Some((index, cell)) = completed
            .buffer
            .content()
            .iter()
            .enumerate()
            .find(|(_, cell)| cell.bg != Color::Black)
        {
            panic!("cell {index} did not keep the pure-black background: {cell:?}");
        }
        assert!(completed
            .buffer
            .content()
            .iter()
            .any(|cell| cell.symbol() == "›"));
    }

    #[test]
    fn ansi_fallback_renders_populated_layout_inside_80_by_24() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: vec![test_track(1)],
        };
        app.focus = Focus::Content;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: false,
                        true_color: false,
                    },
                )
            })
            .unwrap();
        assert_eq!(terminal.backend().buffer().area().width, 80);
        assert_eq!(terminal.backend().buffer().area().height, 24);
        assert!(app.hit_areas.content.right() <= 80);
        assert!(app.hit_areas.content.bottom() <= 24);
        assert!(terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .any(|cell| cell.symbol() == ">"));
    }

    #[test]
    fn resize_keeps_selection_and_scroll_in_the_visible_range() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: (1..=20).map(test_track).collect(),
        };
        app.focus = Focus::Content;
        app.content_index = 10;
        app.content_scroll = 8;

        for (width, height) in [(160, 50), (80, 24)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal
                .draw(|frame| {
                    render(
                        frame,
                        &mut app,
                        Capabilities {
                            unicode: true,
                            true_color: true,
                        },
                    )
                })
                .unwrap();
            assert_eq!(app.content_index, 10);
            assert!(app.content_scroll <= app.content_index);
        }
    }

    #[test]
    fn documented_resize_sizes_render_without_panels_overflowing() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Empty;

        for (width, height) in [(52, 13), (80, 24), (120, 40), (160, 50)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal
                .draw(|frame| {
                    render(
                        frame,
                        &mut app,
                        Capabilities {
                            unicode: true,
                            true_color: true,
                        },
                    )
                })
                .unwrap();
            assert_eq!(terminal.backend().buffer().area().width, width);
            assert_eq!(terminal.backend().buffer().area().height, height);
        }
    }

    #[test]
    fn populated_resize_sweep_keeps_focus_and_panes_valid() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        let mut tracks = (1..=40).map(test_track).collect::<Vec<_>>();
        tracks[0].name = "一首包含中文、emoji 🐈 和很长标题的歌曲".to_string();
        app.content = Content::Daily { tracks };
        app.player.current = app.content.track_at(0).cloned();
        app.lyrics = Some(TrackLyrics {
            instrumental: false,
            lines: (0..24)
                .map(|index| LyricLine {
                    time_ms: index * 4_000,
                    original: format!(
                        "第 {index} 行歌词：这是一段需要在窄 pane 中安全换行的中文文本"
                    ),
                })
                .collect(),
        });
        app.lyric_index = Some(6);
        app.focus = Focus::Content;

        for width in (52..=180).step_by(4) {
            for height in [13, 24, 40, 50] {
                let backend = TestBackend::new(width, height);
                let mut terminal = Terminal::new(backend).unwrap();
                terminal
                    .draw(|frame| {
                        render(
                            frame,
                            &mut app,
                            Capabilities {
                                unicode: true,
                                true_color: true,
                            },
                        )
                    })
                    .unwrap();

                let body = app.hit_areas.body;
                assert!(body.right() <= width);
                assert!(body.bottom() <= height);
                assert!(app.hit_areas.navigation.right() <= width);
                assert!(app.hit_areas.content.right() <= width);
                assert!(app.content_index < app.content.len());
                if app.lyrics_only {
                    assert_ne!(app.focus, Focus::Content);
                }
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wide_layout_exposes_both_resizable_dividers() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: vec![test_track(1)],
        };
        app.player.current = Some(test_track(1));
        let backend = TestBackend::new(132, 47);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: true,
                        true_color: true,
                    },
                )
            })
            .unwrap();
        assert_eq!(app.hit_areas.sidebar_divider.width, 1);
        assert_eq!(app.hit_areas.lyrics_divider.width, 1);
        assert!(app.hit_areas.content.width >= 34);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn library_does_not_reserve_lyrics_before_playback() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: vec![test_track(1)],
        };
        let backend = TestBackend::new(132, 47);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: true,
                        true_color: true,
                    },
                )
            })
            .unwrap();

        assert_eq!(app.hit_areas.lyrics_divider.width, 0);
        assert_eq!(app.hit_areas.content.width, 112);
    }

    #[test]
    fn narrow_lyrics_mode_never_leaves_focus_on_the_hidden_list() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = AuthState::Authenticated(AuthUser {
            user_id: 1,
            nickname: "测试用户".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: vec![test_track(1)],
        };
        app.player.current = Some(test_track(1));
        app.focus = Focus::Content;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                render(
                    frame,
                    &mut app,
                    Capabilities {
                        unicode: true,
                        true_color: true,
                    },
                )
            })
            .unwrap();

        assert!(app.lyrics_only);
        assert_eq!(app.focus, Focus::Player);
    }
}
