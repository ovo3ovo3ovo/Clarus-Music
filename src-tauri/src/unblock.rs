use std::{borrow::Cow, collections::HashSet, sync::Arc};

use md5::{Digest, Md5};
use reqwest::Url;
use serde_json::Value;
use tokio::sync::{RwLock, Semaphore};
use unm_engine::{
    executor::{EngineId, Executor},
    interface::Engine,
};
use unm_engine_kugou::{search as search_kugou, KugouFormat, ENGINE_ID as KUGOU_ENGINE_ID};
use unm_engine_ytdl::{YtDlEngine, ENGINE_ID as YTDL_ENGINE_ID};
use unm_request::build_client;
use unm_types::{
    config::ConfigManagerBuilder, Album, Artist, Context, ContextBuilder, RetrievedSongInfo,
    SearchMode, SerializedIdentifier, Song, SongSearchInformation,
};

use crate::{music_api::ApiFailure, settings::AppSettings};

const DEFAULT_SOURCES: &[&str] = &[KUGOU_ENGINE_ID];
const SUPPORTED_SOURCES: &[&str] = &[KUGOU_ENGINE_ID, YTDL_ENGINE_ID];
const MAX_CONCURRENT_SEARCHES: usize = 2;

struct FixedKugouEngine;

#[async_trait::async_trait]
impl Engine for FixedKugouEngine {
    async fn search<'a>(
        &self,
        info: &'a Song,
        context: &'a Context,
    ) -> anyhow::Result<Option<SongSearchInformation>> {
        let Some(song) = search_kugou(info, context).await? else {
            return Ok(None);
        };
        Ok(Some(
            SongSearchInformation::builder()
                .source(Cow::Borrowed(KUGOU_ENGINE_ID))
                .identifier(serde_json::to_string(&song)?)
                .song(Some(song))
                .build(),
        ))
    }

    async fn retrieve<'a>(
        &self,
        identifier: &'a SerializedIdentifier,
        context: &'a Context,
    ) -> anyhow::Result<RetrievedSongInfo> {
        let song = serde_json::from_str::<Song>(identifier)?;
        let formats = if context.enable_flac {
            [KugouFormat::SqHash, KugouFormat::HqHash]
        } else {
            [KugouFormat::HqHash, KugouFormat::Hash]
        };
        let mut last_error = None;
        for format in formats {
            match retrieve_kugou_format(&song, format, context).await {
                Ok(Some(url)) => {
                    return Ok(RetrievedSongInfo::builder()
                        .url(url)
                        .source(Cow::Borrowed(KUGOU_ENGINE_ID))
                        .build());
                }
                Ok(None) => {}
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Kugou returned no playable audio URL")))
    }
}

fn kugou_key(hash: &str) -> String {
    let mut digest = Md5::new();
    digest.update(hash.as_bytes());
    digest.update(b"kgcloudv2");
    format!("{:x}", digest.finalize())
}

fn kugou_hash(song: &Song, format: KugouFormat) -> Option<String> {
    song.context
        .as_ref()
        .and_then(|values| values.get(format.as_ref()))
        .filter(|hash| !hash.is_empty())
        .cloned()
}

async fn retrieve_kugou_format(
    song: &Song,
    format: KugouFormat,
    context: &Context,
) -> anyhow::Result<Option<String>> {
    let Some(hash) = kugou_hash(song, format) else {
        return Ok(None);
    };
    let album_id = song
        .album
        .as_ref()
        .map(|album| album.id.as_str())
        .unwrap_or_default();
    let url = Url::parse_with_params(
        "http://trackercdn.kugou.com/i/v2/?appid=1005&pid=2&cmd=25&behavior=play",
        &[
            ("key", kugou_key(&hash)),
            ("hash", hash),
            ("album_id", album_id.to_string()),
        ],
    )?;
    let response = build_client(context.proxy_uri.as_deref())?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(response
        .pointer("/url/0")
        .and_then(Value::as_str)
        .map(str::to_string))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnblockSettings {
    enabled: bool,
    sources: Vec<String>,
    search_mode: SearchModeSetting,
    enable_flac: bool,
    proxy_uri: Option<String>,
    ytdl_executable: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchModeSetting {
    FastFirst,
    OrderFirst,
}

impl Default for UnblockSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            sources: Vec::new(),
            search_mode: SearchModeSetting::FastFirst,
            enable_flac: false,
            proxy_uri: None,
            ytdl_executable: None,
        }
    }
}

impl From<&AppSettings> for UnblockSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            enabled: settings.enable_unblock_netease_music,
            sources: settings.unblock_sources.clone(),
            search_mode: if settings.unblock_search_mode == "order-first" {
                SearchModeSetting::OrderFirst
            } else {
                SearchModeSetting::FastFirst
            },
            enable_flac: settings.unblock_enable_flac,
            proxy_uri: settings.unblock_proxy_uri.clone(),
            ytdl_executable: settings.unblock_ytdl_executable.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnblockTrack {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) duration_ms: u64,
    pub(crate) album_id: i64,
    pub(crate) album_name: String,
    pub(crate) artists: Vec<(i64, String)>,
}

pub(crate) struct UnblockedSource {
    pub(crate) url: String,
    pub(crate) source: String,
}

struct UnblockInner {
    executor: Executor,
    settings: RwLock<UnblockSettings>,
    permits: Semaphore,
}

pub struct UnblockMusicState {
    inner: Arc<UnblockInner>,
}

#[derive(Clone)]
pub(crate) struct UnblockResolver {
    inner: Arc<UnblockInner>,
}

impl Default for UnblockMusicState {
    fn default() -> Self {
        let mut executor = Executor::new();
        executor.register(
            Cow::Borrowed(YTDL_ENGINE_ID),
            Arc::new(YtDlEngine) as Arc<dyn Engine + Send + Sync>,
        );
        executor.register(
            Cow::Borrowed(KUGOU_ENGINE_ID),
            Arc::new(FixedKugouEngine) as Arc<dyn Engine + Send + Sync>,
        );
        Self {
            inner: Arc::new(UnblockInner {
                executor,
                settings: RwLock::new(UnblockSettings::default()),
                permits: Semaphore::new(MAX_CONCURRENT_SEARCHES),
            }),
        }
    }
}

impl UnblockMusicState {
    pub(crate) async fn apply_settings(&self, settings: &AppSettings) {
        *self.inner.settings.write().await = UnblockSettings::from(settings);
    }

    pub(crate) fn resolver(&self) -> UnblockResolver {
        UnblockResolver {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl UnblockResolver {
    pub(crate) async fn resolve(
        &self,
        track: UnblockTrack,
    ) -> Result<Option<UnblockedSource>, ApiFailure> {
        let settings = self.inner.settings.read().await.clone();
        if !settings.enabled {
            return Ok(None);
        }
        let sources = selected_sources(&settings.sources);
        if sources.is_empty() {
            return Ok(None);
        }
        let _permit = self.inner.permits.acquire().await.map_err(|_| {
            ApiFailure::unavailable("The Unblock Music concurrency limiter was closed")
        })?;
        let context = build_context(&settings)?;
        let song = into_unm_song(track);
        let matched = match self.inner.executor.search(&sources, &song, &context).await {
            Ok(matched) => matched,
            Err(error) => {
                log::warn!("Unblock Music search failed: {error}");
                return Ok(None);
            }
        };
        let retrieved = match self.inner.executor.retrieve(&matched, &context).await {
            Ok(retrieved) => retrieved,
            Err(error) => {
                log::warn!("Unblock Music retrieval failed: {error}");
                return Ok(None);
            }
        };
        let url = retrieved.url.trim().to_string();
        if url.len() > 4096 || !(url.starts_with("https://") || url.starts_with("http://")) {
            log::warn!("Unblock Music returned a non-HTTP or oversized source URL");
            return Ok(None);
        }
        let source = retrieved.source.trim().to_ascii_lowercase();
        if !SUPPORTED_SOURCES.contains(&source.as_str()) {
            log::warn!("Unblock Music returned an unknown source identifier");
            return Ok(None);
        }
        Ok(Some(UnblockedSource { url, source }))
    }
}

fn selected_sources(configured: &[String]) -> Vec<EngineId> {
    let requested = if configured.is_empty() {
        DEFAULT_SOURCES
            .iter()
            .map(|source| (*source).to_string())
            .collect::<Vec<_>>()
    } else {
        configured
            .iter()
            .flat_map(|entry| entry.split(','))
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .map(str::to_ascii_lowercase)
            .collect()
    };
    let mut seen = HashSet::with_capacity(requested.len());
    requested
        .into_iter()
        .filter(|source| SUPPORTED_SOURCES.contains(&source.as_str()))
        .filter(|source| seen.insert(source.clone()))
        .map(Cow::Owned)
        .collect()
}

fn build_context(settings: &UnblockSettings) -> Result<Context, ApiFailure> {
    let mut config = ConfigManagerBuilder::new();
    if let Some(executable) = &settings.ytdl_executable {
        config.set("ytdl:exe", executable.clone());
    }
    let mut context = ContextBuilder::default();
    context
        .enable_flac(settings.enable_flac)
        .search_mode(match settings.search_mode {
            SearchModeSetting::FastFirst => SearchMode::FastFirst,
            SearchModeSetting::OrderFirst => SearchMode::OrderFirst,
        })
        .config(Some(config.build()));
    if let Some(proxy_uri) = &settings.proxy_uri {
        context.proxy_uri(Some(Cow::Owned(proxy_uri.clone())));
    }
    context
        .build()
        .map_err(|error| ApiFailure::invalid(format!("Invalid Unblock Music context: {error}")))
}

fn into_unm_song(track: UnblockTrack) -> Song {
    let artists = track
        .artists
        .into_iter()
        .map(|(id, name)| Artist::builder().id(id.to_string()).name(name).build())
        .collect();
    let album = (!track.album_name.is_empty()).then(|| {
        Album::builder()
            .id(track.album_id.to_string())
            .name(track.album_name)
            .build()
    });
    Song::builder()
        .id(track.id.to_string())
        .name(track.name)
        .duration(Some(track.duration_ms.min(i64::MAX as u64) as i64))
        .artists(artists)
        .album(album)
        .build()
}

#[cfg(test)]
mod tests {
    use super::{
        build_context, into_unm_song, kugou_hash, kugou_key, selected_sources, SearchModeSetting,
        UnblockMusicState, UnblockSettings, UnblockTrack,
    };
    use crate::settings::AppSettings;
    use std::collections::HashMap;
    use unm_engine_kugou::KugouFormat;
    use unm_types::SearchMode;

    #[test]
    fn defaults_to_the_verified_kugou_source() {
        let selected = selected_sources(&[])
            .into_iter()
            .map(|source| source.into_owned())
            .collect::<Vec<_>>();
        assert_eq!(selected, ["kugou"]);
    }

    #[test]
    fn filters_unknown_duplicate_and_header_dependent_sources() {
        let selected = selected_sources(&[
            "KUGOU, bilibili".to_string(),
            "unknown".to_string(),
            "kugou".to_string(),
            "ytdl".to_string(),
        ])
        .into_iter()
        .map(|source| source.into_owned())
        .collect::<Vec<_>>();
        assert_eq!(selected, ["kugou", "ytdl"]);
    }

    #[test]
    fn hashes_kugou_retrieval_keys_per_the_provider_contract() {
        assert_eq!(
            kugou_key("84350012ac675ad5e7b1ea9967de841f"),
            "b079ba02d02c0c6c4871f20c9891bbc8"
        );
    }

    #[test]
    fn missing_high_quality_hash_can_fall_back_to_standard_audio() {
        let song = unm_types::Song::builder()
            .name("Test".to_string())
            .context(Some(HashMap::from([
                ("hqhash".to_string(), String::new()),
                ("hash".to_string(), "standard".to_string()),
            ])))
            .build();

        assert!(kugou_hash(&song, KugouFormat::HqHash).is_none());
        assert_eq!(
            kugou_hash(&song, KugouFormat::Hash).as_deref(),
            Some("standard")
        );
    }

    #[test]
    fn maps_settings_and_netease_metadata_without_broad_objects() {
        let settings = UnblockSettings {
            search_mode: SearchModeSetting::OrderFirst,
            enable_flac: true,
            proxy_uri: Some("socks5://127.0.0.1:1080".to_string()),
            ytdl_executable: Some("/opt/homebrew/bin/yt-dlp".to_string()),
            ..UnblockSettings::default()
        };
        let context = build_context(&settings).expect("context");
        assert!(context.enable_flac);
        assert!(matches!(context.search_mode, SearchMode::OrderFirst));
        assert_eq!(
            context.proxy_uri.as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(
            context
                .config
                .as_ref()
                .and_then(|config| config.get("ytdl:exe")),
            Some(&"/opt/homebrew/bin/yt-dlp".to_string())
        );

        let song = into_unm_song(UnblockTrack {
            id: 10,
            name: "Song".to_string(),
            duration_ms: 180_000,
            album_id: 20,
            album_name: "Album".to_string(),
            artists: vec![(30, "Artist".to_string())],
        });
        assert_eq!(song.id, "10");
        assert_eq!(song.keyword(), "Song Artist");
        assert_eq!(song.duration, Some(180_000));
        assert_eq!(
            song.album.as_ref().map(|album| album.name.as_str()),
            Some("Album")
        );
    }

    #[tokio::test]
    async fn disabled_or_unsupported_sources_skip_all_engines() {
        let state = UnblockMusicState::default();
        let track = || UnblockTrack {
            id: 10,
            name: "Song".to_string(),
            duration_ms: 180_000,
            album_id: 20,
            album_name: "Album".to_string(),
            artists: vec![(30, "Artist".to_string())],
        };
        let mut settings = AppSettings {
            enable_unblock_netease_music: false,
            ..AppSettings::default()
        };
        state.apply_settings(&settings).await;
        assert!(state
            .resolver()
            .resolve(track())
            .await
            .expect("disabled resolver")
            .is_none());

        settings.enable_unblock_netease_music = true;
        settings.unblock_sources = vec!["bilibili".to_string(), "unknown".to_string()];
        state.apply_settings(&settings).await;
        assert!(state
            .resolver()
            .resolve(track())
            .await
            .expect("unsupported sources")
            .is_none());
    }
}
