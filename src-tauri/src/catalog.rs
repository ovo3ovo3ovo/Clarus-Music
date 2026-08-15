use std::{collections::HashSet, future::Future};

use ncm_api_rs::{ApiClient, ApiResponse, NcmError, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    music_api::{with_request_context, ApiFailure, MusicApiState},
    performance::PerformanceState,
    unblock::{UnblockMusicState, UnblockResolver, UnblockTrack, UnblockedSource},
};

const ARTIST_CARD_DESCRIPTION_MAX_CHARS: usize = 320;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogArtist {
    id: i64,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogAlbum {
    id: i64,
    name: String,
    cover_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CatalogItem {
    Track {
        id: i64,
        name: String,
        duration_ms: u64,
        artists: Vec<CatalogArtist>,
        album: CatalogAlbum,
        aliases: Vec<String>,
        translated_names: Vec<String>,
        explicit: bool,
        playable: bool,
        unavailable_reason: Option<String>,
    },
    Artist {
        id: i64,
        name: String,
        cover_url: String,
        description: String,
    },
    Album {
        id: i64,
        name: String,
        cover_url: String,
        artist_id: i64,
        artist_name: String,
    },
    Playlist {
        id: i64,
        name: String,
        cover_url: String,
        creator_name: String,
        track_count: u64,
    },
    MusicVideo {
        id: i64,
        name: String,
        cover_url: String,
        artist_id: i64,
        artist_name: String,
        duration_ms: u64,
    },
}

pub(crate) fn performance_fixture_track(id: i64, artist_id: i64, cover_url: String) -> CatalogItem {
    CatalogItem::Track {
        id,
        name: format!("Performance Track {id}"),
        duration_ms: 300_000,
        artists: vec![CatalogArtist {
            id: artist_id,
            name: format!("Performance Artist {artist_id}"),
        }],
        album: CatalogAlbum {
            id: id.saturating_add(10_000),
            name: "Performance Album".to_string(),
            cover_url,
        },
        aliases: Vec::new(),
        translated_names: Vec::new(),
        explicit: false,
        playable: true,
        unavailable_reason: None,
    }
}

#[derive(Debug, Clone, Copy)]
enum SearchKind {
    Tracks,
    Artists,
    Albums,
    Playlists,
    MusicVideos,
}

impl SearchKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "tracks" => Some(Self::Tracks),
            "artists" => Some(Self::Artists),
            "albums" => Some(Self::Albums),
            "playlists" => Some(Self::Playlists),
            "musicVideos" => Some(Self::MusicVideos),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Tracks => "tracks",
            Self::Artists => "artists",
            Self::Albums => "albums",
            Self::Playlists => "playlists",
            Self::MusicVideos => "musicVideos",
        }
    }

    fn type_code(self) -> &'static str {
        match self {
            Self::Tracks => "1",
            Self::Albums => "10",
            Self::Artists => "100",
            Self::Playlists => "1000",
            Self::MusicVideos => "1004",
        }
    }

    fn items_key(self) -> &'static str {
        match self {
            Self::Tracks => "songs",
            Self::Albums => "albums",
            Self::Artists => "artists",
            Self::Playlists => "playlists",
            Self::MusicVideos => "mvs",
        }
    }

    fn total_key(self) -> &'static str {
        match self {
            Self::Tracks => "songCount",
            Self::Albums => "albumCount",
            Self::Artists => "artistCount",
            Self::Playlists => "playlistCount",
            Self::MusicVideos => "mvCount",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSection {
    items: Vec<CatalogItem>,
    total: u64,
    error: Option<ApiFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOverview {
    tracks: SearchSection,
    artists: SearchSection,
    albums: SearchSection,
    playlists: SearchSection,
    music_videos: SearchSection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    search_type: &'static str,
    items: Vec<CatalogItem>,
    total: u64,
    next_offset: u64,
    has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSource {
    url: String,
    mime_type: String,
    bitrate: u64,
    size_bytes: u64,
    duration_ms: u64,
    level: String,
}

pub(crate) fn value_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|candidate| {
        candidate
            .as_i64()
            .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
    })
}

pub(crate) fn value_u64(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|candidate| {
            candidate
                .as_u64()
                .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or_default()
}

pub(crate) fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn normalized_image_url(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| value_string(value, key))
        .find(|url| !url.is_empty())
        .map(|url| url.replacen("http://", "https://", 1))
        .unwrap_or_default()
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| value.get(key).filter(|candidate| candidate.is_object()))
}

pub(crate) fn array<'a>(value: &'a Value, keys: &[&str]) -> &'a [Value] {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_array).map(Vec::as_slice))
        .unwrap_or_default()
}

fn parse_artist(value: &Value) -> Option<CatalogArtist> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    (id > 0 && !name.is_empty()).then_some(CatalogArtist { id, name })
}

fn track_names(value: &Value, keys: &[&str], track_name: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    array(value, keys)
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty() && *candidate != track_name)
        .filter(|candidate| seen.insert((*candidate).to_string()))
        .map(str::to_string)
        .collect()
}

fn track_availability(value: &Value, privilege_override: Option<&Value>) -> (bool, Option<String>) {
    let Some(privilege) = privilege_override
        .or_else(|| value.get("privilege"))
        .filter(|item| item.is_object())
    else {
        return (true, None);
    };
    if value_u64(privilege, "pl") > 0
        || privilege
            .get("cs")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return (true, None);
    }

    let fee = value_i64(value, "fee").or_else(|| value_i64(privilege, "fee"));
    let reason = if fee == Some(1) {
        Some("VIP Only")
    } else if fee == Some(4) {
        Some("Paid album")
    } else if value
        .get("noCopyrightRcmd")
        .is_some_and(|candidate| !candidate.is_null())
    {
        Some("Copyright unavailable")
    } else if value_i64(privilege, "st").is_some_and(|status| status < 0) {
        Some("Removed from service")
    } else {
        None
    };
    match reason {
        Some(reason) => (false, Some(reason.to_string())),
        None => (true, None),
    }
}

pub(crate) fn parse_track_with_privilege(
    value: &Value,
    privilege: Option<&Value>,
) -> Option<CatalogItem> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let album = object(value, &["al", "album"])?;
    if id <= 0 || name.is_empty() {
        return None;
    }
    let artists = array(value, &["ar", "artists"])
        .iter()
        .filter_map(parse_artist)
        .collect();
    let album = CatalogAlbum {
        id: value_i64(album, "id").unwrap_or_default(),
        name: value_string(album, "name"),
        cover_url: normalized_image_url(album, &["picUrl", "coverUrl"]),
    };
    let aliases = track_names(value, &["alia", "alias"], &name);
    let translated_names = track_names(value, &["tns"], &name);
    let (playable, unavailable_reason) = track_availability(value, privilege);
    Some(CatalogItem::Track {
        id,
        name,
        duration_ms: value_u64(value, "dt").max(value_u64(value, "duration")),
        artists,
        album,
        aliases,
        translated_names,
        explicit: value_u64(value, "mark") & 1_048_576 == 1_048_576,
        playable,
        unavailable_reason,
    })
}

pub(crate) fn parse_album_card(value: &Value) -> Option<CatalogItem> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["picUrl", "coverUrl"]);
    let artist = object(value, &["artist"])
        .and_then(parse_artist)
        .or_else(|| array(value, &["artists"]).first().and_then(parse_artist))?;
    (id > 0 && !name.is_empty() && !cover_url.is_empty()).then_some(CatalogItem::Album {
        id,
        name,
        cover_url,
        artist_id: artist.id,
        artist_name: artist.name,
    })
}

pub(crate) fn parse_artist_card(value: &Value) -> Option<CatalogItem> {
    let artist = parse_artist(value)?;
    let cover_url = normalized_image_url(value, &["img1v1Url", "picUrl", "coverUrl"]);
    (!cover_url.is_empty()).then_some(CatalogItem::Artist {
        id: artist.id,
        description: artist_card_description(value, &artist.name),
        name: artist.name,
        cover_url,
    })
}

fn artist_card_description(value: &Value, artist_name: &str) -> String {
    let description = value_string(value, "briefDesc");
    if !description.is_empty() {
        return description
            .chars()
            .take(ARTIST_CARD_DESCRIPTION_MAX_CHARS)
            .collect();
    }

    let mut seen = HashSet::new();
    let mut alternatives = Vec::new();
    for key in ["alias", "alia", "transNames"] {
        for candidate in array(value, &[key]) {
            let Some(candidate) = candidate.as_str().map(str::trim) else {
                continue;
            };
            if candidate.is_empty() || candidate == artist_name || !seen.insert(candidate) {
                continue;
            }
            alternatives.push(candidate);
        }
    }
    let translated_name = value_string(value, "trans");
    if !translated_name.is_empty()
        && translated_name != artist_name
        && seen.insert(translated_name.as_str())
    {
        alternatives.push(&translated_name);
    }
    alternatives
        .into_iter()
        .take(3)
        .collect::<Vec<_>>()
        .join(" · ")
}

pub(crate) fn parse_playlist_card(value: &Value) -> Option<CatalogItem> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["coverImgUrl", "picUrl", "coverUrl"]);
    let creator_name = object(value, &["creator"])
        .map(|creator| value_string(creator, "nickname"))
        .unwrap_or_default();
    (id > 0 && !name.is_empty() && !cover_url.is_empty()).then_some(CatalogItem::Playlist {
        id,
        name,
        cover_url,
        creator_name,
        track_count: value_u64(value, "trackCount"),
    })
}

pub(crate) fn parse_music_video_card(value: &Value) -> Option<CatalogItem> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["cover", "coverUrl", "imgurl16v9"]);
    (id > 0 && !name.is_empty() && !cover_url.is_empty()).then_some(CatalogItem::MusicVideo {
        id,
        name,
        cover_url,
        artist_id: value_i64(value, "artistId").unwrap_or_default(),
        artist_name: value_string(value, "artistName"),
        duration_ms: value_u64(value, "duration"),
    })
}

fn parse_track(value: &Value) -> Option<CatalogItem> {
    parse_track_with_privilege(value, None)
}

fn parse_catalog_item(value: &Value, kind: SearchKind) -> Option<CatalogItem> {
    match kind {
        SearchKind::Tracks => parse_track(value),
        SearchKind::Artists => parse_artist_card(value),
        SearchKind::Albums => parse_album_card(value),
        SearchKind::Playlists => parse_playlist_card(value),
        SearchKind::MusicVideos => parse_music_video_card(value),
    }
}

fn parse_search_payload(
    response: ApiResponse,
    kind: SearchKind,
) -> (Vec<CatalogItem>, u64, u64, Option<bool>) {
    let result = response.body.get("result").unwrap_or(&response.body);
    let raw_items = array(result, &[kind.items_key()]);
    let items = raw_items
        .iter()
        .filter_map(|item| parse_catalog_item(item, kind))
        .collect::<Vec<_>>();
    let total = value_u64(result, kind.total_key()).max(items.len() as u64);
    let has_more = result.get("hasMore").and_then(Value::as_bool);
    (items, total, raw_items.len() as u64, has_more)
}

fn parse_search_response(response: ApiResponse, kind: SearchKind) -> SearchSection {
    let (items, total, _, _) = parse_search_payload(response, kind);
    SearchSection {
        items,
        total,
        error: None,
    }
}

fn search_section(result: Result<ApiResponse, NcmError>, kind: SearchKind) -> SearchSection {
    match result {
        Ok(response) => parse_search_response(response, kind),
        Err(error) => SearchSection {
            items: Vec::new(),
            total: 0,
            error: Some(ApiFailure::from_ncm(error)),
        },
    }
}

fn search_query(
    keywords: &str,
    kind: SearchKind,
    limit: u16,
    offset: u64,
    cookie: &Option<String>,
    real_ip: &Option<String>,
) -> Query {
    with_request_context(
        Query::new()
            .param("keywords", keywords)
            .param("type", kind.type_code())
            .param("limit", &limit.to_string())
            .param("offset", &offset.to_string()),
        cookie,
        real_ip,
    )
}

async fn load_search_overview(
    client: ApiClient,
    keywords: String,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> SearchOverview {
    let tracks_query = search_query(&keywords, SearchKind::Tracks, 16, 0, &cookie, &real_ip);
    let artists_query = search_query(&keywords, SearchKind::Artists, 3, 0, &cookie, &real_ip);
    let albums_query = search_query(&keywords, SearchKind::Albums, 3, 0, &cookie, &real_ip);
    let playlists_query = search_query(&keywords, SearchKind::Playlists, 12, 0, &cookie, &real_ip);
    let videos_query = search_query(&keywords, SearchKind::MusicVideos, 5, 0, &cookie, &real_ip);

    let (tracks, artists, albums, playlists, music_videos) = tokio::join!(
        client.cloudsearch(&tracks_query),
        client.cloudsearch(&artists_query),
        client.cloudsearch(&albums_query),
        client.cloudsearch(&playlists_query),
        client.cloudsearch(&videos_query),
    );

    SearchOverview {
        tracks: search_section(tracks, SearchKind::Tracks),
        artists: search_section(artists, SearchKind::Artists),
        albums: search_section(albums, SearchKind::Albums),
        playlists: search_section(playlists, SearchKind::Playlists),
        music_videos: search_section(music_videos, SearchKind::MusicVideos),
    }
}

async fn load_search_page(
    client: ApiClient,
    keywords: String,
    kind: SearchKind,
    offset: u64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<SearchPage, ApiFailure> {
    const PAGE_SIZE: u16 = 30;
    let response = client
        .cloudsearch(&search_query(
            &keywords, kind, PAGE_SIZE, offset, &cookie, &real_ip,
        ))
        .await
        .map_err(ApiFailure::from_ncm)?;
    let (items, reported_total, returned, api_has_more) = parse_search_payload(response, kind);
    let next_offset = offset.saturating_add(returned);
    let total = reported_total.max(next_offset);
    Ok(SearchPage {
        search_type: kind.name(),
        items,
        total,
        next_offset,
        has_more: returned > 0 && api_has_more.unwrap_or(next_offset < total),
    })
}

fn quality_level(quality: &str) -> Option<&'static str> {
    match quality {
        "128000" => Some("standard"),
        "192000" => Some("higher"),
        "320000" => Some("exhigh"),
        "flac" => Some("lossless"),
        "999000" => Some("hires"),
        _ => None,
    }
}

fn parse_stream_source(response: ApiResponse) -> Result<StreamSource, ApiFailure> {
    let source = response
        .body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| ApiFailure::unavailable("The playback response contained no source"))?;
    let url = value_string(source, "url");
    if url.len() > 4096 || !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiFailure::unavailable(
            "No playable HTTP audio source is available for this track",
        ));
    }
    let media_type = value_string(source, "type").to_ascii_lowercase();
    let mime_type = match media_type.as_str() {
        "flac" => "audio/flac",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" => "audio/ogg",
        _ => "audio/mpeg",
    }
    .to_string();
    Ok(StreamSource {
        url,
        mime_type,
        bitrate: value_u64(source, "br"),
        size_bytes: value_u64(source, "size"),
        duration_ms: value_u64(source, "time"),
        level: value_string(source, "level"),
    })
}

fn parse_unblock_track(
    response: ApiResponse,
    expected_track_id: i64,
) -> Result<UnblockTrack, ApiFailure> {
    let track = response
        .body
        .get("songs")
        .and_then(Value::as_array)
        .and_then(|songs| {
            songs
                .iter()
                .find(|song| value_i64(song, "id") == Some(expected_track_id))
        })
        .ok_or_else(|| ApiFailure::unavailable("The track detail response contained no match"))?;
    let name = value_string(track, "name");
    let artists = array(track, &["ar", "artists"])
        .iter()
        .filter_map(parse_artist)
        .map(|artist| (artist.id, artist.name))
        .collect::<Vec<_>>();
    if name.is_empty() || artists.is_empty() {
        return Err(ApiFailure::unavailable(
            "The track detail response lacked Unblock Music metadata",
        ));
    }
    let album = object(track, &["al", "album"]);
    Ok(UnblockTrack {
        id: expected_track_id,
        name,
        duration_ms: value_u64(track, "dt").max(value_u64(track, "duration")),
        album_id: album
            .and_then(|value| value_i64(value, "id"))
            .unwrap_or_default(),
        album_name: album
            .map(|value| value_string(value, "name"))
            .unwrap_or_default(),
        artists,
    })
}

fn requested_bitrate(quality: &str) -> u64 {
    quality.parse().unwrap_or_default()
}

fn unblocked_mime_type(url: &str, source: &str) -> &'static str {
    let parsed = reqwest::Url::parse(url).ok();
    let query_hint = parsed.as_ref().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "mime" || key == "type")
            .map(|(_, value)| value.into_owned().to_ascii_lowercase())
    });
    let path_hint = parsed
        .as_ref()
        .map(|url| url.path().to_ascii_lowercase())
        .unwrap_or_default();
    let hint = query_hint.as_deref().unwrap_or(&path_hint);
    if hint.contains("flac") {
        "audio/flac"
    } else if hint.contains("m4a") || hint.contains("mp4") {
        "audio/mp4"
    } else if hint.contains("ogg") || hint.contains("opus") {
        "audio/ogg"
    } else if hint.contains("webm") || source == "ytdl" {
        "audio/webm"
    } else {
        "audio/mpeg"
    }
}

fn unblocked_stream_source(
    source: UnblockedSource,
    quality: &str,
    duration_ms: u64,
) -> StreamSource {
    StreamSource {
        mime_type: unblocked_mime_type(&source.url, &source.source).to_string(),
        bitrate: requested_bitrate(quality),
        size_bytes: 0,
        duration_ms,
        level: format!("unblock:{}", source.source),
        url: source.url,
    }
}

async fn primary_or_fallback<F>(
    primary: Result<StreamSource, ApiFailure>,
    fallback: F,
) -> Result<StreamSource, ApiFailure>
where
    F: Future<Output = Option<StreamSource>>,
{
    match primary {
        Ok(source) => Ok(source),
        Err(primary_error) => fallback.await.ok_or(primary_error),
    }
}

async fn load_unblocked_stream(
    client: &ApiClient,
    track_id: i64,
    quality: &str,
    cookie: &Option<String>,
    real_ip: &Option<String>,
    resolver: UnblockResolver,
) -> Option<StreamSource> {
    let query = with_request_context(
        Query::new().param("ids", &track_id.to_string()),
        cookie,
        real_ip,
    );
    let detail = match client.song_detail(&query).await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("Unable to load track metadata for Unblock Music: {error}");
            return None;
        }
    };
    let track = match parse_unblock_track(detail, track_id) {
        Ok(track) => track,
        Err(error) => {
            log::warn!(
                "Unable to map track metadata for Unblock Music: {}",
                error.into_message()
            );
            return None;
        }
    };
    let duration_ms = track.duration_ms;
    match resolver.resolve(track).await {
        Ok(Some(source)) => Some(unblocked_stream_source(source, quality, duration_ms)),
        Ok(None) => None,
        Err(error) => {
            log::warn!(
                "Unable to configure Unblock Music: {}",
                error.into_message()
            );
            None
        }
    }
}

#[tauri::command]
pub async fn search_overview(
    request_id: String,
    keywords: String,
    state: State<'_, MusicApiState>,
) -> Result<SearchOverview, ApiFailure> {
    let keywords = keywords.trim().to_string();
    if keywords.is_empty() || keywords.chars().count() > 200 {
        return Err(ApiFailure::invalid(
            "keywords must contain between 1 and 200 characters",
        ));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            Ok(load_search_overview(client, keywords, cookie, real_ip).await)
        })
        .await
}

#[tauri::command]
pub async fn search_catalog_page(
    request_id: String,
    keywords: String,
    search_type: String,
    offset: u64,
    state: State<'_, MusicApiState>,
) -> Result<SearchPage, ApiFailure> {
    let keywords = keywords.trim().to_string();
    if keywords.is_empty() || keywords.chars().count() > 200 {
        return Err(ApiFailure::invalid(
            "keywords must contain between 1 and 200 characters",
        ));
    }
    let kind = SearchKind::from_name(&search_type)
        .ok_or_else(|| ApiFailure::invalid("searchType is not supported"))?;
    if offset > 1_000_000 {
        return Err(ApiFailure::invalid("offset is outside the supported range"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_search_page(client, keywords, kind, offset, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn resolve_stream_url(
    request_id: String,
    track_id: i64,
    quality: String,
    state: State<'_, MusicApiState>,
    unblock_state: State<'_, UnblockMusicState>,
    performance_state: State<'_, PerformanceState>,
) -> Result<StreamSource, ApiFailure> {
    if track_id <= 0 {
        return Err(ApiFailure::invalid("trackId must be a positive integer"));
    }
    let level = quality_level(&quality)
        .ok_or_else(|| ApiFailure::invalid("quality is not a supported music quality"))?;
    if let Some((url, mime_type, size_bytes)) = performance_state.audio_fixture() {
        return Ok(StreamSource {
            url,
            mime_type,
            bitrate: 320_000,
            size_bytes,
            duration_ms: 300_000,
            level: level.to_string(),
        });
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let resolver = unblock_state.resolver();
    state
        .run_cancellable(request_id, async move {
            let id = track_id.to_string();
            let query = with_request_context(
                Query::new().param("id", &id).param("level", level),
                &cookie,
                &real_ip,
            );
            let primary = client
                .song_url_v1(&query)
                .await
                .map_err(ApiFailure::from_ncm)
                .and_then(parse_stream_source);
            primary_or_fallback(
                primary,
                load_unblocked_stream(&client, track_id, &quality, &cookie, &real_ip, resolver),
            )
            .await
        })
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use futures_util::StreamExt;
    use ncm_api_rs::{create_client, ApiResponse, Query};
    use reqwest::header::RANGE;
    use serde_json::json;

    use super::{
        load_search_overview, load_search_page, load_unblocked_stream, parse_search_payload,
        parse_search_response, parse_stream_source, parse_unblock_track, primary_or_fallback,
        quality_level, unblocked_mime_type, unblocked_stream_source, CatalogItem, SearchKind,
        StreamSource,
    };
    use crate::{
        music_api::ApiFailure,
        settings::AppSettings,
        unblock::{UnblockMusicState, UnblockedSource},
    };

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    use serde_json::Value;

    #[test]
    fn maps_search_tracks_to_the_narrow_webview_contract() {
        let section = parse_search_response(
            response(json!({
                "result": {
                    "songCount": 1,
                    "songs": [{
                        "id": 186016,
                        "name": "晴天",
                        "dt": 269000,
                        "ar": [{ "id": 6452, "name": "周杰伦" }],
                        "al": { "id": 18905, "name": "叶惠美", "picUrl": "http://img.test/cover.jpg" },
                        "alia": ["Sunny Day"],
                        "tns": ["Clear Day"],
                        "privilege": { "pl": 320000, "fee": 0, "st": 0 }
                    }]
                }
            })),
            SearchKind::Tracks,
        );

        assert_eq!(section.total, 1);
        assert_eq!(section.items.len(), 1);
        let CatalogItem::Track {
            id,
            playable,
            album,
            aliases,
            translated_names,
            ..
        } = &section.items[0]
        else {
            panic!("expected track")
        };
        assert_eq!(*id, 186016);
        assert!(*playable);
        assert_eq!(album.cover_url, "https://img.test/cover.jpg");
        assert_eq!(aliases, &["Sunny Day"]);
        assert_eq!(translated_names, &["Clear Day"]);
    }

    #[test]
    fn maps_artist_cards_to_informative_subtitles() {
        let section = parse_search_response(
            response(json!({
                "result": {
                    "artistCount": 2,
                    "artists": [
                        {
                            "id": 1,
                            "name": "Artist One",
                            "picUrl": "https://img.test/one.jpg",
                            "briefDesc": "A full artist introduction."
                        },
                        {
                            "id": 2,
                            "name": "Artist Two",
                            "picUrl": "https://img.test/two.jpg",
                            "alias": ["Second name"],
                            "transNames": ["Translated name"]
                        }
                    ]
                }
            })),
            SearchKind::Artists,
        );

        assert_eq!(section.total, 2);
        let CatalogItem::Artist {
            description: first_description,
            ..
        } = &section.items[0]
        else {
            panic!("expected artist")
        };
        let CatalogItem::Artist {
            description: second_description,
            ..
        } = &section.items[1]
        else {
            panic!("expected artist")
        };
        assert_eq!(first_description, "A full artist introduction.");
        assert_eq!(second_description, "Second name · Translated name");
    }

    #[test]
    fn serializes_catalog_variant_fields_in_camel_case() {
        let item = CatalogItem::Track {
            id: 1,
            name: "track".to_string(),
            duration_ms: 1_000,
            artists: vec![super::CatalogArtist {
                id: 2,
                name: "artist".to_string(),
            }],
            album: super::CatalogAlbum {
                id: 3,
                name: "album".to_string(),
                cover_url: "https://img.test/cover.jpg".to_string(),
            },
            aliases: Vec::new(),
            translated_names: Vec::new(),
            explicit: false,
            playable: true,
            unavailable_reason: None,
        };
        let serialized = serde_json::to_value(item).expect("serialize catalog item");

        assert_eq!(
            serialized.get("kind").and_then(Value::as_str),
            Some("track")
        );
        assert_eq!(
            serialized.get("durationMs").and_then(Value::as_u64),
            Some(1_000)
        );
        assert!(serialized.get("duration_ms").is_none());
        assert_eq!(
            serialized
                .get("album")
                .and_then(|album| album.get("coverUrl"))
                .and_then(Value::as_str),
            Some("https://img.test/cover.jpg")
        );
    }

    #[test]
    fn maps_unavailable_tracks_without_guessing_playability() {
        let section = parse_search_response(
            response(json!({
                "result": {
                    "songs": [{
                        "id": 1,
                        "name": "locked",
                        "ar": [{ "id": 2, "name": "artist" }],
                        "al": { "id": 3, "name": "album", "picUrl": "https://img.test/a.jpg" },
                        "privilege": { "pl": 0, "fee": 1, "st": 0 }
                    }]
                }
            })),
            SearchKind::Tracks,
        );
        let CatalogItem::Track {
            playable,
            unavailable_reason,
            ..
        } = &section.items[0]
        else {
            panic!("expected track")
        };
        assert!(!playable);
        assert_eq!(unavailable_reason.as_deref(), Some("VIP Only"));
    }

    #[test]
    fn keeps_free_tracks_playable_when_the_service_reports_zero_play_level() {
        let section = parse_search_response(
            response(json!({
                "result": {
                    "songs": [{
                        "id": 1,
                        "name": "free track",
                        "fee": 0,
                        "ar": [{ "id": 2, "name": "artist" }],
                        "al": { "id": 3, "name": "album", "picUrl": "https://img.test/a.jpg" },
                        "privilege": { "pl": 0, "fee": 0, "st": 0 }
                    }]
                }
            })),
            SearchKind::Tracks,
        );
        let CatalogItem::Track {
            playable,
            unavailable_reason,
            ..
        } = &section.items[0]
        else {
            panic!("expected track")
        };
        assert!(*playable);
        assert!(unavailable_reason.is_none());
    }

    #[test]
    fn accepts_only_known_quality_levels() {
        assert_eq!(quality_level("320000"), Some("exhigh"));
        assert_eq!(quality_level("flac"), Some("lossless"));
        assert_eq!(quality_level("master"), None);
    }

    #[test]
    fn accepts_only_known_search_types() {
        assert_eq!(
            SearchKind::from_name("tracks").map(SearchKind::name),
            Some("tracks")
        );
        assert_eq!(
            SearchKind::from_name("musicVideos").map(SearchKind::name),
            Some("musicVideos")
        );
        assert!(SearchKind::from_name("users").is_none());
    }

    #[test]
    fn advances_pagination_by_raw_items_instead_of_filtered_items() {
        let (items, total, returned, has_more) = parse_search_payload(
            response(json!({
                "result": {
                    "songCount": 4,
                    "hasMore": true,
                    "songs": [
                        {
                            "id": 186016,
                            "name": "晴天",
                            "dt": 269000,
                            "ar": [{ "id": 6452, "name": "周杰伦" }],
                            "al": {
                                "id": 18905,
                                "name": "叶惠美",
                                "picUrl": "https://img.test/cover.jpg"
                            },
                            "privilege": { "pl": 320000, "fee": 0, "st": 0 }
                        },
                        { "id": 0, "name": "invalid" }
                    ]
                }
            })),
            SearchKind::Tracks,
        );

        assert_eq!(items.len(), 1);
        assert_eq!(total, 4);
        assert_eq!(returned, 2);
        assert_eq!(has_more, Some(true));
    }

    #[test]
    fn parses_only_http_audio_sources() {
        let source = parse_stream_source(response(json!({
            "data": [{
                "url": "https://audio.test/song.flac",
                "type": "flac",
                "br": 999000,
                "size": 1234,
                "time": 5678,
                "level": "lossless"
            }]
        })))
        .expect("stream source");
        assert_eq!(source.mime_type, "audio/flac");
        assert_eq!(source.bitrate, 999000);

        assert!(parse_stream_source(response(json!({
            "data": [{ "url": "file:///tmp/song.mp3" }]
        })))
        .is_err());
    }

    #[test]
    fn maps_narrow_track_detail_for_unblock_music() {
        let track = parse_unblock_track(
            response(json!({
                "songs": [{
                    "id": 10,
                    "name": "Song",
                    "dt": 180000,
                    "ar": [{ "id": 30, "name": "Artist" }],
                    "al": { "id": 20, "name": "Album" }
                }]
            })),
            10,
        )
        .expect("unblock track");

        assert_eq!(track.id, 10);
        assert_eq!(track.name, "Song");
        assert_eq!(track.duration_ms, 180_000);
        assert_eq!(track.album_id, 20);
        assert_eq!(track.artists, [(30, "Artist".to_string())]);
    }

    #[test]
    fn maps_unblocked_stream_and_detects_webm_without_advertised_size() {
        let stream = unblocked_stream_source(
            UnblockedSource {
                url: "https://audio.test/playback?mime=audio%2Fwebm".to_string(),
                source: "ytdl".to_string(),
            },
            "320000",
            180_000,
        );

        assert_eq!(stream.mime_type, "audio/webm");
        assert_eq!(stream.bitrate, 320_000);
        assert_eq!(stream.size_bytes, 0);
        assert_eq!(stream.duration_ms, 180_000);
        assert_eq!(stream.level, "unblock:ytdl");
        assert_eq!(
            unblocked_mime_type("https://audio.test/song.flac", "kugou"),
            "audio/flac"
        );
    }

    #[tokio::test]
    async fn primary_success_does_not_poll_the_unblock_fallback() {
        let fallback_polled = Arc::new(AtomicBool::new(false));
        let marker = Arc::clone(&fallback_polled);
        let primary = StreamSource {
            url: "https://audio.test/song.mp3".to_string(),
            mime_type: "audio/mpeg".to_string(),
            bitrate: 320_000,
            size_bytes: 100,
            duration_ms: 1_000,
            level: "exhigh".to_string(),
        };

        let resolved = primary_or_fallback(Ok(primary.clone()), async move {
            marker.store(true, Ordering::SeqCst);
            None
        })
        .await
        .expect("primary stream");

        assert_eq!(resolved, primary);
        assert!(!fallback_polled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn unavailable_fallback_preserves_the_original_playback_error() {
        let primary_error = ApiFailure::unavailable("original Netease playback failure");
        let error = primary_or_fallback(Err(primary_error), async { None })
            .await
            .expect_err("original error");
        let serialized = serde_json::to_value(error).expect("serialize error");

        assert_eq!(serialized["kind"], "unavailable");
        assert_eq!(serialized["message"], "original Netease playback failure");
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_search_overview_contract() {
        let overview =
            load_search_overview(create_client(None), "周杰伦".to_string(), None, None).await;

        assert!(!overview.tracks.items.is_empty());
        assert!(!overview.artists.items.is_empty());
        assert!(!overview.albums.items.is_empty());
        assert!(!overview.playlists.items.is_empty());
        assert!(!overview.music_videos.items.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_search_page_contract() {
        let page = load_search_page(
            create_client(None),
            "周杰伦".to_string(),
            SearchKind::Tracks,
            0,
            None,
            None,
        )
        .await
        .expect("search page");

        assert_eq!(page.search_type, "tracks");
        assert!(!page.items.is_empty());
        assert!(page.next_offset > 0);
        assert!(page.total >= page.next_offset);
        let serialized = serde_json::to_value(&page).expect("serialize live search page");
        assert!(serialized["items"][0]["durationMs"].is_number());
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_stream_url_contract() {
        let client = create_client(None);
        let overview =
            load_search_overview(client.clone(), "海阔天空 Beyond".to_string(), None, None).await;
        let candidate_ids = overview.tracks.items.iter().filter_map(|item| match item {
            CatalogItem::Track {
                id, playable: true, ..
            } => Some(*id),
            _ => None,
        });

        for id in candidate_ids {
            let response = client
                .song_url_v1(
                    &Query::new()
                        .param("id", &id.to_string())
                        .param("level", "standard"),
                )
                .await
                .expect("live stream response");
            if let Ok(source) = parse_stream_source(response) {
                assert!(source.url.starts_with("http"));
                assert!(source.duration_ms > 0);
                return;
            }
        }

        panic!("search returned no anonymously playable stream source");
    }

    #[tokio::test]
    #[ignore = "requires live access to Netease and Unblock Music providers"]
    async fn live_unblock_kugou_contract() {
        let client = create_client(None);
        let unblock_state = UnblockMusicState::default();
        let settings = AppSettings {
            unblock_sources: vec!["kugou".to_string()],
            ..AppSettings::default()
        };
        unblock_state.apply_settings(&settings).await;
        let resolver = unblock_state.resolver();
        let cookie = None;
        let real_ip = None;

        let (verified, candidate_count) =
            tokio::time::timeout(std::time::Duration::from_secs(90), async {
                let mut candidate_count = 0_usize;
                for keywords in ["晴天 DJ版", "Never Gonna Give You Up"] {
                    let page = load_search_page(
                        client.clone(),
                        keywords.to_string(),
                        SearchKind::Tracks,
                        0,
                        None,
                        None,
                    )
                    .await
                    .expect("live search page");
                    let candidate_ids = page.items.into_iter().filter_map(|item| match item {
                        CatalogItem::Track { id, .. } => Some(id),
                        _ => None,
                    });

                    for track_id in candidate_ids.take(10) {
                        candidate_count += 1;
                        if let Some(source) = load_unblocked_stream(
                            &client,
                            track_id,
                            "320000",
                            &cookie,
                            &real_ip,
                            resolver.clone(),
                        )
                        .await
                        {
                            assert!(source.url.starts_with("http"));
                            assert_eq!(source.level, "unblock:kugou");
                            assert!(source.duration_ms > 0);
                            let response = reqwest::Client::new()
                                .get(&source.url)
                                .header(RANGE, "bytes=0-1023")
                                .send()
                                .await
                                .expect("live Kugou audio response");
                            assert!(response.status().is_success());
                            let first_chunk = response
                                .bytes_stream()
                                .next()
                                .await
                                .expect("live Kugou audio chunk")
                                .expect("read live Kugou audio chunk");
                            assert!(!first_chunk.is_empty());
                            return (true, candidate_count);
                        }
                    }
                }
                (false, candidate_count)
            })
            .await
            .expect("live Unblock Music contract timed out");

        assert!(
            verified,
            "no Netease search result produced a live Kugou source; candidates={candidate_count}"
        );
    }
}
