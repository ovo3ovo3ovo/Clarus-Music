use std::collections::HashSet;

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    catalog::{
        array, normalized_image_url, parse_album_card, parse_artist_card,
        parse_track_with_privilege, value_i64, value_string, value_u64, CatalogItem,
    },
    music_api::{with_request_context, ApiFailure, MusicApiState},
    playlist::{load_playlist_detail, PlaylistDetail},
};

const COVER_PAGE_SIZE: usize = 50;
const MAX_OFFSET: u64 = 100_000;
const MAX_HISTORY_ITEMS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPlaylist {
    kind: &'static str,
    id: i64,
    name: String,
    cover_url: String,
    creator_id: i64,
    creator_name: String,
    track_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPlaylistPage {
    items: Vec<LibraryPlaylist>,
    next_offset: u64,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOverview {
    liked_songs: PlaylistDetail,
    playlists: LibraryPlaylistPage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCatalogPage {
    section: &'static str,
    items: Vec<CatalogItem>,
    next_offset: u64,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHistoryItem {
    track: CatalogItem,
    play_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHistory {
    period: &'static str,
    items: Vec<LibraryHistoryItem>,
}

#[derive(Debug, Clone, Copy)]
enum LibraryCatalogKind {
    Albums,
    Artists,
}

impl LibraryCatalogKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "albums" => Some(Self::Albums),
            "artists" => Some(Self::Artists),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Albums => "albums",
            Self::Artists => "artists",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum HistoryPeriod {
    Week,
    All,
}

impl HistoryPeriod {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "week" => Some(Self::Week),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::All => "all",
        }
    }

    fn api_type(self) -> &'static str {
        match self {
            Self::Week => "1",
            Self::All => "0",
        }
    }

    fn response_key(self) -> &'static str {
        match self {
            Self::Week => "weekData",
            Self::All => "allData",
        }
    }
}

fn response_has_more(body: &Value, returned: usize, page_size: usize) -> bool {
    body.get("more")
        .or_else(|| body.get("hasMore"))
        .and_then(Value::as_bool)
        .unwrap_or(returned == page_size)
}

fn validate_raw_page(raw_items: &[Value], page_size: usize) -> Result<(), ApiFailure> {
    if raw_items.len() > page_size {
        return Err(ApiFailure::unavailable(
            "The library response exceeded the requested page size",
        ));
    }
    Ok(())
}

fn parse_library_playlist(value: &Value) -> Option<LibraryPlaylist> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["coverImgUrl", "picUrl", "coverUrl"]);
    let creator = value.get("creator").filter(|item| item.is_object())?;
    let creator_id = value_i64(creator, "userId")?;
    let creator_name = value_string(creator, "nickname");
    (id > 0 && creator_id > 0 && !name.is_empty() && !cover_url.is_empty()).then_some(
        LibraryPlaylist {
            kind: "playlist",
            id,
            name,
            cover_url,
            creator_id,
            creator_name,
            track_count: value_u64(value, "trackCount"),
        },
    )
}

fn parse_playlist_page(
    response: ApiResponse,
    offset: u64,
) -> Result<LibraryPlaylistPage, ApiFailure> {
    let raw_items = array(&response.body, &["playlist"]);
    validate_raw_page(raw_items, COVER_PAGE_SIZE)?;
    let mut seen = HashSet::new();
    let items = raw_items
        .iter()
        .filter_map(parse_library_playlist)
        .filter(|item| seen.insert(item.id))
        .collect::<Vec<_>>();
    if !raw_items.is_empty() && items.is_empty() {
        return Err(ApiFailure::unavailable(
            "The library response contained no valid playlists",
        ));
    }
    Ok(LibraryPlaylistPage {
        items,
        next_offset: offset.saturating_add(raw_items.len() as u64),
        has_more: !raw_items.is_empty()
            && response_has_more(&response.body, raw_items.len(), COVER_PAGE_SIZE),
    })
}

fn parse_catalog_page(
    response: ApiResponse,
    kind: LibraryCatalogKind,
    offset: u64,
) -> Result<LibraryCatalogPage, ApiFailure> {
    let raw_items = array(&response.body, &["data"]);
    validate_raw_page(raw_items, COVER_PAGE_SIZE)?;
    let mut seen = HashSet::new();
    let items = raw_items
        .iter()
        .filter_map(|item| match kind {
            LibraryCatalogKind::Albums => parse_album_card(item),
            LibraryCatalogKind::Artists => parse_artist_card(item),
        })
        .filter(|item| {
            let id = match item {
                CatalogItem::Artist { id, .. } | CatalogItem::Album { id, .. } => *id,
                _ => return false,
            };
            seen.insert(id)
        })
        .collect::<Vec<_>>();
    if !raw_items.is_empty() && items.is_empty() {
        return Err(ApiFailure::unavailable(
            "The library response contained no valid catalog items",
        ));
    }
    Ok(LibraryCatalogPage {
        section: kind.name(),
        items,
        next_offset: offset.saturating_add(raw_items.len() as u64),
        has_more: !raw_items.is_empty()
            && response_has_more(&response.body, raw_items.len(), COVER_PAGE_SIZE),
    })
}

fn parse_history(
    response: ApiResponse,
    period: HistoryPeriod,
) -> Result<LibraryHistory, ApiFailure> {
    let raw_items = array(&response.body, &[period.response_key()]);
    if raw_items.len() > MAX_HISTORY_ITEMS {
        return Err(ApiFailure::unavailable(
            "The listening-history response exceeded the supported item count",
        ));
    }
    let mut seen = HashSet::new();
    let items = raw_items
        .iter()
        .filter_map(|item| {
            let song = item.get("song").filter(|candidate| candidate.is_object())?;
            let track = parse_track_with_privilege(song, None)?;
            let id = match &track {
                CatalogItem::Track { id, .. } => *id,
                _ => return None,
            };
            seen.insert(id).then_some(LibraryHistoryItem {
                track,
                play_count: value_u64(item, "playCount"),
            })
        })
        .collect::<Vec<_>>();
    if !raw_items.is_empty() && items.is_empty() {
        return Err(ApiFailure::unavailable(
            "The listening-history response contained no valid tracks",
        ));
    }
    Ok(LibraryHistory {
        period: period.name(),
        items,
    })
}

fn authenticated_cookie(cookie: Option<String>) -> Result<String, ApiFailure> {
    cookie.ok_or_else(|| {
        ApiFailure::auth_required("A NetEase account is required to access the music library")
    })
}

fn validate_offset(offset: u64) -> Result<(), ApiFailure> {
    if offset > MAX_OFFSET {
        return Err(ApiFailure::invalid("offset must be between 0 and 100000"));
    }
    Ok(())
}

async fn load_playlist_page(
    client: ApiClient,
    user_id: i64,
    offset: u64,
    cookie: &str,
    real_ip: &Option<String>,
) -> Result<LibraryPlaylistPage, ApiFailure> {
    let cookie = Some(cookie.to_string());
    let query = with_request_context(
        Query::new()
            .param("uid", &user_id.to_string())
            .param("limit", &COVER_PAGE_SIZE.to_string())
            .param("offset", &offset.to_string()),
        &cookie,
        real_ip,
    );
    let response = client
        .user_playlist(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    parse_playlist_page(response, offset)
}

async fn load_library_overview(
    client: ApiClient,
    user_id: i64,
    cookie: String,
    real_ip: Option<String>,
) -> Result<LibraryOverview, ApiFailure> {
    let playlists = load_playlist_page(client.clone(), user_id, 0, &cookie, &real_ip).await?;
    let liked = playlists
        .items
        .first()
        .filter(|playlist| playlist.creator_id == user_id)
        .ok_or_else(|| {
            ApiFailure::unavailable("The account's first playlist was not its liked-songs playlist")
        })?;
    let liked_songs = load_playlist_detail(client, liked.id, Some(cookie), real_ip).await?;
    if liked_songs.creator_user_id() != user_id {
        return Err(ApiFailure::unavailable(
            "The liked-songs playlist owner changed between requests",
        ));
    }
    Ok(LibraryOverview {
        liked_songs,
        playlists,
    })
}

async fn load_catalog_page(
    client: ApiClient,
    kind: LibraryCatalogKind,
    offset: u64,
    cookie: String,
    real_ip: Option<String>,
) -> Result<LibraryCatalogPage, ApiFailure> {
    let cookie = Some(cookie);
    let query = with_request_context(
        Query::new()
            .param("limit", &COVER_PAGE_SIZE.to_string())
            .param("offset", &offset.to_string()),
        &cookie,
        &real_ip,
    );
    let response = match kind {
        LibraryCatalogKind::Albums => client.album_sublist(&query).await,
        LibraryCatalogKind::Artists => client.artist_sublist(&query).await,
    }
    .map_err(ApiFailure::from_ncm)?;
    parse_catalog_page(response, kind, offset)
}

#[tauri::command]
pub async fn library_overview(
    request_id: String,
    user_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<LibraryOverview, ApiFailure> {
    if user_id <= 0 {
        return Err(ApiFailure::invalid("userId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie)?;
    state
        .run_cancellable(request_id, async move {
            load_library_overview(client, user_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn library_playlist_page(
    request_id: String,
    user_id: i64,
    offset: u64,
    state: State<'_, MusicApiState>,
) -> Result<LibraryPlaylistPage, ApiFailure> {
    if user_id <= 0 {
        return Err(ApiFailure::invalid("userId must be a positive integer"));
    }
    validate_offset(offset)?;
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie)?;
    state
        .run_cancellable(request_id, async move {
            load_playlist_page(client, user_id, offset, &cookie, &real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn library_catalog_page(
    request_id: String,
    section: String,
    offset: u64,
    state: State<'_, MusicApiState>,
) -> Result<LibraryCatalogPage, ApiFailure> {
    let kind = LibraryCatalogKind::from_name(&section)
        .ok_or_else(|| ApiFailure::invalid("section must be albums or artists"))?;
    validate_offset(offset)?;
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie)?;
    state
        .run_cancellable(request_id, async move {
            load_catalog_page(client, kind, offset, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn library_history(
    request_id: String,
    user_id: i64,
    period: String,
    state: State<'_, MusicApiState>,
) -> Result<LibraryHistory, ApiFailure> {
    if user_id <= 0 {
        return Err(ApiFailure::invalid("userId must be a positive integer"));
    }
    let period = HistoryPeriod::from_name(&period)
        .ok_or_else(|| ApiFailure::invalid("period must be week or all"))?;
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie)?;
    state
        .run_cancellable(request_id, async move {
            let cookie = Some(cookie);
            let query = with_request_context(
                Query::new()
                    .param("uid", &user_id.to_string())
                    .param("type", period.api_type()),
                &cookie,
                &real_ip,
            );
            let response = client
                .user_record(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            parse_history(response, period)
        })
        .await
}

#[tauri::command]
pub async fn create_library_playlist(
    request_id: String,
    name: String,
    private: bool,
    state: State<'_, MusicApiState>,
) -> Result<LibraryPlaylist, ApiFailure> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(ApiFailure::invalid(
            "name must contain between 1 and 40 characters",
        ));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie)?;
    state
        .run_cancellable(request_id, async move {
            let cookie = Some(cookie);
            let query = with_request_context(
                Query::new()
                    .param("name", &name)
                    .param("privacy", if private { "10" } else { "0" }),
                &cookie,
                &real_ip,
            );
            let response = client
                .playlist_create(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            let playlist = response
                .body
                .get("playlist")
                .filter(|value| value.is_object())
                .ok_or_else(|| {
                    ApiFailure::unavailable("The create-playlist response omitted the playlist")
                })?;
            parse_library_playlist(playlist).ok_or_else(|| {
                ApiFailure::unavailable("The create-playlist response was malformed")
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::ApiResponse;
    use serde_json::{json, Value};

    use super::{parse_history, parse_playlist_page, HistoryPeriod};

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    fn song(id: i64, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "dt": 180000,
            "ar": [{ "id": 7, "name": "Artist" }],
            "al": { "id": 8, "name": "Album", "picUrl": "http://img.test/a.jpg" }
        })
    }

    #[test]
    fn playlist_pages_deduplicate_cards_but_advance_by_raw_rows() {
        let page = parse_playlist_page(
            response(json!({
                "more": true,
                "playlist": [
                    {
                        "id": 1,
                        "name": "Liked",
                        "coverImgUrl": "http://img.test/1.jpg",
                        "creator": { "userId": 9, "nickname": "Listener" },
                        "trackCount": 20
                    },
                    {
                        "id": 1,
                        "name": "Duplicate",
                        "coverImgUrl": "http://img.test/1.jpg",
                        "creator": { "userId": 9, "nickname": "Listener" }
                    },
                    { "id": -1, "name": "Malformed" },
                    {
                        "id": 2,
                        "name": "Saved",
                        "coverImgUrl": "http://img.test/2.jpg",
                        "creator": { "userId": 10, "nickname": "Other" }
                    }
                ]
            })),
            50,
        )
        .expect("playlist page");

        assert_eq!(page.items.len(), 2);
        assert_eq!(page.next_offset, 54);
        assert!(page.has_more);
        assert_eq!(page.items[0].cover_url, "https://img.test/1.jpg");
    }

    #[test]
    fn history_keeps_play_counts_and_rejects_duplicate_tracks() {
        let history = parse_history(
            response(json!({
                "weekData": [
                    { "playCount": 12, "song": song(1, "One") },
                    { "playCount": 6, "song": song(1, "Duplicate") },
                    { "playCount": 2, "song": song(2, "Two") }
                ]
            })),
            HistoryPeriod::Week,
        )
        .expect("history");
        let value = serde_json::to_value(history).expect("serialize history");

        assert_eq!(value["period"], "week");
        assert_eq!(value["items"].as_array().map(Vec::len), Some(2));
        assert_eq!(value["items"][0]["playCount"], 12);
    }
}
