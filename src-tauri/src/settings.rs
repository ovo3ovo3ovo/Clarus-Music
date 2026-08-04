use std::{
    collections::HashSet,
    io::{ErrorKind, Write},
    net::IpAddr,
    path::{Path, PathBuf},
};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::{fs, sync::Mutex};

use crate::{audio_cache::AudioCacheState, music_api::MusicApiState, unblock::UnblockMusicState};

const SETTINGS_SCHEMA_VERSION: u16 = 1;
const SETTINGS_FILE_NAME: &str = "settings.json";

pub struct SettingsState {
    write_lock: Mutex<()>,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            write_lock: Mutex::new(()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFailure {
    kind: &'static str,
    message: String,
}

impl SettingsFailure {
    fn io(action: &str, error: std::io::Error) -> Self {
        Self {
            kind: "io",
            message: format!("Failed to {action} settings: {error}"),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid-settings",
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Locale {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
    #[serde(rename = "zh-TW")]
    TraditionalChinese,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "tr")]
    Turkish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    #[serde(rename = "oled", alias = "dark", alias = "auto")]
    Oled,
    #[default]
    #[serde(rename = "light", alias = "violet", alias = "green")]
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum MusicQuality {
    #[serde(rename = "128000")]
    Kbps128,
    #[serde(rename = "192000")]
    Kbps192,
    #[default]
    #[serde(rename = "320000")]
    Kbps320,
    #[serde(rename = "flac")]
    Lossless,
    #[serde(rename = "999000")]
    HiRes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LyricsBackground {
    Off,
    #[default]
    Cover,
    Blur,
    Dynamic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CloseAppOption {
    #[default]
    Ask,
    Exit,
    MinimizeToTray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProxyProtocol {
    #[default]
    NoProxy,
    Http,
    Https,
    Socks5,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxyConfig {
    pub protocol: ProxyProtocol,
    pub server: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub name: String,
    pub shortcut: String,
    pub global_shortcut: String,
}

fn default_shortcuts() -> Vec<Shortcut> {
    [
        (
            "play",
            "播放/暂停",
            "CommandOrControl+P",
            "Alt+CommandOrControl+P",
        ),
        (
            "next",
            "下一首",
            "CommandOrControl+Right",
            "Alt+CommandOrControl+Right",
        ),
        (
            "previous",
            "上一首",
            "CommandOrControl+Left",
            "Alt+CommandOrControl+Left",
        ),
        (
            "increaseVolume",
            "增加音量",
            "CommandOrControl+Up",
            "Alt+CommandOrControl+Up",
        ),
        (
            "decreaseVolume",
            "减少音量",
            "CommandOrControl+Down",
            "Alt+CommandOrControl+Down",
        ),
        (
            "like",
            "喜欢歌曲",
            "CommandOrControl+L",
            "Alt+CommandOrControl+L",
        ),
        (
            "minimize",
            "隐藏/显示播放器",
            "Alt+Shift+CommandOrControl+M",
            "Alt+Shift+CommandOrControl+M",
        ),
    ]
    .into_iter()
    .map(|(id, name, shortcut, global_shortcut)| Shortcut {
        id: id.to_string(),
        name: name.to_string(),
        shortcut: shortcut.to_string(),
        global_shortcut: global_shortcut.to_string(),
    })
    .collect()
}

fn default_schema_version() -> u16 {
    SETTINGS_SCHEMA_VERSION
}

fn default_music_quality() -> MusicQuality {
    MusicQuality::Kbps320
}

fn default_lyric_font_size() -> u16 {
    36
}

fn default_output_device() -> String {
    "default".to_string()
}

fn default_true() -> bool {
    true
}

fn default_cache_limit() -> Option<u32> {
    Some(8192)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_schema_version")]
    pub schema_version: u16,
    pub locale: Locale,
    pub appearance: Appearance,
    #[serde(default = "default_music_quality")]
    pub music_quality: MusicQuality,
    #[serde(default = "default_lyric_font_size")]
    pub lyric_font_size: u16,
    #[serde(default = "default_output_device")]
    pub output_device: String,
    #[serde(default = "default_true")]
    pub enable_unblock_netease_music: bool,
    #[serde(default = "default_true")]
    pub automatically_cache_songs: bool,
    #[serde(default = "default_cache_limit")]
    pub cache_limit_mb: Option<u32>,
    #[serde(default = "default_true")]
    pub show_lyrics_translation: bool,
    pub lyrics_background: LyricsBackground,
    pub close_app_option: CloseAppOption,
    #[serde(default = "default_true")]
    pub enable_global_shortcut: bool,
    pub proxy: ProxyConfig,
    pub enable_real_ip: bool,
    pub real_ip: Option<String>,
    #[serde(default = "default_shortcuts")]
    pub shortcuts: Vec<Shortcut>,
    pub unblock_sources: Vec<String>,
    pub unblock_search_mode: String,
    pub unblock_enable_flac: bool,
    pub unblock_proxy_uri: Option<String>,
    pub unblock_ytdl_executable: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            locale: Locale::default(),
            appearance: Appearance::default(),
            music_quality: default_music_quality(),
            lyric_font_size: default_lyric_font_size(),
            output_device: default_output_device(),
            enable_unblock_netease_music: true,
            automatically_cache_songs: true,
            cache_limit_mb: default_cache_limit(),
            show_lyrics_translation: true,
            lyrics_background: LyricsBackground::Cover,
            close_app_option: CloseAppOption::Ask,
            enable_global_shortcut: true,
            proxy: ProxyConfig::default(),
            enable_real_ip: false,
            real_ip: None,
            shortcuts: default_shortcuts(),
            unblock_sources: Vec::new(),
            unblock_search_mode: "fast-first".to_string(),
            unblock_enable_flac: false,
            unblock_proxy_uri: None,
            unblock_ytdl_executable: None,
        }
    }
}

impl AppSettings {
    fn validate(mut self) -> Result<Self, SettingsFailure> {
        if self.schema_version > SETTINGS_SCHEMA_VERSION {
            return Err(SettingsFailure::invalid(format!(
                "Unsupported settings schema version {}",
                self.schema_version
            )));
        }
        self.schema_version = SETTINGS_SCHEMA_VERSION;
        migrate_reserved_window_shortcuts(&mut self.shortcuts);

        self.lyric_font_size = normalize_lyric_font_size(self.lyric_font_size);
        if ![36, 44, 52, 60].contains(&self.lyric_font_size) {
            return Err(SettingsFailure::invalid(
                "lyricFontSize must be one of 36, 44, 52, or 60",
            ));
        }
        validate_text("outputDevice", &self.output_device, 1, 512)?;
        if self
            .cache_limit_mb
            .is_some_and(|limit| !(128..=1_048_576).contains(&limit))
        {
            return Err(SettingsFailure::invalid(
                "cacheLimitMb must be null or between 128 and 1048576",
            ));
        }
        validate_text("proxy.server", &self.proxy.server, 0, 2048)?;
        if self.proxy.protocol != ProxyProtocol::NoProxy
            && (self.proxy.server.is_empty() || self.proxy.port.is_none())
        {
            return Err(SettingsFailure::invalid(
                "An enabled proxy requires both server and port",
            ));
        }
        if let Some(real_ip) = &self.real_ip {
            real_ip.parse::<IpAddr>().map_err(|_| {
                SettingsFailure::invalid("realIp must be a valid IPv4 or IPv6 address")
            })?;
        }
        if self.enable_real_ip && self.real_ip.is_none() {
            return Err(SettingsFailure::invalid(
                "enableRealIp requires a realIp value",
            ));
        }
        validate_unique_shortcuts(&self.shortcuts)?;
        if self.unblock_sources.len() > 16 {
            return Err(SettingsFailure::invalid(
                "unblockSources cannot contain more than 16 entries",
            ));
        }
        validate_unique_texts("unblockSources", &self.unblock_sources, 64)?;
        self.unblock_sources
            .retain(|source| ["kugou", "ytdl"].contains(&source.as_str()));
        if !["fast-first", "order-first"].contains(&self.unblock_search_mode.as_str()) {
            return Err(SettingsFailure::invalid(
                "unblockSearchMode must be fast-first or order-first",
            ));
        }
        validate_optional_text("unblockProxyUri", &self.unblock_proxy_uri, 2048)?;
        validate_optional_text("unblockYtdlExecutable", &self.unblock_ytdl_executable, 2048)?;

        Ok(self)
    }

    fn proxy_url(&self) -> Option<String> {
        if self.proxy.protocol == ProxyProtocol::NoProxy {
            return None;
        }
        let protocol = match self.proxy.protocol {
            ProxyProtocol::NoProxy => return None,
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            ProxyProtocol::Socks5 => "socks5",
        };
        let server = if self.proxy.server.contains(':') && !self.proxy.server.starts_with('[') {
            format!("[{}]", self.proxy.server)
        } else {
            self.proxy.server.clone()
        };
        self.proxy
            .port
            .map(|port| format!("{protocol}://{server}:{port}"))
    }

    fn effective_real_ip(&self) -> Option<String> {
        if self.enable_real_ip {
            self.real_ip.clone()
        } else {
            None
        }
    }
}

fn normalize_lyric_font_size(value: u16) -> u16 {
    match value {
        44 | 52 | 60 => value,
        16 | 22 | 28 | 36 => 36,
        other => other,
    }
}

fn validate_text(
    field: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), SettingsFailure> {
    let length = value.chars().count();
    if !(minimum..=maximum).contains(&length) {
        return Err(SettingsFailure::invalid(format!(
            "{field} must contain between {minimum} and {maximum} characters"
        )));
    }
    Ok(())
}

fn validate_optional_text(
    field: &str,
    value: &Option<String>,
    maximum: usize,
) -> Result<(), SettingsFailure> {
    if let Some(value) = value {
        validate_text(field, value, 1, maximum)?;
    }
    Ok(())
}

fn validate_unique_texts(
    field: &str,
    values: &[String],
    maximum_length: usize,
) -> Result<(), SettingsFailure> {
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        validate_text(field, value, 1, maximum_length)?;
        if !seen.insert(value) {
            return Err(SettingsFailure::invalid(format!(
                "{field} cannot contain duplicate values"
            )));
        }
    }
    Ok(())
}

fn validate_unique_shortcuts(shortcuts: &[Shortcut]) -> Result<(), SettingsFailure> {
    if shortcuts.len() > 32 {
        return Err(SettingsFailure::invalid(
            "shortcuts cannot contain more than 32 entries",
        ));
    }
    let mut ids = HashSet::with_capacity(shortcuts.len());
    for shortcut in shortcuts {
        validate_text("shortcut.id", &shortcut.id, 1, 64)?;
        validate_text("shortcut.name", &shortcut.name, 1, 128)?;
        validate_text("shortcut.shortcut", &shortcut.shortcut, 0, 128)?;
        validate_text("shortcut.globalShortcut", &shortcut.global_shortcut, 0, 128)?;
        if !ids.insert(&shortcut.id) {
            return Err(SettingsFailure::invalid(
                "shortcuts cannot contain duplicate ids",
            ));
        }
    }
    Ok(())
}

fn migrate_reserved_window_shortcuts(shortcuts: &mut [Shortcut]) {
    for shortcut in shortcuts {
        if shortcut.id == "minimize"
            && shortcut.shortcut == "CommandOrControl+M"
            && shortcut.global_shortcut == "Alt+CommandOrControl+M"
        {
            shortcut.shortcut = "Alt+Shift+CommandOrControl+M".to_string();
            shortcut.global_shortcut = "Alt+Shift+CommandOrControl+M".to_string();
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, SettingsFailure> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE_NAME))
        .map_err(|error| SettingsFailure {
            kind: "path",
            message: format!("Failed to resolve the settings directory: {error}"),
        })
}

async fn read_settings(path: &Path) -> Result<AppSettings, SettingsFailure> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(AppSettings::default()),
        Err(error) => return Err(SettingsFailure::io("read", error)),
    };
    let settings =
        serde_json::from_slice::<AppSettings>(&bytes).map_err(|error| SettingsFailure {
            kind: "invalid-json",
            message: format!("Failed to parse settings: {error}"),
        })?;
    settings.validate()
}

async fn write_settings(path: &Path, settings: &AppSettings) -> Result<(), SettingsFailure> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| SettingsFailure {
        kind: "serialization",
        message: format!("Failed to serialize settings: {error}"),
    })?;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let parent = path
            .parent()
            .ok_or_else(|| SettingsFailure::invalid("Settings path has no parent directory"))?;
        std::fs::create_dir_all(parent)
            .map_err(|error| SettingsFailure::io("create the settings directory for", error))?;
        let mut file = AtomicWriteFile::open(&path)
            .map_err(|error| SettingsFailure::io("open the atomic", error))?;
        file.write_all(&bytes)
            .map_err(|error| SettingsFailure::io("write", error))?;
        file.commit()
            .map_err(|error| SettingsFailure::io("atomically replace", error))
    })
    .await
    .map_err(|error| SettingsFailure {
        kind: "task-failed",
        message: format!("The settings writer task failed: {error}"),
    })?
}

#[tauri::command]
pub async fn load_settings(
    app: AppHandle,
    music_state: State<'_, MusicApiState>,
    cache_state: State<'_, AudioCacheState>,
    unblock_state: State<'_, UnblockMusicState>,
) -> Result<AppSettings, SettingsFailure> {
    let settings = read_settings(&settings_path(&app)?).await?;
    let client = MusicApiState::build_client(settings.proxy_url().as_deref()).map_err(|error| {
        SettingsFailure::invalid(format!(
            "Failed to configure the music API proxy: {}",
            error.into_message()
        ))
    })?;
    let real_ip = settings.effective_real_ip();
    music_state.replace_network_client(client, real_ip).await;
    cache_state.apply_settings(settings.automatically_cache_songs, settings.cache_limit_mb);
    unblock_state.apply_settings(&settings).await;
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    music_state: State<'_, MusicApiState>,
    cache_state: State<'_, AudioCacheState>,
    unblock_state: State<'_, UnblockMusicState>,
    settings: AppSettings,
) -> Result<(), SettingsFailure> {
    let settings = settings.validate()?;
    let client = MusicApiState::build_client(settings.proxy_url().as_deref()).map_err(|error| {
        SettingsFailure::invalid(format!(
            "Failed to configure the music API proxy: {}",
            error.into_message()
        ))
    })?;
    let real_ip = settings.effective_real_ip();
    let _guard = state.write_lock.lock().await;
    write_settings(&settings_path(&app)?, &settings).await?;
    music_state.replace_network_client(client, real_ip).await;
    cache_state.apply_settings(settings.automatically_cache_songs, settings.cache_limit_mb);
    unblock_state.apply_settings(&settings).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        read_settings, write_settings, AppSettings, Appearance, LyricsBackground, ProxyConfig,
        ProxyProtocol, SETTINGS_SCHEMA_VERSION,
    };

    #[test]
    fn defaults_match_the_migration_contract() {
        let settings = AppSettings::default();

        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(settings.lyric_font_size, 36);
        assert_eq!(settings.cache_limit_mb, Some(8192));
        assert_eq!(settings.appearance, Appearance::Light);
        assert_eq!(settings.lyrics_background, LyricsBackground::Cover);
        assert_eq!(settings.shortcuts.len(), 7);
    }

    #[test]
    fn missing_fields_receive_defaults() {
        let settings: AppSettings = serde_json::from_str("{}").expect("default settings");

        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn validation_promotes_retired_lyric_font_sizes_to_the_new_minimum() {
        for legacy_size in [16, 22, 28] {
            let settings = AppSettings {
                lyric_font_size: legacy_size,
                ..AppSettings::default()
            }
            .validate()
            .expect("legacy lyric font size");

            assert_eq!(settings.lyric_font_size, 36);
        }
    }

    #[test]
    fn ignores_removed_playback_preferences_from_legacy_settings() {
        let settings: AppSettings = serde_json::from_str(
            r#"{
                "musicLanguage": "jp",
                "subTitleDefault": false,
                "enableReversedMode": true
            }"#,
        )
        .expect("legacy settings");

        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn validation_migrates_removed_unblock_sources() {
        let settings = AppSettings {
            unblock_sources: vec!["pyncm".to_string(), "kugou".to_string()],
            ..AppSettings::default()
        }
        .validate()
        .expect("legacy settings");

        assert_eq!(settings.unblock_sources, ["kugou"]);
    }

    #[test]
    fn legacy_color_appearances_migrate_to_light() {
        for appearance in ["violet", "green"] {
            let settings: AppSettings =
                serde_json::from_str(&format!(r#"{{"appearance":"{appearance}"}}"#))
                    .expect("legacy appearance alias");

            assert_eq!(settings.appearance, Appearance::Light);
        }
    }

    #[test]
    fn validation_moves_the_legacy_minimize_shortcut_off_reserved_macos_keys() {
        let mut settings = AppSettings::default();
        let minimize = settings
            .shortcuts
            .iter_mut()
            .find(|shortcut| shortcut.id == "minimize")
            .expect("default minimize shortcut");
        minimize.shortcut = "CommandOrControl+M".to_string();
        minimize.global_shortcut = "Alt+CommandOrControl+M".to_string();

        let migrated = settings.validate().expect("legacy shortcut is migratable");
        let minimize = migrated
            .shortcuts
            .iter()
            .find(|shortcut| shortcut.id == "minimize")
            .expect("migrated minimize shortcut");
        assert_eq!(minimize.shortcut, "Alt+Shift+CommandOrControl+M");
        assert_eq!(minimize.global_shortcut, "Alt+Shift+CommandOrControl+M");
    }

    #[test]
    fn legacy_visual_preference_aliases_migrate_to_oled() {
        let settings: AppSettings = serde_json::from_str(
            r#"{
                "appearance": "dark",
                "themeColor": "forest"
            }"#,
        )
        .expect("legacy visual settings");

        assert_eq!(
            settings.validate().expect("validated settings").appearance,
            Appearance::Oled
        );
    }

    #[test]
    fn validation_rejects_out_of_range_values() {
        let invalid_font = AppSettings {
            lyric_font_size: 100,
            ..AppSettings::default()
        };
        assert!(invalid_font.validate().is_err());

        let invalid_cache = AppSettings {
            cache_limit_mb: Some(1),
            ..AppSettings::default()
        };
        assert!(invalid_cache.validate().is_err());
    }

    #[test]
    fn builds_proxy_urls_without_ambiguity() {
        let http = AppSettings {
            proxy: ProxyConfig {
                protocol: ProxyProtocol::Http,
                server: "proxy.example.test".to_string(),
                port: Some(8080),
            },
            ..AppSettings::default()
        };
        assert_eq!(
            http.proxy_url().as_deref(),
            Some("http://proxy.example.test:8080")
        );

        let ipv6 = AppSettings {
            proxy: ProxyConfig {
                protocol: ProxyProtocol::Socks5,
                server: "2001:db8::1".to_string(),
                port: Some(1080),
            },
            ..AppSettings::default()
        };
        assert_eq!(
            ipv6.proxy_url().as_deref(),
            Some("socks5://[2001:db8::1]:1080")
        );
    }

    #[test]
    fn disabled_network_overrides_do_not_reach_requests() {
        let settings = AppSettings {
            proxy: ProxyConfig {
                protocol: ProxyProtocol::NoProxy,
                server: "ignored.example.test".to_string(),
                port: Some(8080),
            },
            enable_real_ip: false,
            real_ip: Some("203.0.113.8".to_string()),
            ..AppSettings::default()
        };

        assert_eq!(settings.proxy_url(), None);
        assert_eq!(settings.effective_real_ip(), None);
    }

    #[test]
    fn enabled_real_ip_reaches_requests() {
        let settings = AppSettings {
            enable_real_ip: true,
            real_ip: Some("2001:db8::8".to_string()),
            ..AppSettings::default()
        };

        assert_eq!(settings.effective_real_ip().as_deref(), Some("2001:db8::8"));
    }

    #[tokio::test]
    async fn atomic_writer_replaces_an_existing_file() {
        let directory = tempfile::tempdir().expect("temporary settings directory");
        let path = directory.path().join("settings.json");
        let initial = AppSettings::default();
        write_settings(&path, &initial)
            .await
            .expect("initial write");

        let replacement = AppSettings {
            lyric_font_size: 36,
            ..initial
        };
        write_settings(&path, &replacement)
            .await
            .expect("replacement write");

        assert_eq!(
            read_settings(&path).await.expect("saved settings"),
            replacement
        );
    }
}
