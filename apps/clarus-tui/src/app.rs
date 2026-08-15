use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::{Duration, Instant},
};

use clarus_core::{
    AuthSession, AuthUser, CachedAudio, CoreError, DailySongs, MusicCore, PlaybackQueue,
    PlaylistDetail, PlaylistPage, PlaylistScope, PlaylistSummary, QrLogin, QrLoginCheck,
    QrLoginStatus, QueueSource, RequestCancellation, SmsLogin, StreamSource, Track, TrackLyrics,
};
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use tokio::{sync::mpsc, task::JoinHandle};

use crate::audio::{AudioSnapshot, NativePlayer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavItem {
    Daily,
    Liked,
    Saved,
    Created,
}

impl NavItem {
    pub const ALL: [Self; 4] = [Self::Daily, Self::Liked, Self::Saved, Self::Created];

    pub fn label(self) -> &'static str {
        match self {
            Self::Daily => "每日推荐",
            Self::Liked => "我最喜欢",
            Self::Saved => "收藏的歌单",
            Self::Created => "创建的歌单",
        }
    }

    pub fn number(self) -> char {
        match self {
            Self::Daily => '1',
            Self::Liked => '2',
            Self::Saved => '3',
            Self::Created => '4',
        }
    }

    fn from_number(value: char) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.number() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaylistKind {
    Saved,
    Created,
}

impl PlaylistKind {
    fn from_nav(item: NavItem) -> Option<Self> {
        match item {
            NavItem::Saved => Some(Self::Saved),
            NavItem::Created => Some(Self::Created),
            NavItem::Daily | NavItem::Liked => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Saved => "收藏的歌单",
            Self::Created => "创建的歌单",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Navigation,
    Content,
    Player,
}

impl Focus {
    fn next(self, lyrics_only: bool) -> Self {
        if lyrics_only {
            // A narrow terminal replaces the content list with the lyrics
            // pane. Lyrics themselves never own keyboard focus, and the
            // hidden list must not become a tab stop while that fallback is
            // active.
            return match self {
                Self::Navigation | Self::Content => Self::Player,
                Self::Player => Self::Navigation,
            };
        }
        match self {
            Self::Navigation => Self::Content,
            Self::Content => Self::Player,
            Self::Player => Self::Navigation,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Navigation,
    PhoneNumber,
    Captcha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginField {
    PhoneNumber,
    Captcha,
}

impl LoginField {
    fn next(self, captcha_sent: bool) -> Self {
        if !captcha_sent {
            return Self::PhoneNumber;
        }
        match self {
            Self::PhoneNumber => Self::Captcha,
            Self::Captcha => Self::PhoneNumber,
        }
    }

    fn input_mode(self) -> InputMode {
        match self {
            Self::PhoneNumber => InputMode::PhoneNumber,
            Self::Captcha => InputMode::Captcha,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneLogin {
    pub phone: String,
    pub captcha: String,
    pub field: LoginField,
    pub captcha_sent: bool,
    pub sending: bool,
    pub authenticating: bool,
    pub resend_available_at: Option<Instant>,
    pub status: String,
}

impl PhoneLogin {
    #[allow(dead_code)] // Retained SMS flow; no public TUI route constructs it.
    fn new(status: impl Into<String>) -> Self {
        Self {
            phone: String::new(),
            captcha: String::new(),
            field: LoginField::PhoneNumber,
            captcha_sent: false,
            sending: false,
            authenticating: false,
            resend_available_at: None,
            status: status.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaneDrag {
    Sidebar,
    Lyrics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingContentPosition {
    index: usize,
    scroll: usize,
    selected_id: Option<i64>,
}

/// The playlist-list state immediately before opening one of its entries.
///
/// Returning from a detail view is a presentation transition, not a refresh of
/// the parent list. Keeping this small snapshot avoids a network request and,
/// more importantly, preserves the listener's selected playlist and scroll
/// position exactly where they left them.
#[derive(Debug, Clone)]
struct PlaylistReturn {
    content: Content,
    index: usize,
    scroll: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Home,
    Playlist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    Restoring,
    /// The only interactive login screen reachable from the TUI.
    QrLogin {
        qr: Option<QrLogin>,
        status: String,
        checking: bool,
    },
    /// Retained for the SMS implementation and its isolated tests. The binary
    /// does not create this state from a flag, shortcut, or login UI route.
    #[allow(dead_code)]
    Login {
        form: PhoneLogin,
    },
    Authenticated(AuthUser),
    #[allow(dead_code)]
    Failed(String),
}

#[derive(Debug, Clone)]
pub enum Content {
    Empty,
    Loading {
        label: String,
    },
    Error {
        message: String,
    },
    NoPermission {
        message: String,
    },
    Offline {
        message: String,
    },
    Daily {
        tracks: Vec<Track>,
    },
    PlaylistList {
        kind: PlaylistKind,
        items: Vec<PlaylistSummary>,
        next_offset: u64,
        has_more: bool,
        loading_more: bool,
    },
    Playlist {
        detail: PlaylistDetail,
        tracks: Vec<Track>,
        next_offset: u64,
        has_more: bool,
        loading_more: bool,
    },
}

impl Content {
    pub fn title(&self) -> &str {
        match self {
            Self::Empty => "音乐库",
            Self::Loading { label } => label,
            Self::Error { .. } => "无法加载",
            Self::NoPermission { .. } => "需要登录",
            Self::Offline { .. } => "网络不可用",
            Self::Daily { .. } => "每日推荐",
            Self::PlaylistList { kind, .. } => kind.label(),
            Self::Playlist { detail, .. } => detail.name.as_str(),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Self::Daily { tracks } => tracks.len(),
            Self::PlaylistList { items, .. } => items.len(),
            Self::Playlist { tracks, .. } => tracks.len(),
            Self::Empty
            | Self::Loading { .. }
            | Self::Error { .. }
            | Self::NoPermission { .. }
            | Self::Offline { .. } => 0,
        }
    }

    pub fn track_at(&self, index: usize) -> Option<&Track> {
        match self {
            Self::Daily { tracks } | Self::Playlist { tracks, .. } => tracks.get(index),
            _ => None,
        }
    }

    pub fn tracks(&self) -> Option<&[Track]> {
        match self {
            Self::Daily { tracks } | Self::Playlist { tracks, .. } => Some(tracks),
            _ => None,
        }
    }

    pub fn playlist_at(&self, index: usize) -> Option<&PlaylistSummary> {
        match self {
            Self::PlaylistList { items, .. } => items.get(index),
            _ => None,
        }
    }

    pub fn has_more(&self) -> bool {
        match self {
            Self::PlaylistList { has_more, .. } | Self::Playlist { has_more, .. } => *has_more,
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub current: Option<Track>,
    pub source: Option<StreamSource>,
    pub elapsed_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
    pub loading: bool,
    pub error: Option<String>,
    pub volume: f32,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            current: None,
            source: None,
            elapsed_ms: 0,
            duration_ms: 0,
            playing: false,
            loading: false,
            error: None,
            volume: 0.8,
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct HitAreas {
    pub body: Rect,
    pub navigation: Rect,
    pub content: Rect,
    pub sidebar_divider: Rect,
    pub lyrics_divider: Rect,
}

pub enum Message {
    Session {
        generation: u64,
        result: Result<AuthSession, CoreError>,
    },
    Qr {
        generation: u64,
        result: Result<QrLogin, CoreError>,
    },
    QrCheck {
        generation: u64,
        result: Result<QrLoginCheck, CoreError>,
    },
    CaptchaSent {
        generation: u64,
        result: Result<(), CoreError>,
    },
    SmsLogin {
        generation: u64,
        result: Result<SmsLogin, CoreError>,
    },
    Daily {
        generation: u64,
        result: Result<DailySongs, CoreError>,
    },
    Liked {
        generation: u64,
        result: Result<PlaylistDetail, CoreError>,
    },
    PlaylistPage {
        generation: u64,
        kind: PlaylistKind,
        page: bool,
        result: Result<PlaylistPage, CoreError>,
    },
    PlaylistDetail {
        generation: u64,
        result: Result<PlaylistDetail, CoreError>,
    },
    TrackPage {
        generation: u64,
        result: Result<clarus_core::PlaylistTrackPage, CoreError>,
    },
    Lyrics {
        generation: u64,
        track_id: i64,
        result: Result<TrackLyrics, CoreError>,
    },
    Stream {
        generation: u64,
        track: Track,
        result: Result<StreamSource, CoreError>,
    },
    CachedAudio {
        generation: u64,
        track: Track,
        result: Result<CachedAudio, CoreError>,
    },
    AudioLoaded {
        generation: u64,
        track: Track,
        cache_hit: bool,
        audio: NativePlayer,
        result: Result<AudioSnapshot, String>,
    },
}

pub struct App {
    core: Arc<MusicCore>,
    tx: mpsc::Sender<Message>,
    pub auth: AuthState,
    pub nav: NavItem,
    pub focus: Focus,
    pub input_mode: InputMode,
    pub screen: Screen,
    pub content: Content,
    pub content_index: usize,
    pub content_scroll: usize,
    pub player: PlayerState,
    pub queue: PlaybackQueue,
    pub lyrics: Option<TrackLyrics>,
    pub lyrics_error: Option<String>,
    pub lyric_index: Option<usize>,
    pub previous_lyric_index: Option<usize>,
    pub lyrics_visible: bool,
    /// True when a narrow terminal has replaced the content list with the
    /// lyrics pane.  The list remains in state so switching back preserves
    /// the user's position, but it must not receive navigation actions while
    /// it is not visible.
    pub lyrics_only: bool,
    pub status: String,
    pub hit_areas: HitAreas,
    pub lyric_transition_until: Option<Instant>,
    lyric_transition_started: Option<Instant>,
    content_viewport_rows: usize,
    last_progress_update: Instant,
    last_scroll_event: Option<Instant>,
    last_input_changed: bool,
    pane_drag: Option<PaneDrag>,
    pub sidebar_width: u16,
    pub lyrics_width: u16,
    content_generation: u64,
    lyrics_generation: u64,
    playback_generation: u64,
    pending_queue_next: bool,
    track_page_empty_probes: u8,
    playlist_page_empty_probes: u8,
    session_cancellation: Option<RequestCancellation>,
    content_cancellation: Option<RequestCancellation>,
    lyrics_cancellation: Option<RequestCancellation>,
    stream_cancellation: Option<RequestCancellation>,
    cache_cancellation: Option<RequestCancellation>,
    audio_cancellation: Option<RequestCancellation>,
    qr_cancellation: Option<RequestCancellation>,
    auth_cancellation: Option<RequestCancellation>,
    next_qr_check: Instant,
    qr_expires_at: Option<Instant>,
    session_generation: u64,
    qr_generation: u64,
    auth_generation: u64,
    pending_content_position: Option<PendingContentPosition>,
    playlist_return: Option<PlaylistReturn>,
    pending_auth_notice: Option<String>,
    session_task: Option<JoinHandle<()>>,
    content_task: Option<JoinHandle<()>>,
    lyrics_task: Option<JoinHandle<()>>,
    stream_task: Option<JoinHandle<()>>,
    cache_task: Option<JoinHandle<()>>,
    audio_task: Option<JoinHandle<()>>,
    qr_task: Option<JoinHandle<()>>,
    auth_task: Option<JoinHandle<()>>,
    audio: NativePlayer,
    /// `spawn_blocking` cannot interrupt an OS audio/device call once it has
    /// entered it. Serialize those calls and let stale generations leave
    /// before taking the lock, so rapid skips never create competing decoder
    /// owners or a growing pile of waiting audio workers.
    audio_prepare_lock: Arc<std::sync::Mutex<()>>,
    audio_prepare_generation: Arc<AtomicU64>,
}

const TRACKPAD_SCROLL_INTERVAL: Duration = Duration::from_millis(120);
const QR_VALIDITY: Duration = Duration::from_secs(180);
const SMS_RESEND_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_PHONE_DIGITS: usize = 15;
const MAX_CAPTCHA_DIGITS: usize = 8;

impl App {
    pub fn new(core: Arc<MusicCore>, tx: mpsc::Sender<Message>) -> Self {
        let mut app = Self::initial(core, tx);
        // The TUI has its own Keychain item rather than sharing the desktop
        // client's ACL-protected item. Restore it once, then fall back to QR.
        app.restore_session();
        app
    }

    /// Retained for internal SMS-flow coverage. The binary deliberately has
    /// no public option or key path that calls this constructor.
    #[allow(dead_code)]
    pub fn new_for_phone_login(core: Arc<MusicCore>, tx: mpsc::Sender<Message>) -> Self {
        let mut app = Self::initial(core, tx);
        app.begin_phone_login();
        app
    }

    fn initial(core: Arc<MusicCore>, tx: mpsc::Sender<Message>) -> Self {
        Self {
            core,
            tx,
            auth: AuthState::Restoring,
            nav: NavItem::Daily,
            focus: Focus::Navigation,
            input_mode: InputMode::Navigation,
            screen: Screen::Home,
            content: Content::Loading {
                label: "正在恢复登录状态…".to_string(),
            },
            content_index: 0,
            content_scroll: 0,
            player: PlayerState::default(),
            queue: PlaybackQueue::default(),
            lyrics: None,
            lyrics_error: None,
            lyric_index: None,
            previous_lyric_index: None,
            lyrics_visible: true,
            lyrics_only: false,
            status: "正在恢复登录状态…".to_string(),
            hit_areas: HitAreas::default(),
            lyric_transition_until: None,
            lyric_transition_started: None,
            content_viewport_rows: 12,
            last_progress_update: Instant::now(),
            last_scroll_event: None,
            last_input_changed: false,
            pane_drag: None,
            sidebar_width: 20,
            lyrics_width: 34,
            content_generation: 0,
            lyrics_generation: 0,
            playback_generation: 0,
            pending_queue_next: false,
            track_page_empty_probes: 0,
            playlist_page_empty_probes: 0,
            session_cancellation: None,
            content_cancellation: None,
            lyrics_cancellation: None,
            stream_cancellation: None,
            cache_cancellation: None,
            audio_cancellation: None,
            qr_cancellation: None,
            auth_cancellation: None,
            next_qr_check: Instant::now(),
            qr_expires_at: None,
            session_generation: 0,
            qr_generation: 0,
            auth_generation: 0,
            pending_content_position: None,
            playlist_return: None,
            pending_auth_notice: None,
            session_task: None,
            content_task: None,
            lyrics_task: None,
            stream_task: None,
            cache_task: None,
            audio_task: None,
            qr_task: None,
            auth_task: None,
            audio: NativePlayer::default(),
            audio_prepare_lock: Arc::new(std::sync::Mutex::new(())),
            audio_prepare_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    #[cfg(test)]
    pub fn new_for_test(core: Arc<MusicCore>, tx: mpsc::Sender<Message>) -> Self {
        Self::initial(core, tx)
    }

    pub fn set_hit_areas(&mut self, hit_areas: HitAreas) {
        self.hit_areas = hit_areas;
    }

    pub fn set_content_viewport_rows(&mut self, rows: usize) {
        self.content_viewport_rows = rows.max(1);
        self.keep_selection_visible(self.content_viewport_rows);
    }

    pub fn set_lyrics_only(&mut self, lyrics_only: bool) {
        self.lyrics_only = lyrics_only;
    }

    pub fn tick(&mut self, now: Instant) -> bool {
        let mut changed = false;
        if self
            .lyric_transition_until
            .is_some_and(|until| now >= until)
        {
            self.lyric_transition_until = None;
            self.lyric_transition_started = None;
            self.previous_lyric_index = None;
            changed = true;
        }
        let lyric_due = self
            .lyric_wake_after()
            .is_some_and(|remaining| remaining <= Duration::from_millis(1));
        if self.player.playing
            && !self.player.loading
            && self.player.current.is_some()
            && (now.saturating_duration_since(self.last_progress_update)
                >= Duration::from_millis(250)
                || lyric_due)
        {
            self.last_progress_update = now;
            let snapshot = self.audio.snapshot();
            if snapshot.position_ms != self.player.elapsed_ms {
                self.player.elapsed_ms = snapshot.position_ms;
                self.sync_lyric_to_progress();
                changed = true;
            }
            if snapshot.duration_ms > 0 && snapshot.duration_ms != self.player.duration_ms {
                self.player.duration_ms = snapshot.duration_ms;
                changed = true;
            }
            if self.audio.has_finished() {
                self.player.playing = false;
                self.status = "当前歌曲播放结束".to_string();
                self.next_track();
                changed = true;
            } else if snapshot.playing != self.player.playing {
                self.player.playing = snapshot.playing;
                changed = true;
            }
        }
        if self.update_sms_resend_status(now) {
            changed = true;
        }
        if self
            .qr_expires_at
            .is_some_and(|expires_at| now >= expires_at)
        {
            self.expire_qr();
            changed = true;
        } else if self.update_qr_countdown(now) {
            changed = true;
        }
        let needs_qr_poll = matches!(
            self.auth,
            AuthState::QrLogin {
                qr: Some(_),
                checking: false,
                ..
            }
        ) && now >= self.next_qr_check;
        if needs_qr_poll {
            self.check_qr();
            changed = true;
        }
        changed
    }

    pub fn wants_animation(&self) -> bool {
        self.lyric_transition_until
            .is_some_and(|until| until > Instant::now())
    }

    pub fn next_wake_after(&self, now: Instant, high_rate_animation: bool) -> Duration {
        let mut next = Duration::from_secs(60);
        if let Some(until) = self.lyric_transition_until.filter(|until| *until > now) {
            let frame_budget = if high_rate_animation {
                Duration::from_micros(8_333)
            } else {
                // A capability-limited terminal still needs one bounded
                // wake-up to retire the transition; it never gets a busy
                // 120Hz loop when true color is unavailable.
                Duration::from_millis(50)
            };
            next = next.min(frame_budget.min(until.saturating_duration_since(now)));
        }
        if self.player.playing && !self.player.loading {
            let deadline = self.last_progress_update + Duration::from_millis(250);
            next = next.min(deadline.saturating_duration_since(now));
            if let Some(lyric_wait) = self.lyric_wake_after() {
                next = next.min(lyric_wait.max(Duration::from_millis(1)));
            }
        }
        if let AuthState::Login { form } = &self.auth {
            if let Some(available_at) = form.resend_available_at {
                let until_update = available_at.saturating_duration_since(now);
                next = next.min(until_update.min(Duration::from_secs(1)));
            }
        }
        if matches!(
            self.auth,
            AuthState::QrLogin {
                qr: Some(_),
                checking: false,
                ..
            }
        ) {
            next = next.min(self.next_qr_check.saturating_duration_since(now));
        }
        if let Some(expires_at) = self.qr_expires_at {
            next = next.min(expires_at.saturating_duration_since(now));
        }
        next
    }

    pub fn lyric_transition_progress(&self, now: Instant) -> Option<f32> {
        let start = self.lyric_transition_started?;
        let end = self.lyric_transition_until?;
        let span = end.saturating_duration_since(start).as_secs_f32();
        (span > 0.0)
            .then(|| (now.saturating_duration_since(start).as_secs_f32() / span).clamp(0.0, 1.0))
    }

    pub fn handle_message(&mut self, message: Message) {
        match message {
            Message::Session { generation, result } => {
                if generation != self.session_generation {
                    return;
                }
                self.session_task = None;
                self.session_cancellation = None;
                match result {
                    Ok(session) if session.authenticated => {
                        let Some(user) = session.user else {
                            self.begin_qr();
                            return;
                        };
                        self.qr_expires_at = None;
                        self.auth = AuthState::Authenticated(user);
                        self.input_mode = InputMode::Navigation;
                        self.status = self
                            .pending_auth_notice
                            .take()
                            .unwrap_or_else(|| "已恢复登录状态".to_string());
                        self.open_nav(NavItem::Daily);
                    }
                    Ok(_) | Err(_) => self.begin_qr(),
                }
            }
            Message::Qr { generation, result } => {
                if generation != self.qr_generation {
                    return;
                }
                self.qr_task = None;
                self.qr_cancellation = None;
                match result {
                    Ok(qr) => {
                        self.qr_expires_at = Some(Instant::now() + QR_VALIDITY);
                        self.auth = AuthState::QrLogin {
                            qr: Some(qr),
                            status: "请使用网易云音乐扫描二维码".to_string(),
                            checking: false,
                        };
                        self.input_mode = InputMode::Navigation;
                        self.content = Content::Empty;
                        self.status = "等待二维码扫描".to_string();
                        self.next_qr_check = Instant::now() + Duration::from_millis(700);
                    }
                    Err(error) => {
                        self.qr_expires_at = None;
                        self.auth = AuthState::QrLogin {
                            qr: None,
                            status: format!("二维码加载失败：{error}"),
                            checking: false,
                        };
                        self.input_mode = InputMode::Navigation;
                        self.status = "按 r 或 Enter 重试二维码登录".to_string();
                    }
                }
            }
            Message::QrCheck { generation, result } => {
                if generation != self.qr_generation {
                    return;
                }
                if self
                    .qr_expires_at
                    .is_some_and(|expires_at| Instant::now() >= expires_at)
                {
                    self.expire_qr();
                    return;
                }
                self.qr_task = None;
                self.qr_cancellation = None;
                match result {
                    Ok(check) => match check.status {
                        QrLoginStatus::Authorized => {
                            self.qr_expires_at = None;
                            self.pending_auth_notice = check
                                .message
                                .contains("本次登录态仅在当前运行内有效")
                                .then_some("已登录；本次登录态未能保存到系统 Keychain".to_string());
                            self.status = if self.pending_auth_notice.is_some() {
                                "登录成功，正在加载音乐库（本次不会保存登录态）…".to_string()
                            } else {
                                "登录成功，正在加载音乐库…".to_string()
                            };
                            // The QR authorization saved an in-memory cookie.
                            // Validate it once before opening the library, and
                            // keep Esc able to cancel that final transition.
                            self.auth = AuthState::Restoring;
                            self.restore_session();
                        }
                        QrLoginStatus::Expired => self.begin_qr(),
                        status => {
                            // The service's 802 copy is inconsistent across
                            // endpoints and often only says “waiting”.  The
                            // state code is the reliable signal here, so make
                            // the required phone-side confirmation explicit.
                            let status_message = match status {
                                QrLoginStatus::Scanned => {
                                    "已扫码，请在网易云音乐 App 中确认登录".to_string()
                                }
                                QrLoginStatus::Waiting => "等待扫描二维码".to_string(),
                                QrLoginStatus::Authorized | QrLoginStatus::Expired => {
                                    check.message.clone()
                                }
                            };
                            if let AuthState::QrLogin { qr, .. } = &self.auth {
                                self.auth = AuthState::QrLogin {
                                    qr: qr.clone(),
                                    status: status_message.clone(),
                                    checking: false,
                                };
                            }
                            self.status = status_message;
                            self.next_qr_check = Instant::now()
                                + Duration::from_millis(match status {
                                    QrLoginStatus::Scanned => 1_000,
                                    _ => 2_000,
                                });
                        }
                    },
                    Err(error) => {
                        if let AuthState::QrLogin { qr, .. } = &self.auth {
                            self.auth = AuthState::QrLogin {
                                qr: qr.clone(),
                                status: format!("登录检查失败：{error}"),
                                checking: false,
                            };
                        }
                        self.status = "二维码检查失败，将重试".to_string();
                        self.next_qr_check = Instant::now() + Duration::from_secs(3);
                    }
                }
            }
            Message::CaptchaSent { generation, result } => {
                if generation != self.auth_generation {
                    return;
                }
                self.auth_task = None;
                self.auth_cancellation = None;
                let (status, input_mode) = match &mut self.auth {
                    AuthState::Login { form } => match result {
                        Ok(()) => {
                            form.sending = false;
                            form.captcha_sent = true;
                            form.field = LoginField::Captcha;
                            form.resend_available_at = Some(Instant::now() + SMS_RESEND_COOLDOWN);
                            form.status = format!(
                                "验证码已发送，请输入短信验证码 · {}s 后可重发",
                                SMS_RESEND_COOLDOWN.as_secs()
                            );
                            (form.status.clone(), InputMode::Captcha)
                        }
                        Err(error) => {
                            form.sending = false;
                            form.resend_available_at = None;
                            form.status = format!("验证码发送失败：{error}");
                            (form.status.clone(), form.field.input_mode())
                        }
                    },
                    _ => return,
                };
                self.input_mode = input_mode;
                self.status = status;
            }
            Message::SmsLogin { generation, result } => {
                if generation != self.auth_generation {
                    return;
                }
                self.auth_task = None;
                self.auth_cancellation = None;
                match result {
                    Ok(SmsLogin {
                        user,
                        saved_to_keychain,
                    }) => {
                        self.auth = AuthState::Authenticated(user);
                        self.input_mode = InputMode::Navigation;
                        self.status = if saved_to_keychain {
                            "登录成功，正在加载音乐库…".to_string()
                        } else {
                            "登录成功；本次登录态未能保存到系统 Keychain".to_string()
                        };
                        self.open_nav(NavItem::Daily);
                    }
                    Err(error) => {
                        let failure = sms_login_failure_status(&error);
                        if let AuthState::Login { form } = &mut self.auth {
                            form.authenticating = false;
                            form.status = failure.form_status;
                        } else {
                            return;
                        }
                        self.status = failure.header_status;
                    }
                }
            }
            Message::Daily { generation, result } => {
                if generation != self.content_generation {
                    return;
                }
                self.content_task = None;
                self.content_cancellation = None;
                match result {
                    Ok(DailySongs { tracks }) => {
                        self.content = Content::Daily { tracks };
                        self.restore_content_position();
                        self.status = "每日推荐已加载".to_string();
                    }
                    Err(error) => self.set_content_error(error),
                }
            }
            Message::Liked { generation, result }
            | Message::PlaylistDetail { generation, result } => {
                if generation != self.content_generation {
                    return;
                }
                self.content_task = None;
                self.content_cancellation = None;
                match result {
                    Ok(detail) => {
                        let mut detail = detail;
                        let needs_initial_track_page = detail.tracks.is_empty() && detail.has_more;
                        // `Content::Playlist` owns the visible page.  Move the
                        // embedded first page out of the core response rather
                        // than cloning it into both `detail.tracks` and the
                        // presentation list; long-lived UI state should keep
                        // one copy of each track.
                        let initial_tracks = std::mem::take(&mut detail.tracks);
                        self.track_page_empty_probes = 0;
                        if self.pending_content_position.is_none() {
                            self.content_index = 0;
                            self.content_scroll = 0;
                        }
                        self.content = Content::Playlist {
                            next_offset: detail.next_offset,
                            has_more: detail.has_more,
                            tracks: initial_tracks,
                            detail,
                            loading_more: false,
                        };
                        self.restore_content_position();
                        self.screen = Screen::Playlist;
                        self.status = "歌单已加载".to_string();
                        if needs_initial_track_page {
                            // Some service responses omit the embedded first
                            // page while still returning trackIds. Hydrate it
                            // immediately so an empty playlist cannot strand
                            // the user without a selectable row.
                            self.load_more_if_needed();
                        }
                    }
                    Err(error) => self.set_content_error(error),
                }
            }
            Message::PlaylistPage {
                generation,
                kind,
                page,
                result,
            } => {
                if generation != self.content_generation {
                    return;
                }
                self.content_task = None;
                self.content_cancellation = None;
                match result {
                    Ok(page_result) => self.apply_playlist_page(kind, page, page_result),
                    Err(error) => self.set_content_error(error),
                }
            }
            Message::TrackPage { generation, result } => {
                if generation != self.content_generation {
                    return;
                }
                self.content_task = None;
                self.content_cancellation = None;
                match result {
                    Ok(page) => {
                        let mut probe_empty_page = false;
                        let page_was_empty = page.tracks.is_empty();
                        let mut queue_append = None;
                        if let Content::Playlist {
                            tracks,
                            next_offset,
                            has_more,
                            loading_more,
                            detail,
                        } = &mut self.content
                        {
                            let unique = page
                                .tracks
                                .into_iter()
                                .filter(|track| {
                                    !tracks.iter().any(|existing| existing.id == track.id)
                                })
                                .collect::<Vec<_>>();
                            let detail_id = detail.id;
                            tracks.extend(unique.iter().cloned());
                            if self.queue.source() == QueueSource::Playlist(detail_id) {
                                queue_append = Some(unique);
                            }
                            *next_offset = next_offset.saturating_add(page.requested_count);
                            *has_more = *next_offset < detail.track_ids.len() as u64;
                            *loading_more = false;
                            if page_was_empty && *has_more {
                                if self.track_page_empty_probes < 3 {
                                    self.track_page_empty_probes += 1;
                                    probe_empty_page = true;
                                } else {
                                    // Avoid hammering a service that keeps
                                    // returning an empty page for malformed
                                    // or removed track ids.
                                    *has_more = false;
                                }
                            } else if !page_was_empty {
                                self.track_page_empty_probes = 0;
                            }
                            self.status = "已加载更多歌曲".to_string();
                        }
                        if let Some(tracks) = queue_append {
                            self.queue.append_unique(tracks);
                        }
                        if self.pending_queue_next {
                            self.pending_queue_next = false;
                            self.next_track();
                        }
                        if probe_empty_page && self.content_task.is_none() {
                            self.load_more_if_needed();
                        }
                    }
                    Err(error) => {
                        if let Content::Playlist { loading_more, .. } = &mut self.content {
                            *loading_more = false;
                        }
                        self.pending_queue_next = false;
                        if matches!(&error, CoreError::AuthRequired(_)) {
                            self.set_content_error(error);
                        } else {
                            self.status = format!("加载更多歌曲失败：{error}");
                        }
                    }
                }
            }
            Message::Lyrics {
                generation,
                track_id,
                result,
            } => {
                if generation != self.lyrics_generation {
                    return;
                }
                self.lyrics_task = None;
                self.lyrics_cancellation = None;
                if self.player.current.as_ref().map(|track| track.id) != Some(track_id) {
                    return;
                }
                match result {
                    Ok(lyrics) => {
                        self.lyrics_error = None;
                        self.previous_lyric_index = None;
                        self.lyric_index = lyrics.lines.first().map(|_| 0);
                        self.lyrics = Some(lyrics);
                        self.sync_lyric_to_progress();
                    }
                    Err(error) => {
                        self.lyrics = None;
                        self.lyrics_error = Some(error.to_string());
                        if matches!(&error, CoreError::AuthRequired(_)) {
                            self.set_content_error(error);
                        } else {
                            self.status = format!("歌词加载失败：{error}");
                        }
                    }
                }
            }
            Message::Stream {
                generation,
                track,
                result,
            } => {
                if generation != self.playback_generation {
                    return;
                }
                if self.player.current.as_ref().map(|current| current.id) != Some(track.id) {
                    return;
                }
                // Only the owner of the current playback generation may
                // release the task slot. A late response from an older
                // request must not detach the newer stream task or its
                // cancellation token from the state machine.
                self.stream_task = None;
                self.stream_cancellation = None;
                match result {
                    Ok(source) => {
                        self.player.duration_ms = if source.duration_ms > 0 {
                            source.duration_ms
                        } else {
                            track.duration_ms
                        };
                        self.player.source = Some(source.clone());
                        self.player.error = None;
                        self.status = "正在写入受控音频缓存…".to_string();
                        cancel_request(&mut self.cache_task, &mut self.cache_cancellation);
                        let core = Arc::clone(&self.core);
                        let tx = self.tx.clone();
                        let cancellation = RequestCancellation::new();
                        self.cache_cancellation = Some(cancellation.clone());
                        self.cache_task = Some(tokio::spawn(async move {
                            let _ = tx
                                .send(Message::CachedAudio {
                                    generation,
                                    track: track.clone(),
                                    result: core
                                        .cache_stream_cancellable(track.id, &source, &cancellation)
                                        .await,
                                })
                                .await;
                        }));
                    }
                    Err(error) => {
                        self.player.loading = false;
                        self.player.error = Some(error.to_string());
                        if matches!(&error, CoreError::AuthRequired(_)) {
                            self.set_content_error(error);
                        } else {
                            self.status = format!("无法播放：{error}");
                        }
                    }
                }
            }
            Message::CachedAudio {
                generation,
                track,
                result,
            } => {
                if generation != self.playback_generation {
                    return;
                }
                if self.player.current.as_ref().map(|current| current.id) != Some(track.id) {
                    return;
                }
                // See the stream handler above: stale cache completions are
                // ignored without touching the live task owner.
                self.cache_task = None;
                self.cache_cancellation = None;
                match result {
                    Ok(cached) => {
                        self.load_cached_audio(generation, track, cached.path, cached.cache_hit)
                    }
                    Err(error) => {
                        self.player.loading = false;
                        self.player.playing = false;
                        self.player.error = Some(error.to_string());
                        if matches!(&error, CoreError::AuthRequired(_)) {
                            self.set_content_error(error);
                        } else {
                            self.status = format!("无法准备音频：{error}");
                        }
                    }
                }
            }
            Message::AudioLoaded {
                generation,
                track,
                cache_hit,
                mut audio,
                result,
            } => {
                if generation != self.playback_generation
                    || self.player.current.as_ref().map(|current| current.id) != Some(track.id)
                {
                    // A newer track owns playback now. Dropping this player
                    // stops a late decoder before it can leak audio into the
                    // new queue.
                    audio.stop();
                    return;
                }
                self.audio_task = None;
                self.audio_cancellation = None;
                // Volume commands are accepted while a decoder is preparing.
                // Reapply the presentation state's latest value instead of
                // allowing the moved worker instance to overwrite it.
                audio.set_volume(self.player.volume);
                self.audio = audio;
                match result {
                    Ok(snapshot) => {
                        self.player.loading = false;
                        self.player.playing = snapshot.playing;
                        self.player.elapsed_ms = snapshot.position_ms;
                        if snapshot.duration_ms > 0 {
                            self.player.duration_ms = snapshot.duration_ms;
                        }
                        self.player.error = None;
                        self.last_progress_update = Instant::now();
                        self.sync_lyric_to_progress();
                        self.status = if cache_hit {
                            "正在从音频缓存播放".to_string()
                        } else {
                            "正在使用原生音频引擎播放".to_string()
                        };
                    }
                    Err(error) => {
                        self.player.loading = false;
                        self.player.playing = false;
                        self.player.error = Some(error.clone());
                        self.status = error;
                    }
                }
            }
        }
    }

    pub fn handle_key(&mut self, event: KeyEvent) -> bool {
        self.last_input_changed = false;
        if matches!(event.kind, KeyEventKind::Release) {
            return false;
        }
        if event.code == KeyCode::Char('c') && event.modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        // Ctrl+Q is a compatibility alias, but some macOS terminal/PTY
        // configurations reserve it for software flow control even while an
        // application is entering raw mode. Ctrl+X is the primary exit key so
        // a credential prompt or alternate screen can always be left.
        if event.code == KeyCode::Char('x') && event.modifiers.contains(KeyModifiers::CONTROL)
            || event.code == KeyCode::Char('q') && event.modifiers.contains(KeyModifiers::CONTROL)
        {
            return true;
        }
        if matches!(
            self.auth,
            AuthState::Restoring
                | AuthState::QrLogin { .. }
                | AuthState::Login { .. }
                | AuthState::Failed(_)
        ) {
            self.handle_auth_key(event);
            return false;
        }
        if !matches!(self.input_mode, InputMode::Navigation) {
            return false;
        }

        if event.code == KeyCode::Esc && matches!(self.content, Content::NoPermission { .. }) {
            self.last_input_changed = true;
            // An expired session must have a reachable recovery path without
            // forcing a restart or another automatic Keychain operation.
            self.begin_qr();
            return false;
        }

        match event.code {
            KeyCode::Char(number @ '1'..='4') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                if let Some(item) = NavItem::from_number(number) {
                    self.open_nav(item);
                }
            }
            KeyCode::Tab => {
                self.last_input_changed = true;
                self.focus = self.focus.next(self.lyrics_only);
            }
            KeyCode::Esc => {
                self.last_input_changed = true;
                self.go_back();
            }
            KeyCode::Char('v') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                self.toggle_lyrics();
            }
            KeyCode::Char('r') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                self.refresh();
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.last_input_changed = true;
                self.move_selection(-1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.last_input_changed = true;
                self.move_selection(1);
            }
            KeyCode::PageUp => {
                self.last_input_changed = true;
                self.move_selection(-10);
            }
            KeyCode::PageDown => {
                self.last_input_changed = true;
                self.move_selection(10);
            }
            KeyCode::Enter => {
                self.last_input_changed = true;
                self.activate_selection();
            }
            code if event.modifiers.contains(KeyModifiers::SHIFT) && code == KeyCode::Left => {
                self.last_input_changed = true;
                self.request_seek(-30_000)
            }
            code if event.modifiers.contains(KeyModifiers::SHIFT) && code == KeyCode::Right => {
                self.last_input_changed = true;
                self.request_seek(30_000)
            }
            KeyCode::Left | KeyCode::Char('[') => {
                self.last_input_changed = true;
                self.request_seek(-5_000);
            }
            KeyCode::Right | KeyCode::Char(']') => {
                self.last_input_changed = true;
                self.request_seek(5_000);
            }
            KeyCode::Char(' ') => {
                self.last_input_changed = true;
                self.toggle_playback();
            }
            KeyCode::Char('-') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                self.adjust_volume(-0.05);
            }
            KeyCode::Char('=') | KeyCode::Char('+') => {
                self.last_input_changed = true;
                self.adjust_volume(0.05);
            }
            KeyCode::Char('n') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                self.next_track();
            }
            KeyCode::Char('p') if event.modifiers.is_empty() => {
                self.last_input_changed = true;
                self.previous_track();
            }
            _ => {}
        }
        false
    }

    pub fn key_changed(&self) -> bool {
        self.last_input_changed
    }

    /// Routes login input before player/navigation shortcuts are considered.
    /// QR is the sole normal route; the SMS branch remains isolated so its
    /// retained implementation cannot leak shortcuts into the library.
    fn handle_auth_key(&mut self, event: KeyEvent) {
        match &self.auth {
            AuthState::Restoring | AuthState::Failed(_) => match event.code {
                KeyCode::Char('r') | KeyCode::Enter | KeyCode::Esc => {
                    self.last_input_changed = true;
                    self.begin_qr();
                }
                _ => {}
            },
            AuthState::QrLogin { .. } => match event.code {
                KeyCode::Char('r') | KeyCode::Enter => {
                    self.last_input_changed = true;
                    self.begin_qr();
                }
                KeyCode::Esc => {
                    self.last_input_changed = true;
                    self.cancel_qr();
                }
                _ => {}
            },
            AuthState::Login { .. } => match event.code {
                KeyCode::Tab | KeyCode::BackTab => {
                    self.last_input_changed = true;
                    let next = match &self.auth {
                        AuthState::Login { form } => form.field.next(form.captcha_sent),
                        _ => return,
                    };
                    if next == LoginField::PhoneNumber
                        && matches!(
                            &self.auth,
                            AuthState::Login {
                                form: PhoneLogin {
                                    captcha_sent: false,
                                    ..
                                }
                            }
                        )
                    {
                        self.set_login_status("请先发送验证码".to_string());
                    } else {
                        self.set_login_field(next);
                    }
                }
                KeyCode::Enter => {
                    self.last_input_changed = true;
                    let field = match &self.auth {
                        AuthState::Login { form } => form.field,
                        _ => return,
                    };
                    if field == LoginField::PhoneNumber {
                        self.request_sms_captcha();
                    } else {
                        self.submit_sms_login();
                    }
                }
                KeyCode::Char('r') if event.modifiers.is_empty() => {
                    self.last_input_changed = true;
                    self.request_sms_captcha();
                }
                KeyCode::Esc => {
                    self.last_input_changed = true;
                    self.cancel_phone_login();
                }
                KeyCode::Backspace => {
                    self.last_input_changed = self.delete_login_character();
                }
                KeyCode::Char(character)
                    if event.modifiers.is_empty() && character.is_ascii_digit() =>
                {
                    self.last_input_changed = self.push_login_character(character);
                }
                _ => {}
            },
            AuthState::Authenticated(_) => {}
        }
    }

    /// Pastes only ASCII digits into the active login field. Terminal paste
    /// is useful for one-time codes, but filtering it here prevents control
    /// sequences and formatting characters from becoming part of a request.
    pub fn handle_paste(&mut self, value: &str) -> bool {
        self.last_input_changed = false;
        let digits = value
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(char::from)
            .collect::<String>();
        if digits.is_empty() {
            return false;
        }
        let status = match &mut self.auth {
            AuthState::Login { form } if !form.sending && !form.authenticating => {
                match form.field {
                    LoginField::PhoneNumber => {
                        invalidate_captcha_for_phone_change(form);
                        let remaining = MAX_PHONE_DIGITS.saturating_sub(form.phone.len());
                        form.phone.extend(digits.chars().take(remaining));
                        form.status = "已粘贴手机号".to_string();
                    }
                    LoginField::Captcha => {
                        let remaining = MAX_CAPTCHA_DIGITS.saturating_sub(form.captcha.len());
                        form.captcha.extend(digits.chars().take(remaining));
                        form.status = "已粘贴验证码".to_string();
                    }
                }
                form.status.clone()
            }
            _ => return false,
        };
        self.status = status;
        self.last_input_changed = true;
        true
    }

    fn set_login_status(&mut self, status: String) {
        if let AuthState::Login { form } = &mut self.auth {
            form.status = status.clone();
        }
        self.status = status;
    }

    fn set_login_field(&mut self, field: LoginField) {
        if let AuthState::Login { form } = &mut self.auth {
            if field == LoginField::Captcha && !form.captcha_sent {
                form.status = "请先发送验证码".to_string();
                self.status = form.status.clone();
                return;
            }
            form.field = field;
            self.input_mode = field.input_mode();
            form.status = match field {
                LoginField::PhoneNumber => "输入手机号后按 Enter 发送验证码".to_string(),
                LoginField::Captcha => "输入验证码后按 Enter 登录".to_string(),
            };
            self.status = form.status.clone();
        }
    }

    fn push_login_character(&mut self, character: char) -> bool {
        let status = match &mut self.auth {
            AuthState::Login { form } if !form.sending && !form.authenticating => {
                match form.field {
                    LoginField::PhoneNumber => {
                        invalidate_captcha_for_phone_change(form);
                        if form.phone.len() >= MAX_PHONE_DIGITS {
                            form.status = format!("手机号最多 {MAX_PHONE_DIGITS} 位");
                        } else {
                            form.phone.push(character);
                            form.status = "输入手机号后按 Enter 发送验证码".to_string();
                        }
                    }
                    LoginField::Captcha => {
                        if form.captcha.len() >= MAX_CAPTCHA_DIGITS {
                            form.status = format!("验证码最多 {MAX_CAPTCHA_DIGITS} 位");
                        } else {
                            form.captcha.push(character);
                            form.status = "输入验证码后按 Enter 登录".to_string();
                        }
                    }
                }
                form.status.clone()
            }
            _ => return false,
        };
        self.status = status;
        true
    }

    fn delete_login_character(&mut self) -> bool {
        let status = match &mut self.auth {
            AuthState::Login { form } if !form.sending && !form.authenticating => {
                match form.field {
                    LoginField::PhoneNumber => {
                        invalidate_captcha_for_phone_change(form);
                        form.phone.pop();
                        "输入手机号后按 Enter 发送验证码".to_string()
                    }
                    LoginField::Captcha => {
                        form.captcha.pop();
                        "输入验证码后按 Enter 登录".to_string()
                    }
                }
            }
            _ => return false,
        };
        if let AuthState::Login { form } = &mut self.auth {
            form.status = status.clone();
        }
        self.status = status;
        true
    }

    pub fn handle_mouse(&mut self, event: MouseEvent) -> bool {
        let position = (event.column, event.row);
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if contains(self.hit_areas.sidebar_divider, position) {
                    self.pane_drag = Some(PaneDrag::Sidebar);
                    self.status = "拖动调整左栏宽度 · 松开完成".to_string();
                    true
                } else if contains(self.hit_areas.lyrics_divider, position) {
                    self.pane_drag = Some(PaneDrag::Lyrics);
                    self.status = "拖动调整歌词栏宽度 · 松开完成".to_string();
                    true
                } else {
                    // Intentional: ordinary clicks never change focus or activate content.
                    false
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => match self.pane_drag {
                Some(PaneDrag::Sidebar) => {
                    self.resize_sidebar(event.column);
                    true
                }
                Some(PaneDrag::Lyrics) => {
                    self.resize_lyrics(event.column);
                    true
                }
                None => false,
            },
            MouseEventKind::Up(MouseButton::Left) if self.pane_drag.is_some() => {
                self.pane_drag = None;
                self.status = "布局宽度已更新".to_string();
                true
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                let now = Instant::now();
                // macOS trackpads emit a burst of wheel events for one
                // gesture. Keep one logical row per 120ms so momentum remains
                // readable instead of throwing the selection down a screen.
                if self.last_scroll_event.is_some_and(|last| {
                    now.saturating_duration_since(last) < TRACKPAD_SCROLL_INTERVAL
                }) {
                    return false;
                }
                self.last_scroll_event = Some(now);
                let amount = if matches!(event.kind, MouseEventKind::ScrollDown) {
                    1
                } else {
                    -1
                };
                if contains(self.hit_areas.navigation, position) {
                    // Scrolling is the one mouse/trackpad interaction that
                    // changes a selection. Make its keyboard target explicit
                    // too, otherwise the next Enter could silently act on a
                    // previously focused player or list pane.
                    self.focus = Focus::Navigation;
                    self.move_navigation(amount);
                    true
                } else if contains(self.hit_areas.content, position) && !self.lyrics_only {
                    self.focus = Focus::Content;
                    self.move_content_selection(amount);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    pub fn current_user(&self) -> Option<&AuthUser> {
        match &self.auth {
            AuthState::Authenticated(user) => Some(user),
            _ => None,
        }
    }

    fn restore_session(&mut self) {
        cancel_request(&mut self.session_task, &mut self.session_cancellation);
        self.session_generation = self.session_generation.wrapping_add(1);
        let generation = self.session_generation;
        let cancellation = RequestCancellation::new();
        self.session_cancellation = Some(cancellation.clone());
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.session_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::Session {
                    generation,
                    result: core.restore_session_cancellable(&cancellation).await,
                })
                .await;
        }));
    }

    fn begin_qr(&mut self) {
        // If QR is entered while a Keychain restore is still pending, its
        // eventual result must not overwrite the login screen.
        self.session_generation = self.session_generation.wrapping_add(1);
        cancel_request(&mut self.session_task, &mut self.session_cancellation);
        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.auth_generation = self.auth_generation.wrapping_add(1);
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        self.qr_generation = self.qr_generation.wrapping_add(1);
        self.qr_expires_at = None;
        self.pending_auth_notice = None;
        let generation = self.qr_generation;
        let cancellation = RequestCancellation::new();
        self.qr_cancellation = Some(cancellation.clone());
        self.auth = AuthState::QrLogin {
            qr: None,
            status: "正在生成二维码…".to_string(),
            checking: false,
        };
        self.input_mode = InputMode::Navigation;
        self.content = Content::Empty;
        self.status = "正在生成二维码…".to_string();
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.qr_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::Qr {
                    generation,
                    result: core.begin_qr_login_cancellable(&cancellation).await,
                })
                .await;
        }));
    }

    fn check_qr(&mut self) {
        let key = match &self.auth {
            AuthState::QrLogin {
                qr: Some(qr),
                checking: false,
                ..
            } => qr.key.clone(),
            _ => return,
        };
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        let generation = self.qr_generation;
        let cancellation = RequestCancellation::new();
        self.qr_cancellation = Some(cancellation.clone());
        if let AuthState::QrLogin { qr, status, .. } = &self.auth {
            let checking_status = if status.starts_with("已扫码") {
                "已扫码，正在等待手机确认…".to_string()
            } else {
                "正在检查扫码状态…".to_string()
            };
            self.auth = AuthState::QrLogin {
                qr: qr.clone(),
                status: checking_status.clone(),
                checking: true,
            };
            self.status = checking_status;
        }
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.qr_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::QrCheck {
                    generation,
                    result: core.check_qr_login_cancellable(&key, &cancellation).await,
                })
                .await;
        }));
    }

    fn cancel_qr(&mut self) {
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        self.qr_generation = self.qr_generation.wrapping_add(1);
        self.qr_expires_at = None;
        if matches!(self.auth, AuthState::QrLogin { .. }) {
            self.auth = AuthState::QrLogin {
                qr: None,
                status: "二维码登录已取消".to_string(),
                checking: false,
            };
            self.status = "按 r 或 Enter 重新生成二维码".to_string();
        }
    }

    fn expire_qr(&mut self) {
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        self.qr_generation = self.qr_generation.wrapping_add(1);
        self.qr_expires_at = None;
        if let AuthState::QrLogin { qr, .. } = &self.auth {
            self.auth = AuthState::QrLogin {
                qr: qr.clone(),
                status: "二维码已过期，请按 r 或 Enter 重新生成".to_string(),
                checking: false,
            };
            self.status = "二维码已过期，请按 r 或 Enter 重新生成".to_string();
            self.next_qr_check = Instant::now() + Duration::from_secs(60);
        }
    }

    fn update_qr_countdown(&mut self, now: Instant) -> bool {
        let Some(expires_at) = self.qr_expires_at else {
            return false;
        };
        let remaining_seconds = expires_at.saturating_duration_since(now).as_secs().max(1);
        let AuthState::QrLogin {
            status,
            checking: false,
            qr: Some(_),
        } = &mut self.auth
        else {
            return false;
        };
        let base = status.split(" · 有效期 ").next().unwrap_or(status.as_str());
        let next = format!("{base} · 有效期 {remaining_seconds}s");
        if *status == next {
            false
        } else {
            *status = next;
            true
        }
    }

    #[allow(dead_code)]
    fn begin_phone_login(&mut self) {
        // If phone login is selected while a Keychain restore is still
        // pending, its eventual result must not overwrite the explicit form.
        self.session_generation = self.session_generation.wrapping_add(1);
        cancel_request(&mut self.session_task, &mut self.session_cancellation);
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        self.qr_generation = self.qr_generation.wrapping_add(1);
        self.qr_expires_at = None;
        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.auth_generation = self.auth_generation.wrapping_add(1);
        let form = PhoneLogin::new("输入 +86 手机号后按 Enter 发送验证码");
        self.auth = AuthState::Login { form };
        self.input_mode = InputMode::PhoneNumber;
        self.content = Content::Empty;
        self.status = "手机验证码登录".to_string();
    }

    fn request_sms_captcha(&mut self) {
        let now = Instant::now();
        let phone = match &self.auth {
            AuthState::Login { form } => {
                if form.sending || form.authenticating {
                    return;
                }
                // A risk/rejection response must be acknowledged by an
                // explicit reset (Esc, edit, or field change), not converted
                // into another immediate SMS request by `r`.
                if is_terminal_sms_login_failure(&form.status) {
                    return;
                }
                if let Some(available_at) = form.resend_available_at.filter(|at| *at > now) {
                    let seconds = available_at.saturating_duration_since(now).as_secs().max(1);
                    self.set_login_status(format!(
                        "验证码已发送，请输入短信验证码 · {seconds}s 后可重发"
                    ));
                    return;
                }
                form.phone.clone()
            }
            _ => return,
        };
        if !valid_phone(&phone) {
            self.set_login_status("请输入 7–15 位数字手机号".to_string());
            self.input_mode = InputMode::PhoneNumber;
            if let AuthState::Login { form } = &mut self.auth {
                form.field = LoginField::PhoneNumber;
            }
            return;
        }

        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.auth_generation = self.auth_generation.wrapping_add(1);
        let generation = self.auth_generation;
        let cancellation = RequestCancellation::new();
        self.auth_cancellation = Some(cancellation.clone());
        if let AuthState::Login { form } = &mut self.auth {
            form.sending = true;
            form.status = "正在发送短信验证码…".to_string();
        }
        self.status = "正在发送短信验证码…".to_string();
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.auth_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::CaptchaSent {
                    generation,
                    result: core
                        .send_sms_captcha_cancellable(&phone, "86", &cancellation)
                        .await,
                })
                .await;
        }));
    }

    fn submit_sms_login(&mut self) {
        let (phone, captcha, captcha_sent, busy, failed) = match &self.auth {
            AuthState::Login { form } => (
                form.phone.clone(),
                form.captcha.clone(),
                form.captcha_sent,
                form.sending || form.authenticating,
                is_terminal_sms_login_failure(&form.status),
            ),
            _ => return,
        };
        if busy || failed {
            return;
        }
        if !captcha_sent {
            self.request_sms_captcha();
            return;
        }
        if !valid_phone(&phone) {
            self.set_login_status("请输入 7–15 位数字手机号".to_string());
            self.set_login_field(LoginField::PhoneNumber);
            return;
        }
        if !valid_captcha(&captcha) {
            self.set_login_status("请输入 4–8 位短信验证码".to_string());
            self.set_login_field(LoginField::Captcha);
            return;
        }

        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.auth_generation = self.auth_generation.wrapping_add(1);
        let generation = self.auth_generation;
        let cancellation = RequestCancellation::new();
        self.auth_cancellation = Some(cancellation.clone());
        if let AuthState::Login { form } = &mut self.auth {
            form.authenticating = true;
            form.status = "正在验证短信验证码…".to_string();
        }
        self.status = "正在验证短信验证码…".to_string();
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.auth_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::SmsLogin {
                    generation,
                    result: core
                        .login_with_sms_cancellable(&phone, &captcha, "86", &cancellation)
                        .await,
                })
                .await;
        }));
    }

    fn cancel_phone_login(&mut self) {
        let request_in_flight = self.auth_task.is_some();
        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.auth_generation = self.auth_generation.wrapping_add(1);
        let (status, input_mode) = match &mut self.auth {
            AuthState::Login { form } if request_in_flight => {
                form.sending = false;
                form.authenticating = false;
                form.status = "登录请求已取消".to_string();
                (form.status.clone(), form.field.input_mode())
            }
            AuthState::Login { form } if form.field == LoginField::Captcha => {
                form.captcha.clear();
                form.field = LoginField::PhoneNumber;
                form.status = "已清空验证码，已返回手机号输入".to_string();
                (form.status.clone(), InputMode::PhoneNumber)
            }
            AuthState::Login { form } => {
                form.phone.clear();
                form.status = "已清空手机号".to_string();
                (form.status.clone(), InputMode::PhoneNumber)
            }
            _ => return,
        };
        self.input_mode = input_mode;
        self.status = status;
    }

    fn update_sms_resend_status(&mut self, now: Instant) -> bool {
        let AuthState::Login { form } = &mut self.auth else {
            return false;
        };
        let Some(available_at) = form.resend_available_at else {
            return false;
        };
        // Preserve a complete server-rejection explanation until the listener
        // explicitly leaves that failure state. In particular, do not append
        // a resend countdown and overwrite the compact header status.
        if is_terminal_sms_login_failure(&form.status) {
            if now >= available_at {
                form.resend_available_at = None;
                return true;
            }
            return false;
        }
        let next = if now >= available_at {
            form.resend_available_at = None;
            "验证码已发送；现在可按 r 重发".to_string()
        } else {
            let seconds = available_at.saturating_duration_since(now).as_secs().max(1);
            let base = form
                .status
                .split(" · ")
                .next()
                .unwrap_or(form.status.as_str());
            format!("{base} · {seconds}s 后可重发")
        };
        if form.status == next {
            return false;
        }
        form.status = next.clone();
        self.status = next;
        true
    }

    fn retry_auth(&mut self) {
        match &self.auth {
            // Never auto-retry a Keychain restore in the same process. macOS
            // may still be showing the first system sheet even when the TUI
            // has been cancelled; this remains an explicit QR-login
            // escape hatch instead of issuing another credential request.
            AuthState::Failed(_) | AuthState::Restoring | AuthState::QrLogin { .. } => {
                self.begin_qr()
            }
            AuthState::Login { .. } => self.request_sms_captcha(),
            AuthState::Authenticated(_) => {}
        }
    }

    fn open_nav(&mut self, item: NavItem) {
        // Switching one of the four root entries intentionally begins a new
        // navigation branch. A saved parent list belongs only to the detail
        // view opened from it and must not survive into another root entry.
        self.playlist_return = None;
        self.pending_content_position = None;
        self.open_nav_impl(item);
    }

    fn open_nav_impl(&mut self, item: NavItem) {
        self.nav = item;
        self.focus = Focus::Content;
        self.screen = Screen::Home;
        self.content_index = 0;
        self.content_scroll = 0;
        self.content_generation = self.content_generation.wrapping_add(1);
        self.playlist_page_empty_probes = 0;
        let generation = self.content_generation;
        cancel_request(&mut self.content_task, &mut self.content_cancellation);
        match item {
            NavItem::Daily => {
                self.content = Content::Loading {
                    label: "正在加载每日推荐…".to_string(),
                };
                let cancellation = RequestCancellation::new();
                self.content_cancellation = Some(cancellation.clone());
                let core = Arc::clone(&self.core);
                let tx = self.tx.clone();
                self.content_task = Some(tokio::spawn(async move {
                    let _ = tx
                        .send(Message::Daily {
                            generation,
                            result: core.daily_songs_cancellable(&cancellation).await,
                        })
                        .await;
                }));
            }
            NavItem::Liked => {
                let Some(user) = self.current_user().cloned() else {
                    return;
                };
                self.content = Content::Loading {
                    label: "正在加载我最喜欢…".to_string(),
                };
                let cancellation = RequestCancellation::new();
                self.content_cancellation = Some(cancellation.clone());
                let core = Arc::clone(&self.core);
                let tx = self.tx.clone();
                self.content_task = Some(tokio::spawn(async move {
                    let _ = tx
                        .send(Message::Liked {
                            generation,
                            result: core
                                .liked_songs_cancellable(user.user_id, &cancellation)
                                .await,
                        })
                        .await;
                }));
            }
            NavItem::Saved | NavItem::Created => {
                self.content = Content::Loading {
                    label: format!("正在加载{}…", item.label()),
                };
                let Some(user) = self.current_user().cloned() else {
                    return;
                };
                let kind = PlaylistKind::from_nav(item).expect("playlist nav item");
                let scope = match kind {
                    PlaylistKind::Saved => PlaylistScope::Subscribed,
                    PlaylistKind::Created => PlaylistScope::Owned,
                };
                let cancellation = RequestCancellation::new();
                self.content_cancellation = Some(cancellation.clone());
                let core = Arc::clone(&self.core);
                let tx = self.tx.clone();
                self.content_task = Some(tokio::spawn(async move {
                    let _ = tx
                        .send(Message::PlaylistPage {
                            generation,
                            kind,
                            page: false,
                            result: core
                                .playlist_page_for_cancellable(
                                    user.user_id,
                                    scope,
                                    0,
                                    &cancellation,
                                )
                                .await,
                        })
                        .await;
                }));
            }
        }
    }

    fn apply_playlist_page(&mut self, kind: PlaylistKind, page: bool, result: PlaylistPage) {
        let mut incoming = result.items;
        let mut should_probe_next = false;
        let mut empty_page = incoming.is_empty();
        if page {
            let previous_offset = match &self.content {
                Content::PlaylistList { next_offset, .. } => *next_offset,
                _ => result.next_offset,
            };
            if let Content::PlaylistList {
                items,
                next_offset,
                has_more,
                loading_more,
                ..
            } = &mut self.content
            {
                incoming.retain(|item| !items.iter().any(|existing| existing.id == item.id));
                empty_page = incoming.is_empty();
                items.extend(incoming);
                *next_offset = result.next_offset;
                *has_more = result.has_more;
                *loading_more = false;
                if result.has_more && result.next_offset <= previous_offset {
                    // A service cursor that regresses can otherwise make
                    // repeated scrolls request the same page forever, even
                    // when that page contains one newly parsed item.
                    *has_more = false;
                    self.status = "歌单分页没有继续推进，已停止加载".to_string();
                } else if empty_page && result.has_more {
                    if result.next_offset > previous_offset && self.playlist_page_empty_probes < 3 {
                        self.playlist_page_empty_probes += 1;
                        should_probe_next = true;
                    } else {
                        *has_more = false;
                        self.status = "没有更多可显示的歌单".to_string();
                    }
                } else if !empty_page {
                    self.playlist_page_empty_probes = 0;
                }
            }
        } else {
            let has_more = if empty_page && result.has_more {
                if result.next_offset > 0 && self.playlist_page_empty_probes < 3 {
                    self.playlist_page_empty_probes += 1;
                    should_probe_next = true;
                    true
                } else {
                    false
                }
            } else {
                if !empty_page {
                    self.playlist_page_empty_probes = 0;
                }
                result.has_more
            };
            self.content = Content::PlaylistList {
                kind,
                items: incoming,
                next_offset: result.next_offset,
                has_more,
                loading_more: false,
            };
            self.status = format!("{}已加载", kind.label());
            self.restore_content_position();
        }
        if should_probe_next {
            self.load_more_if_needed();
        }
    }

    fn set_content_error(&mut self, error: CoreError) {
        let message = error.to_string();
        self.content = match error {
            CoreError::AuthRequired(_) => Content::NoPermission { message },
            CoreError::Network(_) => Content::Offline { message },
            CoreError::Cancelled => Content::Empty,
            _ => Content::Error { message },
        };
        self.status = match &self.content {
            Content::NoPermission { .. } => "需要登录".to_string(),
            Content::Offline { .. } => "网络不可用".to_string(),
            Content::Empty => "请求已取消".to_string(),
            _ => "按 r 重试".to_string(),
        };
    }

    fn move_selection(&mut self, amount: i32) {
        match self.focus {
            Focus::Navigation => self.move_navigation(amount),
            Focus::Content => self.move_content_selection(amount),
            // The player pane has no row selection.  Progress uses the
            // explicit left/right shortcuts below, so vertical movement never
            // changes playback accidentally.
            Focus::Player => {}
        }
    }

    fn move_navigation(&mut self, amount: i32) {
        let position = NavItem::ALL
            .iter()
            .position(|item| *item == self.nav)
            .unwrap_or_default();
        let last = NavItem::ALL.len().saturating_sub(1) as i32;
        let next = (position as i32 + amount).clamp(0, last) as usize;
        self.nav = NavItem::ALL[next];
    }

    fn move_content_selection(&mut self, amount: i32) {
        if self.lyrics_only {
            return;
        }
        let last = self.content.len().saturating_sub(1) as i32;
        if self.content.len() == 0 {
            return;
        }
        self.content_index = (self.content_index as i32 + amount).clamp(0, last) as usize;
        self.keep_selection_visible(self.content_viewport_rows);
        if self.content_index.saturating_add(4) >= self.content.len() {
            self.load_more_if_needed();
        }
    }

    fn resize_sidebar(&mut self, column: u16) {
        let body = self.hit_areas.body;
        let requested = column.saturating_sub(body.x).saturating_add(1);
        // Keep the currently visible lyric pane in the budget while dragging
        // the left divider. Otherwise a wide lyric pane can be silently
        // clamped on the next render, producing a layout jump at mouse-up.
        let lyric_reserve = if self.hit_areas.lyrics_divider.width > 0 {
            self.lyrics_width.max(28)
        } else {
            0
        };
        let max = body.width.saturating_sub(34).saturating_sub(lyric_reserve);
        self.sidebar_width = requested.clamp(18, max.max(18));
    }

    fn resize_lyrics(&mut self, column: u16) {
        let body = self.hit_areas.body;
        let requested = body.right().saturating_sub(column);
        // The sidebar is resizable too; constrain the lyric pane against its
        // current width so a drag cannot temporarily create an impossible
        // three-pane layout that the next render must snap back from.
        let max = body
            .width
            .saturating_sub(self.sidebar_width)
            .saturating_sub(34);
        self.lyrics_width = requested.clamp(28, max.max(28));
    }

    fn keep_selection_visible(&mut self, viewport_rows: usize) {
        if self.content_index < self.content_scroll {
            self.content_scroll = self.content_index;
        } else if self.content_index >= self.content_scroll.saturating_add(viewport_rows) {
            self.content_scroll = self
                .content_index
                .saturating_add(1)
                .saturating_sub(viewport_rows);
        }
    }

    fn restore_content_position(&mut self) {
        let Some(position) = self.pending_content_position.take() else {
            return;
        };
        let selected_index = position
            .selected_id
            .and_then(|selected_id| match &self.content {
                Content::Daily { tracks } | Content::Playlist { tracks, .. } => {
                    tracks.iter().position(|track| track.id == selected_id)
                }
                Content::PlaylistList { items, .. } => {
                    items.iter().position(|item| item.id == selected_id)
                }
                _ => None,
            });
        self.content_index = selected_index
            .unwrap_or(position.index)
            .min(self.content.len().saturating_sub(1));
        self.content_scroll = position.scroll.min(self.content_index);
        self.keep_selection_visible(self.content_viewport_rows);
    }

    fn activate_selection(&mut self) {
        match self.focus {
            Focus::Navigation => self.open_nav(self.nav),
            Focus::Content => {
                if self.lyrics_only {
                    return;
                }
                if let Some(playlist) = self.content.playlist_at(self.content_index).cloned() {
                    self.open_playlist(playlist.id);
                } else if let Some(track) = self.content.track_at(self.content_index).cloned() {
                    self.start_queue_from_content(self.content_index, track);
                }
            }
            Focus::Player => self.toggle_playback(),
        }
    }

    fn open_playlist(&mut self, playlist_id: i64) {
        if matches!(self.content, Content::PlaylistList { .. }) {
            let mut parent = self.content.clone();
            // A list-page request is cancelled below before the detail request
            // starts. Never restore a stale "loading more" footer when the
            // listener returns to the parent list.
            if let Content::PlaylistList { loading_more, .. } = &mut parent {
                *loading_more = false;
            }
            self.playlist_return = Some(PlaylistReturn {
                content: parent,
                index: self.content_index,
                scroll: self.content_scroll,
            });
        }
        self.content_generation = self.content_generation.wrapping_add(1);
        let generation = self.content_generation;
        cancel_request(&mut self.content_task, &mut self.content_cancellation);
        // Enter the detail screen before the request completes. This gives
        // Esc a truthful, deterministic way back to the saved parent even if
        // the detail request is slow, cancelled, or fails.
        self.screen = Screen::Playlist;
        self.content = Content::Loading {
            label: "正在加载歌单…".to_string(),
        };
        let cancellation = RequestCancellation::new();
        self.content_cancellation = Some(cancellation.clone());
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.content_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::PlaylistDetail {
                    generation,
                    result: core
                        .playlist_detail_cancellable(playlist_id, &cancellation)
                        .await,
                })
                .await;
        }));
    }

    fn load_more_if_needed(&mut self) {
        if !self.content.has_more() || self.content_task.is_some() {
            return;
        }
        enum MoreRequest {
            Playlists {
                kind: PlaylistKind,
                scope: PlaylistScope,
                offset: u64,
                user_id: i64,
            },
            Tracks {
                ids: Vec<i64>,
            },
        }
        let request = match &self.content {
            Content::PlaylistList {
                kind,
                next_offset,
                loading_more: false,
                ..
            } => self.current_user().map(|user| {
                let scope = match kind {
                    PlaylistKind::Saved => PlaylistScope::Subscribed,
                    PlaylistKind::Created => PlaylistScope::Owned,
                };
                MoreRequest::Playlists {
                    kind: *kind,
                    scope,
                    offset: *next_offset,
                    user_id: user.user_id,
                }
            }),
            Content::Playlist {
                detail,
                next_offset,
                loading_more: false,
                ..
            } => {
                let start = *next_offset as usize;
                let end = start
                    .saturating_add(clarus_core::PLAYLIST_PAGE_SIZE)
                    .min(detail.track_ids.len());
                (start < end).then(|| MoreRequest::Tracks {
                    ids: detail.track_ids[start..end].to_vec(),
                })
            }
            _ => None,
        };
        let Some(request) = request else { return };
        match (&mut self.content, &request) {
            (Content::PlaylistList { loading_more, .. }, MoreRequest::Playlists { .. })
            | (Content::Playlist { loading_more, .. }, MoreRequest::Tracks { .. }) => {
                *loading_more = true;
            }
            _ => return,
        }
        let generation = self.content_generation;
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        let cancellation = RequestCancellation::new();
        self.content_cancellation = Some(cancellation.clone());
        self.content_task = Some(tokio::spawn(async move {
            let message = match request {
                MoreRequest::Playlists {
                    kind,
                    scope,
                    offset,
                    user_id,
                } => Message::PlaylistPage {
                    generation,
                    kind,
                    page: true,
                    result: core
                        .playlist_page_for_cancellable(user_id, scope, offset, &cancellation)
                        .await,
                },
                MoreRequest::Tracks { ids } => Message::TrackPage {
                    generation,
                    result: core
                        .playlist_track_page_cancellable(&ids, &cancellation)
                        .await,
                },
            };
            let _ = tx.send(message).await;
        }));
    }

    fn load_cached_audio(&mut self, generation: u64, track: Track, path: PathBuf, cache_hit: bool) {
        // Opening a file, constructing a decoder, and opening a device can
        // block on disk or CoreAudio. Keep that work outside the terminal
        // event loop so resize, input, cancellation, and redraw stay
        // responsive while the track prepares.
        cancel_request(&mut self.audio_task, &mut self.audio_cancellation);
        let seek_to_ms = self.player.elapsed_ms;
        let mut audio = std::mem::take(&mut self.audio);
        let cancellation = RequestCancellation::new();
        self.audio_cancellation = Some(cancellation.clone());
        let prepare_lock = Arc::clone(&self.audio_prepare_lock);
        let latest_generation = Arc::clone(&self.audio_prepare_generation);
        let tx = self.tx.clone();
        self.audio_task = Some(tokio::spawn(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                if cancellation.is_cancelled()
                    || latest_generation.load(Ordering::Acquire) != generation
                {
                    audio.stop();
                    return (audio, Err("音频准备已取消".to_string()));
                }
                let lock = match prepare_lock.lock() {
                    Ok(lock) => lock,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if cancellation.is_cancelled()
                    || latest_generation.load(Ordering::Acquire) != generation
                {
                    drop(lock);
                    audio.stop();
                    return (audio, Err("音频准备已取消".to_string()));
                }
                let result = audio.load_and_play(&path, seek_to_ms);
                drop(lock);
                if cancellation.is_cancelled()
                    || latest_generation.load(Ordering::Acquire) != generation
                {
                    audio.stop();
                    return (audio, Err("音频准备已取消".to_string()));
                }
                (audio, result)
            })
            .await;
            let (audio, result) = match outcome {
                Ok(outcome) => outcome,
                Err(error) => (
                    NativePlayer::default(),
                    Err(format!("音频准备任务失败：{error}")),
                ),
            };
            let _ = tx
                .send(Message::AudioLoaded {
                    generation,
                    track,
                    cache_hit,
                    audio,
                    result,
                })
                .await;
        }));
    }

    fn play_track(&mut self, track: Track) {
        if !track.playable {
            self.status = track
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "这首歌当前不可播放".to_string());
            return;
        }
        cancel_request(&mut self.stream_task, &mut self.stream_cancellation);
        cancel_request(&mut self.cache_task, &mut self.cache_cancellation);
        cancel_request(&mut self.audio_task, &mut self.audio_cancellation);
        self.playback_generation = self.playback_generation.wrapping_add(1);
        let generation = self.playback_generation;
        self.audio_prepare_generation
            .store(generation, Ordering::Release);
        self.cancel_lyrics_request();
        self.audio.stop();
        self.player = PlayerState {
            duration_ms: track.duration_ms,
            current: Some(track.clone()),
            loading: true,
            volume: self.audio.volume(),
            ..PlayerState::default()
        };
        self.lyrics = None;
        self.lyrics_error = None;
        self.lyric_index = None;
        self.previous_lyric_index = None;
        self.lyric_transition_until = None;
        self.lyric_transition_started = None;
        self.last_progress_update = Instant::now();
        self.status = format!("正在解析：{}", track.name);
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        let quality = "320000".to_string();
        let stream_track = track.clone();
        let cancellation = RequestCancellation::new();
        self.stream_cancellation = Some(cancellation.clone());
        self.stream_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::Stream {
                    generation,
                    track: stream_track,
                    result: core
                        .resolve_stream_url_cancellable(track.id, &quality, &cancellation)
                        .await,
                })
                .await;
        }));
        if self.lyrics_visible {
            self.request_lyrics(track.id);
        }
    }

    fn request_seek(&mut self, delta_ms: i64) {
        if self.player.current.is_none() {
            self.status = "先在歌曲列表中选择一首歌".to_string();
            return;
        }
        if self.player.loading {
            self.status = "音频仍在准备，暂时不能跳转".to_string();
            return;
        }
        let current = self.player.elapsed_ms.min(i64::MAX as u64) as i64;
        let duration = self.player.duration_ms.min(i64::MAX as u64) as i64;
        let next = if duration == 0 {
            // Some decoders and stream responses do not expose a duration.
            // Preserve relative seeking until the audio owner can report one
            // instead of clamping every key press back to zero.
            current.saturating_add(delta_ms).max(0) as u64
        } else {
            current.saturating_add(delta_ms).clamp(0, duration) as u64
        };
        self.seek_to(next);
    }

    fn toggle_playback(&mut self) {
        if self.player.current.is_none() {
            self.status = "先在歌曲列表中选择一首歌".to_string();
            return;
        }
        if self.player.loading {
            self.status = "音频仍在准备".to_string();
            return;
        }
        let result = if self.player.playing {
            self.audio.pause()
        } else {
            self.audio.play()
        };
        match result {
            Ok(snapshot) => {
                self.player.playing = snapshot.playing;
                self.player.elapsed_ms = snapshot.position_ms;
                self.last_progress_update = Instant::now();
                self.sync_lyric_to_progress();
                self.status = if snapshot.playing {
                    "正在播放".to_string()
                } else {
                    "已暂停".to_string()
                };
            }
            Err(error) => {
                self.player.error = Some(error.clone());
                self.status = error;
            }
        }
    }

    fn next_track(&mut self) {
        let Some(next) = self.queue.next_index() else {
            if self.queue.current_index().is_none() {
                self.status = "先在歌曲列表中选择一首歌".to_string();
                return;
            }
            if self.content.has_more() && matches!(self.queue.source(), QueueSource::Playlist(_)) {
                self.pending_queue_next = true;
                self.status = "正在加载队列中的下一首…".to_string();
                self.load_more_if_needed();
                return;
            }
            self.status = "播放列表已结束".to_string();
            return;
        };
        self.queue.set_current_index(next);
        if let Some(track) = self.queue.track_at(next).cloned() {
            self.select_track_in_content(track.id);
            self.play_track(track);
        }
    }

    fn previous_track(&mut self) {
        let Some(previous) = self.queue.previous_index() else {
            if self.queue.current_index().is_none() {
                self.status = "先在歌曲列表中选择一首歌".to_string();
                return;
            }
            self.request_seek(-(self.player.elapsed_ms.min(i64::MAX as u64) as i64));
            return;
        };
        self.queue.set_current_index(previous);
        if let Some(track) = self.queue.track_at(previous).cloned() {
            self.select_track_in_content(track.id);
            self.play_track(track);
        }
    }

    fn sync_lyric_to_progress(&mut self) {
        let Some(lyrics) = &self.lyrics else { return };
        let index = lyrics
            .lines
            .partition_point(|line| line.time_ms <= self.player.elapsed_ms);
        let next_index = index.checked_sub(1);
        self.set_lyric_index(next_index);
    }

    fn lyric_wake_after(&self) -> Option<Duration> {
        if !self.player.playing || self.player.loading {
            return None;
        }
        let lyrics = self.lyrics.as_ref()?;
        let position = self.audio.snapshot().position_ms;
        let next_index = lyrics
            .lines
            .partition_point(|line| line.time_ms <= position);
        let next_line = lyrics.lines.get(next_index)?;
        Some(Duration::from_millis(
            next_line.time_ms.saturating_sub(position),
        ))
    }

    fn seek_to(&mut self, next: u64) {
        match self.audio.seek(next) {
            Ok(snapshot) => {
                self.player.elapsed_ms = snapshot.position_ms;
                self.player.playing = snapshot.playing;
                self.last_progress_update = Instant::now();
                self.sync_lyric_to_progress();
                self.status = format!("播放进度 {}", format_time(snapshot.position_ms));
            }
            Err(error) => {
                self.player.error = Some(error.clone());
                self.status = error;
            }
        }
    }

    fn adjust_volume(&mut self, delta: f32) {
        let volume = (self.player.volume + delta).clamp(0.0, 1.0);
        self.audio.set_volume(volume);
        self.player.volume = self.audio.volume();
        self.status = format!("音量 {}%", (self.player.volume * 100.0).round() as u8);
    }

    fn start_queue_from_content(&mut self, selected_index: usize, fallback_track: Track) {
        let (queue, source) = match &self.content {
            Content::Daily { tracks } => (tracks.clone(), QueueSource::Daily),
            Content::Playlist { detail, tracks, .. } => {
                (tracks.clone(), QueueSource::Playlist(detail.id))
            }
            _ => (vec![fallback_track.clone()], QueueSource::None),
        };
        let current_index = queue
            .get(selected_index)
            .filter(|track| track.id == fallback_track.id)
            .map(|_| selected_index)
            .or_else(|| queue.iter().position(|track| track.id == fallback_track.id));
        self.queue = PlaybackQueue::new(queue, source, current_index);
        self.pending_queue_next = false;
        self.play_track(fallback_track);
    }

    fn select_track_in_content(&mut self, track_id: i64) {
        if let Some(index) = self
            .content
            .tracks()
            .and_then(|tracks| tracks.iter().position(|track| track.id == track_id))
        {
            self.content_index = index;
            self.keep_selection_visible(self.content_viewport_rows);
        }
    }

    fn set_lyric_index(&mut self, next_index: Option<usize>) {
        if self.lyric_index == next_index {
            return;
        }
        self.previous_lyric_index = self.lyric_index;
        self.lyric_index = next_index;
        let now = Instant::now();
        self.lyric_transition_started = Some(now);
        self.lyric_transition_until = Some(now + Duration::from_millis(260));
    }

    fn toggle_lyrics(&mut self) {
        if self.lyrics_visible {
            self.lyrics_visible = false;
            self.cancel_lyrics_request();
            self.lyrics = None;
            self.lyrics_error = None;
            self.lyric_index = None;
            self.previous_lyric_index = None;
            self.lyric_transition_until = None;
            self.lyric_transition_started = None;
        } else {
            self.lyrics_visible = true;
            if self.lyrics.is_none() {
                if let Some(track) = &self.player.current {
                    self.request_lyrics(track.id);
                }
            }
        }
    }

    fn request_lyrics(&mut self, track_id: i64) {
        self.cancel_lyrics_request();
        self.lyrics_error = None;
        let generation = self.lyrics_generation;
        let cancellation = RequestCancellation::new();
        self.lyrics_cancellation = Some(cancellation.clone());
        let core = Arc::clone(&self.core);
        let tx = self.tx.clone();
        self.lyrics_task = Some(tokio::spawn(async move {
            let _ = tx
                .send(Message::Lyrics {
                    generation,
                    track_id,
                    result: core.lyrics_cancellable(track_id, &cancellation).await,
                })
                .await;
        }));
    }

    fn cancel_lyrics_request(&mut self) {
        self.lyrics_generation = self.lyrics_generation.wrapping_add(1);
        cancel_request(&mut self.lyrics_task, &mut self.lyrics_cancellation);
    }

    fn cancel_content_request(&mut self) -> bool {
        if self.content_task.is_none() {
            return false;
        }
        self.content_generation = self.content_generation.wrapping_add(1);
        cancel_request(&mut self.content_task, &mut self.content_cancellation);
        self.pending_queue_next = false;
        match &mut self.content {
            Content::Loading { .. } => {
                self.content = Content::Empty;
                self.screen = Screen::Home;
            }
            Content::PlaylistList { loading_more, .. } | Content::Playlist { loading_more, .. } => {
                *loading_more = false;
            }
            _ => {}
        }
        self.status = "请求已取消".to_string();
        true
    }

    fn go_back(&mut self) {
        // `cancel_content_request` deliberately converts a generic loading
        // page back to Home. Capture the detail ownership first so a slow
        // playlist request still returns to its saved parent instead of
        // falling through to the root navigation focus.
        let returning_from_playlist = self.screen == Screen::Playlist;
        let incremental_load = matches!(
            self.content,
            Content::PlaylistList {
                loading_more: true,
                ..
            } | Content::Playlist {
                loading_more: true,
                ..
            }
        );
        if self.content_task.is_some() {
            self.cancel_content_request();
            if incremental_load {
                self.focus = Focus::Content;
                return;
            }
        }
        if returning_from_playlist {
            if let Some(parent) = self.playlist_return.take() {
                self.content = parent.content;
                self.content_index = parent.index.min(self.content.len().saturating_sub(1));
                self.content_scroll = parent.scroll.min(self.content_index);
                // A detail refresh may have saved a track-level position.
                // It belongs to the discarded detail request, never to the
                // restored parent playlist list.
                self.pending_content_position = None;
                self.keep_selection_visible(self.content_viewport_rows);
                self.screen = Screen::Home;
                self.focus = Focus::Content;
                self.status = "已返回歌单列表".to_string();
            } else {
                self.open_nav(self.nav);
            }
        } else if self.focus != Focus::Navigation {
            self.focus = Focus::Navigation;
        }
    }

    fn refresh(&mut self) {
        if matches!(
            self.auth,
            AuthState::QrLogin { .. }
                | AuthState::Login { .. }
                | AuthState::Failed(_)
                | AuthState::Restoring
        ) {
            self.retry_auth();
        } else {
            let selected_id = self
                .content
                .track_at(self.content_index)
                .map(|track| track.id)
                .or_else(|| {
                    self.content
                        .playlist_at(self.content_index)
                        .map(|playlist| playlist.id)
                });
            self.pending_content_position = Some(PendingContentPosition {
                index: self.content_index,
                scroll: self.content_scroll,
                selected_id,
            });
            if let Content::Playlist { detail, .. } = &self.content {
                let playlist_id = detail.id;
                self.open_playlist(playlist_id);
            } else {
                self.open_nav_impl(self.nav);
            }
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        // Invalidate a blocking decoder preparation before dropping the UI
        // owner. The worker may be inside an OS audio call that cannot be
        // aborted, but its post-call generation check will then stop and
        // discard the moved player instead of letting audio outlive the TUI.
        self.audio_prepare_generation.fetch_add(1, Ordering::AcqRel);
        cancel_request(&mut self.session_task, &mut self.session_cancellation);
        cancel_request(&mut self.content_task, &mut self.content_cancellation);
        cancel_request(&mut self.lyrics_task, &mut self.lyrics_cancellation);
        cancel_request(&mut self.stream_task, &mut self.stream_cancellation);
        cancel_request(&mut self.cache_task, &mut self.cache_cancellation);
        cancel_request(&mut self.audio_task, &mut self.audio_cancellation);
        cancel_request(&mut self.qr_task, &mut self.qr_cancellation);
        cancel_request(&mut self.auth_task, &mut self.auth_cancellation);
        self.audio.stop();
    }
}

fn cancel_request(
    task: &mut Option<JoinHandle<()>>,
    cancellation: &mut Option<RequestCancellation>,
) {
    if let Some(token) = cancellation.take() {
        token.cancel();
    }
    abort(task);
}

fn abort(slot: &mut Option<JoinHandle<()>>) {
    if let Some(task) = slot.take() {
        task.abort();
    }
}

fn contains(area: Rect, (x, y): (u16, u16)) -> bool {
    x >= area.x
        && x < area.x.saturating_add(area.width)
        && y >= area.y
        && y < area.y.saturating_add(area.height)
}

fn valid_phone(value: &str) -> bool {
    (7..=MAX_PHONE_DIGITS).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_captcha(value: &str) -> bool {
    (4..=MAX_CAPTCHA_DIGITS).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SmsLoginFailureStatus {
    /// Kept adjacent to the captcha field. It may contain a deliberate line
    /// break because the login form reserves two stable rows for feedback.
    form_status: String,
    /// The header only has one row, so it carries a short summary instead of
    /// truncating the actionable field-level explanation.
    header_status: String,
}

/// The service uses the same generic "account or password incorrect" response
/// for several rejected passwordless-login states. Do not present that as a
/// claim that the listener mistyped a code: it can also mean an expired or
/// mismatched server-side login challenge.
fn sms_login_failure_status(error: &CoreError) -> SmsLoginFailureStatus {
    match error {
        CoreError::Api(message) if is_network_risk_response(message) => SmsLoginFailureStatus {
            form_status: "登录失败：网易暂时拒绝此网络请求（网络风险）。\n请稍后再试，或先在官方网易云客户端完成登录。".to_string(),
            header_status: "登录未完成：网络风险限制".to_string(),
        },
        CoreError::Api(message)
            if message.contains("账号或密码错误") || message.contains("帐号或密码错误") =>
        {
            SmsLoginFailureStatus {
                form_status: "登录失败：服务端拒绝本次登录。\n验证码未必错误；请稍后再试。".to_string(),
                header_status: "登录未完成：服务端拒绝".to_string(),
            }
        }
        CoreError::Network(_) => SmsLoginFailureStatus {
            form_status: "登录失败：网络请求未完成。\n请检查连接后稍后再试。".to_string(),
            header_status: "登录未完成：网络请求失败".to_string(),
        },
        _ => SmsLoginFailureStatus {
            form_status: "登录失败：服务端未完成本次请求。\n请稍后再试。".to_string(),
            header_status: "登录未完成：服务端请求失败".to_string(),
        }
    }
}

fn is_network_risk_response(message: &str) -> bool {
    ["网络环境存在风险", "检测到您的网络", "网络风险"]
        .into_iter()
        .any(|marker| message.contains(marker))
}

fn is_terminal_sms_login_failure(status: &str) -> bool {
    status.starts_with("登录失败：")
}

fn invalidate_captcha_for_phone_change(form: &mut PhoneLogin) {
    if form.captcha_sent || !form.captcha.is_empty() || form.resend_available_at.is_some() {
        form.captcha_sent = false;
        form.captcha.clear();
        form.resend_available_at = None;
    }
}

pub fn format_time(milliseconds: u64) -> String {
    let seconds = milliseconds / 1_000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use clarus_core::{
        Album, Artist, CoreError, LyricLine, MusicCore, PlaylistDetail, PlaylistPage,
        PlaylistSummary, PlaylistTrackPage, QrLogin, QrLoginCheck, QrLoginStatus,
        RequestCancellation, SmsLogin, Track, TrackLyrics,
    };
    use crossterm::event::{
        KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::layout::Rect;
    use tokio::sync::mpsc;

    use crate::audio::{AudioSnapshot, NativePlayer};

    use super::{
        format_time, sms_login_failure_status, App, Content, Focus, HitAreas, InputMode,
        LoginField, Message, NavItem, PhoneLogin,
    };

    fn track(id: i64) -> Track {
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
    fn nav_shortcuts_are_stable() {
        assert_eq!(NavItem::from_number('1'), Some(NavItem::Daily));
        assert_eq!(NavItem::from_number('4'), Some(NavItem::Created));
        assert_eq!(NavItem::from_number('5'), None);
    }

    #[test]
    fn qr_countdown_and_expiry_are_visible_without_continuous_polling() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let now = Instant::now();
        app.auth = super::AuthState::QrLogin {
            qr: Some(QrLogin {
                key: "key".to_string(),
                login_url: "https://example.test/qr".to_string(),
            }),
            status: "请使用网易云音乐扫描二维码".to_string(),
            checking: false,
        };
        app.next_qr_check = now + Duration::from_secs(60);
        app.qr_expires_at = Some(now + Duration::from_secs(3));

        assert!(app.tick(now));
        let super::AuthState::QrLogin { status, .. } = &app.auth else {
            panic!("expected QR login state");
        };
        assert!(status.contains("有效期 3s"));

        app.qr_expires_at = Some(now - Duration::from_millis(1));
        assert!(app.tick(now));
        let super::AuthState::QrLogin {
            status,
            checking,
            qr,
        } = &app.auth
        else {
            panic!("expected expired QR login state");
        };
        assert!(qr.is_some());
        assert!(!checking);
        assert_eq!(status, "二维码已过期，请按 r 或 Enter 重新生成");
        assert!(app.qr_expires_at.is_none());
    }

    #[test]
    fn scanned_qr_explicitly_requests_phone_confirmation() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.qr_generation = 4;
        app.qr_expires_at = Some(Instant::now() + Duration::from_secs(60));
        app.auth = super::AuthState::QrLogin {
            qr: Some(QrLogin {
                key: "key".to_string(),
                login_url: "https://example.test/qr".to_string(),
            }),
            status: "等待扫描二维码".to_string(),
            checking: true,
        };

        app.handle_message(Message::QrCheck {
            generation: 4,
            result: Ok(QrLoginCheck {
                status: QrLoginStatus::Scanned,
                message: "等待确认".to_string(),
            }),
        });

        let super::AuthState::QrLogin {
            status, checking, ..
        } = &app.auth
        else {
            panic!("expected QR login state");
        };
        assert_eq!(status, "已扫码，请在网易云音乐 App 中确认登录");
        assert!(!checking);
        assert_eq!(app.status, "已扫码，请在网易云音乐 App 中确认登录");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_session_starts_the_qr_flow() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.session_generation = 3;

        app.handle_message(Message::Session {
            generation: 3,
            result: Ok(clarus_core::AuthSession {
                authenticated: false,
                user: None,
            }),
        });

        assert!(matches!(
            app.auth,
            super::AuthState::QrLogin {
                qr: None,
                checking: false,
                ..
            }
        ));
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(app.qr_task.is_some());
    }

    #[test]
    fn stale_content_messages_cannot_replace_the_current_generation() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content_generation = 2;
        app.content = Content::Empty;
        app.handle_message(Message::Daily {
            generation: 1,
            result: Ok(clarus_core::DailySongs {
                tracks: vec![track(1)],
            }),
        });
        assert!(matches!(app.content, Content::Empty));
    }

    #[test]
    fn refresh_preserves_selected_track_identity_when_service_order_changes() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content_generation = 4;
        app.content = Content::Daily {
            tracks: vec![track(1), track(2)],
        };
        app.content_index = 1;
        app.content_scroll = 1;
        app.pending_content_position = Some(super::PendingContentPosition {
            index: 1,
            scroll: 1,
            selected_id: Some(2),
        });

        app.handle_message(Message::Daily {
            generation: 4,
            result: Ok(clarus_core::DailySongs {
                tracks: vec![track(2), track(1)],
            }),
        });

        assert_eq!(app.content_index, 0);
        assert_eq!(
            app.content
                .track_at(app.content_index)
                .map(|track| track.id),
            Some(2)
        );
        assert_eq!(app.content_scroll, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn esc_from_playlist_detail_restores_the_parent_list_position() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 7,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.nav = NavItem::Saved;
        app.focus = Focus::Content;
        app.content = Content::PlaylistList {
            kind: super::PlaylistKind::Saved,
            items: vec![
                PlaylistSummary {
                    id: 11,
                    name: "first".to_string(),
                    creator_id: 2,
                    creator_name: "owner".to_string(),
                    track_count: 3,
                    owned: false,
                    subscribed: true,
                    liked: false,
                },
                PlaylistSummary {
                    id: 12,
                    name: "selected".to_string(),
                    creator_id: 3,
                    creator_name: "owner".to_string(),
                    track_count: 4,
                    owned: false,
                    subscribed: true,
                    liked: false,
                },
            ],
            next_offset: 50,
            has_more: true,
            loading_more: true,
        };
        app.content_index = 1;
        app.content_scroll = 1;

        app.open_playlist(12);
        assert_eq!(app.screen, super::Screen::Playlist);
        assert!(app.content_task.is_some());

        app.go_back();

        assert!(app.content_task.is_none());
        assert_eq!(app.screen, super::Screen::Home);
        assert_eq!(app.focus, Focus::Content);
        assert_eq!(app.content_index, 1);
        assert_eq!(app.content_scroll, 1);
        let Content::PlaylistList {
            items,
            next_offset,
            has_more,
            loading_more,
            ..
        } = &app.content
        else {
            panic!("expected the original playlist list to be restored")
        };
        assert_eq!(
            items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [11, 12]
        );
        assert_eq!(*next_offset, 50);
        assert!(*has_more);
        assert!(!*loading_more);
        assert_eq!(app.status, "已返回歌单列表");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_playlist_detail_keeps_a_reachable_parent_list() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 7,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.nav = NavItem::Created;
        app.content = Content::PlaylistList {
            kind: super::PlaylistKind::Created,
            items: vec![PlaylistSummary {
                id: 21,
                name: "created".to_string(),
                creator_id: 7,
                creator_name: "listener".to_string(),
                track_count: 1,
                owned: true,
                subscribed: false,
                liked: false,
            }],
            next_offset: 1,
            has_more: false,
            loading_more: false,
        };

        app.open_playlist(21);
        let generation = app.content_generation;
        app.handle_message(Message::PlaylistDetail {
            generation,
            result: Err(clarus_core::CoreError::Network("offline".to_string())),
        });
        assert!(matches!(app.content, Content::Offline { .. }));

        app.go_back();

        assert_eq!(app.screen, super::Screen::Home);
        assert!(matches!(app.content, Content::PlaylistList { .. }));
        assert_eq!(app.nav, NavItem::Created);
    }

    #[test]
    fn formats_fixed_width_seconds() {
        assert_eq!(format_time(0), "0:00");
        assert_eq!(format_time(62_000), "1:02");
    }

    #[test]
    fn network_risk_sms_login_error_explains_the_cause_and_recovery() {
        let failure = sms_login_failure_status(&CoreError::Api(
            "检测到您的网络环境存在风险，请稍后再试".to_string(),
        ));

        assert_eq!(failure.header_status, "登录未完成：网络风险限制");
        assert_eq!(
            failure.form_status,
            "登录失败：网易暂时拒绝此网络请求（网络风险）。\n请稍后再试，或先在官方网易云客户端完成登录。"
        );
        assert!(!failure.form_status.contains("验证码错误"));
        assert!(!failure.form_status.contains("重发"));
    }

    #[test]
    fn risk_failure_is_not_overwritten_or_retried_by_the_sms_cooldown() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let now = Instant::now();
        let failure = sms_login_failure_status(&CoreError::Api(
            "检测到您的网络环境存在风险，请稍后再试".to_string(),
        ));
        let expected_form_status = failure.form_status.clone();
        let expected_header_status = failure.header_status.clone();
        let mut form = PhoneLogin::new(expected_form_status.clone());
        form.phone = "13800138000".to_string();
        form.captcha = "123456".to_string();
        form.field = LoginField::Captcha;
        form.captcha_sent = true;
        form.resend_available_at = Some(now + Duration::from_secs(60));
        app.auth = super::AuthState::Login { form };
        app.status = expected_header_status.clone();

        assert!(!app.tick(now + Duration::from_secs(1)));
        app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE));
        assert!(app.auth_task.is_none());
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert_eq!(form.status, expected_form_status);
        assert!(form.resend_available_at.is_some());
        assert_eq!(app.status, expected_header_status);

        assert!(app.tick(now + Duration::from_secs(61)));
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert!(form.resend_available_at.is_none());
        assert_eq!(form.status, expected_form_status);
        assert_eq!(app.status, expected_header_status);
    }

    #[test]
    fn sms_resend_countdown_updates_and_unlocks_without_a_busy_poll() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let now = Instant::now();
        let mut form = PhoneLogin::new("验证码已发送，请输入短信验证码");
        form.phone = "13800138000".to_string();
        form.captcha_sent = true;
        form.field = LoginField::Captcha;
        form.resend_available_at = Some(now + Duration::from_secs(3));
        app.auth = super::AuthState::Login { form };

        assert!(app.tick(now));
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert!(form.status.contains("3s 后可重发"));

        assert!(app.tick(now + Duration::from_secs(4)));
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert!(form.resend_available_at.is_none());
        assert!(form.status.contains("现在可按 r 重发"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_keychain_restore_switches_to_qr_without_a_second_restore() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Failed("secure storage unavailable".to_string());

        assert!(!app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE,)));
        assert!(matches!(
            app.auth,
            super::AuthState::QrLogin {
                qr: None,
                checking: false,
                ..
            }
        ));
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(app.qr_task.is_some());
        assert!(app.session_task.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restoring_keychain_can_switch_to_qr_without_a_stale_session_result() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Restoring;
        app.session_generation = 9;
        let cancellation = RequestCancellation::new();
        app.session_cancellation = Some(cancellation.clone());
        app.session_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

        assert!(cancellation.is_cancelled());
        assert!(app.session_task.is_none());
        assert_eq!(app.session_generation, 10);
        assert!(matches!(app.auth, super::AuthState::QrLogin { .. }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn phone_form_routes_digits_send_completion_and_login_state() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.begin_phone_login();
        for digit in "13800138000".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(digit), KeyModifiers::NONE));
        }
        let generation = 7;
        app.auth_generation = generation;
        if let super::AuthState::Login { form } = &mut app.auth {
            assert_eq!(form.phone, "13800138000");
            form.sending = true;
        }

        app.handle_message(Message::CaptchaSent {
            generation,
            result: Ok(()),
        });
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert!(form.captcha_sent);
        assert_eq!(form.field, LoginField::Captcha);
        assert_eq!(app.input_mode, InputMode::Captcha);

        assert!(app.handle_paste("123456"));
        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert_eq!(form.captcha, "123456");
        app.auth_generation = app.auth_generation.wrapping_add(1);
        let login_generation = app.auth_generation;
        app.handle_message(Message::SmsLogin {
            generation: login_generation,
            result: Ok(SmsLogin {
                user: clarus_core::AuthUser {
                    user_id: 7,
                    nickname: "listener".to_string(),
                    vip_type: 0,
                },
                saved_to_keychain: false,
            }),
        });
        assert!(matches!(app.auth, super::AuthState::Authenticated(_)));
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(app.status.contains("未能保存"));
    }

    #[test]
    fn changing_the_phone_invalidates_the_old_captcha_and_resend_cooldown() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let mut form = PhoneLogin::new("输入手机号后按 Enter 发送验证码");
        form.phone = "13800138000".to_string();
        form.captcha = "123456".to_string();
        form.captcha_sent = true;
        form.resend_available_at = Some(Instant::now() + Duration::from_secs(60));
        app.auth = super::AuthState::Login { form };
        app.input_mode = InputMode::PhoneNumber;

        app.handle_key(KeyEvent::new(KeyCode::Char('1'), KeyModifiers::NONE));

        let super::AuthState::Login { form } = &app.auth else {
            panic!("expected SMS login state");
        };
        assert!(!form.captcha_sent);
        assert!(form.captcha.is_empty());
        assert!(form.resend_available_at.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn esc_cancels_an_inflight_sms_operation() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.begin_phone_login();
        let cancellation = RequestCancellation::new();
        app.auth_cancellation = Some(cancellation.clone());
        app.auth_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));
        if let super::AuthState::Login { form } = &mut app.auth {
            form.authenticating = true;
        }

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

        assert!(cancellation.is_cancelled());
        assert!(app.auth_task.is_none());
        assert!(matches!(app.auth, super::AuthState::Login { .. }));
        assert_eq!(app.status, "登录请求已取消");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queue_keeps_service_order_when_starting_from_a_selection() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let tracks = vec![track(1), track(2), track(3)];
        app.content = Content::Daily {
            tracks: tracks.clone(),
        };
        app.start_queue_from_content(1, tracks[1].clone());
        assert_eq!(
            app.queue
                .tracks()
                .iter()
                .map(|track| track.id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(app.queue.current_index(), Some(1));
    }

    #[test]
    fn lyric_index_uses_audio_time_not_line_count() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.lyrics = Some(TrackLyrics {
            instrumental: false,
            lines: vec![
                LyricLine {
                    time_ms: 1_000,
                    original: "first".to_string(),
                },
                LyricLine {
                    time_ms: 5_000,
                    original: "second".to_string(),
                },
            ],
        });
        app.player.elapsed_ms = 5_200;
        app.sync_lyric_to_progress();
        assert_eq!(app.lyric_index, Some(1));
    }

    #[test]
    fn animation_wakeup_targets_120hz_only_while_a_transition_is_active() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        let now = Instant::now();
        app.lyric_transition_until = Some(now + Duration::from_millis(200));
        app.lyric_transition_started = Some(now);

        assert!(
            app.next_wake_after(now, true) <= Duration::from_micros(8_333),
            "active lyric transitions should be scheduled at the 120Hz budget"
        );
        assert_eq!(
            app.next_wake_after(now, false),
            Duration::from_millis(50),
            "capability-limited terminals must not spend 120Hz redraws on ANSI state jumps"
        );

        app.lyric_transition_until = None;
        app.lyric_transition_started = None;
        assert_eq!(app.next_wake_after(now, true), Duration::from_secs(60));
    }

    #[test]
    fn tab_cycles_only_real_keyboard_panes() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.focus = Focus::Player;
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Navigation);
    }

    #[test]
    fn tab_skips_hidden_content_pane_in_narrow_lyrics_mode() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.lyrics_only = true;

        app.focus = Focus::Navigation;
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Player);

        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Navigation);
    }

    #[test]
    fn plain_q_is_not_a_quit_shortcut_but_ctrl_x_is_primary_and_ctrl_q_aliases() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        assert!(!app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE,)));
        assert!(app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL,)));
        assert!(app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL,)));
    }

    #[test]
    fn stale_audio_preparation_cannot_replace_the_newer_track() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.playback_generation = 2;
        app.player.current = Some(track(2));
        app.player.loading = true;

        app.handle_message(Message::AudioLoaded {
            generation: 1,
            track: track(1),
            cache_hit: false,
            audio: NativePlayer::default(),
            result: Ok(AudioSnapshot {
                position_ms: 0,
                duration_ms: 120_000,
                playing: true,
            }),
        });

        assert_eq!(app.player.current.as_ref().map(|track| track.id), Some(2));
        assert!(app.player.loading);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_stream_result_does_not_detach_the_current_request_owner() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.playback_generation = 2;
        app.player.current = Some(track(2));
        let cancellation = RequestCancellation::new();
        app.stream_cancellation = Some(cancellation.clone());
        app.stream_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));

        app.handle_message(Message::Stream {
            generation: 1,
            track: track(1),
            result: Err(clarus_core::CoreError::Cancelled),
        });

        assert!(app.stream_task.is_some());
        assert!(!cancellation.is_cancelled());
        if let Some(task) = app.stream_task.take() {
            task.abort();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_cache_result_does_not_detach_the_current_request_owner() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.playback_generation = 2;
        app.player.current = Some(track(2));
        let cancellation = RequestCancellation::new();
        app.cache_cancellation = Some(cancellation.clone());
        app.cache_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));

        app.handle_message(Message::CachedAudio {
            generation: 1,
            track: track(1),
            result: Err(clarus_core::CoreError::Cancelled),
        });

        assert!(app.cache_task.is_some());
        assert!(!cancellation.is_cancelled());
        if let Some(task) = app.cache_task.take() {
            task.abort();
        }
    }

    #[test]
    fn completed_audio_prepare_uses_the_latest_volume() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.playback_generation = 1;
        app.player.current = Some(track(1));
        app.player.loading = true;
        app.player.volume = 0.35;

        app.handle_message(Message::AudioLoaded {
            generation: 1,
            track: track(1),
            cache_hit: false,
            audio: NativePlayer::default(),
            result: Err("decoder failed".to_string()),
        });

        assert_eq!(app.audio.volume(), 0.35);
        assert!(!app.player.loading);
        assert_eq!(app.player.error.as_deref(), Some("decoder failed"));
    }

    #[test]
    fn ordinary_mouse_click_does_not_activate_content() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content = Content::Daily {
            tracks: vec![track(1)],
        };
        app.set_hit_areas(HitAreas {
            content: Rect::new(0, 0, 40, 10),
            ..HitAreas::default()
        });
        let event = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 3,
            row: 3,
            modifiers: KeyModifiers::NONE,
        };
        assert!(!app.handle_mouse(event));
        assert_eq!(app.content_index, 0);
        assert!(app.player.current.is_none());
    }

    #[test]
    fn trackpad_scroll_burst_is_limited_to_one_row() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content = Content::Daily {
            tracks: vec![track(1), track(2), track(3)],
        };
        app.focus = Focus::Player;
        app.set_hit_areas(HitAreas {
            content: Rect::new(0, 0, 40, 10),
            ..HitAreas::default()
        });
        let scroll = |kind| MouseEvent {
            kind,
            column: 3,
            row: 3,
            modifiers: KeyModifiers::NONE,
        };
        assert!(app.handle_mouse(scroll(MouseEventKind::ScrollDown)));
        assert_eq!(app.focus, Focus::Content);
        assert_eq!(app.content_index, 1);
        assert!(!app.handle_mouse(scroll(MouseEventKind::ScrollDown)));
        assert_eq!(app.content_index, 1);
    }

    #[test]
    fn lyrics_only_mode_does_not_move_or_activate_hidden_list() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.content = Content::Daily {
            tracks: vec![track(1), track(2)],
        };
        app.focus = Focus::Content;
        app.set_lyrics_only(true);

        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.content_index, 0);
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.player.current.is_none());

        app.focus = Focus::Player;
        app.set_hit_areas(HitAreas {
            content: Rect::new(0, 0, 40, 10),
            ..HitAreas::default()
        });
        assert!(!app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 3,
            row: 3,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(app.focus, Focus::Player);
        assert_eq!(app.content_index, 0);

        app.set_lyrics_only(false);
        app.focus = Focus::Content;
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.content_index, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn esc_cancels_a_loading_content_request() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.focus = Focus::Content;
        app.content = Content::Loading {
            label: "正在加载每日推荐…".to_string(),
        };
        app.content_task = Some(tokio::spawn(async {
            std::future::pending::<()>().await;
        }));

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

        assert!(app.content_task.is_none());
        assert!(matches!(app.content, Content::Empty));
        assert_eq!(app.focus, Focus::Navigation);
        assert_eq!(app.status, "请求已取消");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_permission_state_can_start_qr_reauthentication() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.content = Content::NoPermission {
            message: "需要重新登录".to_string(),
        };

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

        assert!(matches!(app.auth, super::AuthState::QrLogin { .. }));
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(app.qr_task.is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn playback_auth_expiry_exposes_the_same_qr_recovery_path() {
        let (tx, _rx) = mpsc::channel(8);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.auth = super::AuthState::Authenticated(clarus_core::AuthUser {
            user_id: 1,
            nickname: "listener".to_string(),
            vip_type: 0,
        });
        app.player.current = Some(track(1));
        app.player.loading = true;
        app.content = Content::Daily {
            tracks: vec![track(1)],
        };

        app.handle_message(Message::Stream {
            generation: 0,
            track: track(1),
            result: Err(clarus_core::CoreError::AuthRequired(
                "session expired".to_string(),
            )),
        });

        assert!(matches!(app.content, Content::NoPermission { .. }));
        assert_eq!(
            app.player.error.as_deref(),
            Some("authentication required: session expired")
        );
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(matches!(app.auth, super::AuthState::QrLogin { .. }));
        assert_eq!(app.input_mode, InputMode::Navigation);
        assert!(app.qr_task.is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn empty_track_pages_probe_a_few_times_then_stop() {
        let (tx, _rx) = mpsc::channel(8);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content_generation = 1;
        app.content = Content::Playlist {
            detail: PlaylistDetail {
                id: 42,
                name: "list".to_string(),
                creator_id: 7,
                creator_name: "owner".to_string(),
                update_time: 0,
                track_count: 500,
                description: String::new(),
                private: false,
                owned: false,
                subscribed: true,
                track_ids: (1..=500).collect(),
                tracks: vec![track(1)],
                next_offset: 100,
                has_more: true,
            },
            tracks: vec![track(1)],
            next_offset: 100,
            has_more: true,
            loading_more: true,
        };

        for _ in 0..4 {
            app.content_task = None;
            app.content_cancellation = None;
            app.handle_message(Message::TrackPage {
                generation: 1,
                result: Ok(PlaylistTrackPage {
                    tracks: Vec::new(),
                    requested_count: 100,
                }),
            });
            if let Some(task) = app.content_task.take() {
                task.abort();
            }
            app.content_cancellation = None;
        }

        let Content::Playlist { has_more, .. } = app.content else {
            panic!("expected playlist content")
        };
        assert!(!has_more);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn empty_playlist_pages_do_not_repeat_the_same_offset_forever() {
        let (tx, _rx) = mpsc::channel(8);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content_generation = 1;
        app.content = Content::PlaylistList {
            kind: super::PlaylistKind::Saved,
            items: vec![PlaylistSummary {
                id: 1,
                name: "saved".to_string(),
                creator_id: 2,
                creator_name: "owner".to_string(),
                track_count: 1,
                owned: false,
                subscribed: true,
                liked: false,
            }],
            next_offset: 50,
            has_more: true,
            loading_more: true,
        };

        for _ in 0..4 {
            app.content_task = None;
            app.content_cancellation = None;
            app.handle_message(Message::PlaylistPage {
                generation: 1,
                kind: super::PlaylistKind::Saved,
                page: true,
                result: Ok(PlaylistPage {
                    items: Vec::new(),
                    next_offset: 50,
                    has_more: true,
                }),
            });
            if let Some(task) = app.content_task.take() {
                task.abort();
            }
            app.content_cancellation = None;
        }

        let Content::PlaylistList { has_more, .. } = app.content else {
            panic!("expected playlist list content")
        };
        assert!(!has_more);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn regressing_playlist_cursor_stops_further_page_requests() {
        let (tx, _rx) = mpsc::channel(8);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.content_generation = 1;
        app.content = Content::PlaylistList {
            kind: super::PlaylistKind::Saved,
            items: vec![PlaylistSummary {
                id: 1,
                name: "saved".to_string(),
                creator_id: 2,
                creator_name: "owner".to_string(),
                track_count: 1,
                owned: false,
                subscribed: true,
                liked: false,
            }],
            next_offset: 50,
            has_more: true,
            loading_more: true,
        };

        app.handle_message(Message::PlaylistPage {
            generation: 1,
            kind: super::PlaylistKind::Saved,
            page: true,
            result: Ok(PlaylistPage {
                items: vec![PlaylistSummary {
                    id: 2,
                    name: "new".to_string(),
                    creator_id: 3,
                    creator_name: "owner".to_string(),
                    track_count: 2,
                    owned: false,
                    subscribed: true,
                    liked: false,
                }],
                next_offset: 40,
                has_more: true,
            }),
        });

        let Content::PlaylistList {
            has_more,
            loading_more,
            items,
            ..
        } = &app.content
        else {
            panic!("expected playlist list content");
        };
        assert!(!*has_more);
        assert!(!*loading_more);
        assert_eq!(items.len(), 2);
        assert!(app.status.contains("没有继续推进"));
    }

    #[test]
    fn divider_drag_updates_sidebar_width() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.set_hit_areas(HitAreas {
            body: Rect::new(0, 0, 120, 20),
            sidebar_divider: Rect::new(19, 0, 1, 20),
            lyrics_divider: Rect::new(80, 0, 1, 20),
            ..HitAreas::default()
        });
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 19,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 30,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(app.sidebar_width, 31);
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 30,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));

        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 80,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 0,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
        // body 120 - sidebar 31 - content minimum 34 = 55; the lyric
        // divider must stay inside that bound (and above its 28-cell floor).
        assert_eq!(app.lyrics_width, 55);
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 0,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
    }

    #[test]
    fn sidebar_drag_respects_the_current_lyrics_width() {
        let (tx, _rx) = mpsc::channel(4);
        let mut app = App::new_for_test(Arc::new(MusicCore::new()), tx);
        app.lyrics_width = 50;
        app.set_hit_areas(HitAreas {
            body: Rect::new(0, 0, 120, 20),
            sidebar_divider: Rect::new(19, 0, 1, 20),
            lyrics_divider: Rect::new(69, 0, 1, 20),
            ..HitAreas::default()
        });

        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 19,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: 119,
            row: 4,
            modifiers: KeyModifiers::NONE,
        }));

        // 120 cells - 34-cell content floor - 50-cell lyric pane.
        assert_eq!(app.sidebar_width, 36);
    }
}
