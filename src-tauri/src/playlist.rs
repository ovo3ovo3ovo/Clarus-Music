use std::collections::HashMap;

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    catalog::{
        array, normalized_image_url, parse_track_with_privilege, value_i64, value_string,
        value_u64, CatalogItem,
    },
    music_api::{with_request_context, ApiFailure, MusicApiState},
};

const PLAYLIST_PAGE_SIZE: usize = 100;
const MAX_PLAYLIST_TRACKS: usize = 100_000;
const MAX_MUTATION_TRACKS: usize = 100;
const MAX_PLAYLIST_NAME_CHARS: usize = 40;
const MAX_PLAYLIST_DESCRIPTION_CHARS: usize = 1_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistCreator {
    user_id: i64,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    id: i64,
    name: String,
    cover_url: String,
    creator: PlaylistCreator,
    update_time: u64,
    track_count: u64,
    description: String,
    private: bool,
    subscribed: bool,
    track_ids: Vec<i64>,
    tracks: Vec<CatalogItem>,
    next_offset: u64,
    has_more: bool,
}

impl PlaylistDetail {
    pub(crate) fn creator_user_id(&self) -> i64 {
        self.creator.user_id
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrackPage {
    tracks: Vec<CatalogItem>,
    requested_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSubscription {
    subscribed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistMutation {
    playlist_id: i64,
    affected_track_ids: Vec<i64>,
}

fn authenticated_cookie(
    cookie: Option<String>,
    message: &'static str,
) -> Result<String, ApiFailure> {
    cookie.ok_or_else(|| ApiFailure::auth_required(message))
}

fn validate_track_ids(track_ids: &[i64]) -> Result<(), ApiFailure> {
    if track_ids.is_empty()
        || track_ids.len() > MAX_MUTATION_TRACKS
        || track_ids.iter().any(|id| *id <= 0)
        || track_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != track_ids.len()
    {
        return Err(ApiFailure::invalid(
            "trackIds must contain 1 to 100 unique positive integers",
        ));
    }
    Ok(())
}

fn privilege_map(body: &Value) -> HashMap<i64, &Value> {
    array(body, &["privileges"])
        .iter()
        .filter_map(|privilege| value_i64(privilege, "id").map(|id| (id, privilege)))
        .collect()
}

fn parse_tracks_in_order(
    body: &Value,
    raw_tracks: &[Value],
    expected_ids: &[i64],
) -> Vec<CatalogItem> {
    let privileges = privilege_map(body);
    let mut by_id = raw_tracks
        .iter()
        .filter_map(|track| {
            let id = value_i64(track, "id")?;
            let parsed = parse_track_with_privilege(track, privileges.get(&id).copied())?;
            Some((id, parsed))
        })
        .collect::<HashMap<_, _>>();

    expected_ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .collect()
}

fn parse_playlist_detail_response(
    response: ApiResponse,
    expected_id: i64,
) -> Result<PlaylistDetail, ApiFailure> {
    let body = response.body;
    let playlist = body
        .get("playlist")
        .filter(|value| value.is_object())
        .ok_or_else(|| ApiFailure::unavailable("The playlist response contained no playlist"))?;
    let id = value_i64(playlist, "id")
        .filter(|id| *id == expected_id)
        .ok_or_else(|| ApiFailure::unavailable("The playlist response contained an invalid id"))?;
    let name = value_string(playlist, "name");
    let cover_url = normalized_image_url(playlist, &["coverImgUrl", "picUrl"]);
    if name.is_empty() || cover_url.is_empty() {
        return Err(ApiFailure::unavailable(
            "The playlist response omitted required metadata",
        ));
    }

    let creator = playlist.get("creator").filter(|value| value.is_object());
    let track_ids = array(playlist, &["trackIds"])
        .iter()
        .filter_map(|track| value_i64(track, "id").filter(|id| *id > 0))
        .take(MAX_PLAYLIST_TRACKS)
        .collect::<Vec<_>>();
    let raw_tracks = array(playlist, &["tracks"]);
    let covered_count = raw_tracks
        .len()
        .min(track_ids.len())
        .min(PLAYLIST_PAGE_SIZE);
    let tracks = parse_tracks_in_order(
        &body,
        &raw_tracks[..covered_count],
        &track_ids[..covered_count],
    );
    let next_offset = covered_count as u64;
    let track_count = value_u64(playlist, "trackCount").max(track_ids.len() as u64);
    let has_more = next_offset < track_ids.len() as u64;

    Ok(PlaylistDetail {
        id,
        name,
        cover_url,
        creator: PlaylistCreator {
            user_id: creator
                .and_then(|value| value_i64(value, "userId"))
                .unwrap_or_default(),
            name: creator
                .map(|value| value_string(value, "nickname"))
                .unwrap_or_default(),
        },
        update_time: value_u64(playlist, "updateTime"),
        track_count,
        description: value_string(playlist, "description"),
        private: value_i64(playlist, "privacy") == Some(10),
        subscribed: playlist
            .get("subscribed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        track_ids,
        tracks,
        next_offset,
        has_more,
    })
}

fn parse_playlist_track_page(response: ApiResponse, expected_ids: &[i64]) -> PlaylistTrackPage {
    let body = response.body;
    let tracks = parse_tracks_in_order(&body, array(&body, &["songs"]), expected_ids);
    PlaylistTrackPage {
        tracks,
        requested_count: expected_ids.len() as u64,
    }
}

fn parse_liked_playlist_id(
    response: ApiResponse,
    expected_user_id: i64,
) -> Result<i64, ApiFailure> {
    let playlist = array(&response.body, &["playlist"])
        .first()
        .filter(|value| value.is_object())
        .ok_or_else(|| ApiFailure::unavailable("The account has no liked-songs playlist"))?;
    let playlist_id = value_i64(playlist, "id")
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiFailure::unavailable("The liked-songs playlist has an invalid id"))?;
    let creator_id = playlist
        .get("creator")
        .and_then(|creator| value_i64(creator, "userId"));
    if creator_id != Some(expected_user_id) {
        return Err(ApiFailure::unavailable(
            "The liked-songs playlist did not belong to the authenticated account",
        ));
    }
    Ok(playlist_id)
}

pub(crate) async fn load_playlist_detail(
    client: ApiClient,
    playlist_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<PlaylistDetail, ApiFailure> {
    let query = with_request_context(
        Query::new().param("id", &playlist_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .playlist_detail(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    parse_playlist_detail_response(response, playlist_id)
}

async fn load_playlist_track_page(
    client: ApiClient,
    track_ids: Vec<i64>,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<PlaylistTrackPage, ApiFailure> {
    let ids = track_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let query = with_request_context(Query::new().param("ids", &ids), &cookie, &real_ip);
    let response = client
        .song_detail(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    Ok(parse_playlist_track_page(response, &track_ids))
}

async fn load_liked_songs_detail(
    client: ApiClient,
    user_id: i64,
    cookie: String,
    real_ip: Option<String>,
) -> Result<PlaylistDetail, ApiFailure> {
    let cookie = Some(cookie);
    let query = with_request_context(
        Query::new()
            .param("uid", &user_id.to_string())
            .param("limit", "1")
            .param("offset", "0"),
        &cookie,
        &real_ip,
    );
    let response = client
        .user_playlist(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let playlist_id = parse_liked_playlist_id(response, user_id)?;
    let detail = load_playlist_detail(client, playlist_id, cookie, real_ip).await?;
    if detail.creator.user_id != user_id {
        return Err(ApiFailure::unavailable(
            "The liked-songs playlist owner changed between requests",
        ));
    }
    Ok(detail)
}

#[tauri::command]
pub async fn playlist_detail(
    request_id: String,
    playlist_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistDetail, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_playlist_detail(client, playlist_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn liked_songs_detail(
    request_id: String,
    user_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistDetail, ApiFailure> {
    if user_id <= 0 {
        return Err(ApiFailure::invalid("userId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = cookie.ok_or_else(|| {
        ApiFailure::auth_required("A NetEase account is required to load liked songs")
    })?;
    state
        .run_cancellable(request_id, async move {
            load_liked_songs_detail(client, user_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn playlist_track_page(
    request_id: String,
    track_ids: Vec<i64>,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistTrackPage, ApiFailure> {
    if track_ids.is_empty()
        || track_ids.len() > PLAYLIST_PAGE_SIZE
        || track_ids.iter().any(|id| *id <= 0)
    {
        return Err(ApiFailure::invalid(
            "trackIds must contain between 1 and 100 positive integers",
        ));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_playlist_track_page(client, track_ids, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn set_playlist_subscription(
    request_id: String,
    playlist_id: i64,
    subscribed: bool,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistSubscription, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    if cookie.is_none() {
        return Err(ApiFailure::auth_required(
            "A NetEase account is required to save playlists",
        ));
    }
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("id", &playlist_id.to_string())
                    .param("t", if subscribed { "1" } else { "2" }),
                &cookie,
                &real_ip,
            );
            client
                .playlist_subscribe(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(PlaylistSubscription { subscribed })
        })
        .await
}

#[tauri::command]
pub async fn update_playlist_name(
    request_id: String,
    playlist_id: i64,
    name: String,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_PLAYLIST_NAME_CHARS {
        return Err(ApiFailure::invalid(
            "name must contain between 1 and 40 characters",
        ));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie, "A NetEase account is required to rename playlists")?;
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("id", &playlist_id.to_string())
                    .param("name", &name),
                &Some(cookie),
                &real_ip,
            );
            client
                .playlist_name_update(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(PlaylistMutation {
                playlist_id,
                affected_track_ids: Vec::new(),
            })
        })
        .await
}

#[tauri::command]
pub async fn update_playlist_description(
    request_id: String,
    playlist_id: i64,
    description: String,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    let description = description.trim().to_string();
    if description.chars().count() > MAX_PLAYLIST_DESCRIPTION_CHARS {
        return Err(ApiFailure::invalid(
            "description must be at most 1000 characters",
        ));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie, "A NetEase account is required to edit playlists")?;
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("id", &playlist_id.to_string())
                    .param("desc", &description),
                &Some(cookie),
                &real_ip,
            );
            client
                .playlist_desc_update(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(PlaylistMutation {
                playlist_id,
                affected_track_ids: Vec::new(),
            })
        })
        .await
}

#[tauri::command]
pub async fn delete_playlist(
    request_id: String,
    playlist_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie, "A NetEase account is required to delete playlists")?;
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new().param("id", &playlist_id.to_string()),
                &Some(cookie),
                &real_ip,
            );
            client
                .playlist_delete(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(PlaylistMutation {
                playlist_id,
                affected_track_ids: Vec::new(),
            })
        })
        .await
}

async fn mutate_playlist_tracks(
    request_id: String,
    playlist_id: i64,
    track_ids: Vec<i64>,
    operation: &'static str,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    if playlist_id <= 0 {
        return Err(ApiFailure::invalid("playlistId must be a positive integer"));
    }
    validate_track_ids(&track_ids)?;
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = authenticated_cookie(cookie, "A NetEase account is required to edit playlists")?;
    state
        .run_cancellable(request_id, async move {
            let ids = track_ids
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let query = with_request_context(
                Query::new()
                    .param("op", operation)
                    .param("pid", &playlist_id.to_string())
                    .param("tracks", &ids),
                &Some(cookie),
                &real_ip,
            );
            client
                .playlist_tracks(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(PlaylistMutation {
                playlist_id,
                affected_track_ids: track_ids,
            })
        })
        .await
}

#[tauri::command]
pub async fn add_playlist_tracks(
    request_id: String,
    playlist_id: i64,
    track_ids: Vec<i64>,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    mutate_playlist_tracks(request_id, playlist_id, track_ids, "add", state).await
}

#[tauri::command]
pub async fn remove_playlist_tracks(
    request_id: String,
    playlist_id: i64,
    track_ids: Vec<i64>,
    state: State<'_, MusicApiState>,
) -> Result<PlaylistMutation, ApiFailure> {
    mutate_playlist_tracks(request_id, playlist_id, track_ids, "del", state).await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::{json, Value};

    use super::{
        load_playlist_detail, load_playlist_track_page, parse_liked_playlist_id,
        parse_playlist_detail_response, parse_playlist_track_page, validate_track_ids,
    };

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    fn track(id: i64, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "dt": 180000,
            "ar": [{ "id": 7, "name": "Artist" }],
            "al": { "id": 8, "name": "Album", "picUrl": "http://img.test/a.jpg" }
        })
    }

    #[test]
    fn maps_playlist_metadata_tracks_and_separate_privileges() {
        let detail = parse_playlist_detail_response(
            response(json!({
                "playlist": {
                    "id": 42,
                    "name": "Playlist",
                    "coverImgUrl": "http://img.test/p.jpg",
                    "creator": { "userId": 9, "nickname": "Listener" },
                    "updateTime": 123,
                    "trackCount": 2,
                    "description": "Description",
                    "privacy": 10,
                    "subscribed": true,
                    "trackIds": [{ "id": 1 }, { "id": 2 }],
                    "tracks": [track(1, "One"), track(2, "Two")]
                },
                "privileges": [
                    { "id": 1, "pl": 320000, "fee": 0, "st": 0 },
                    { "id": 2, "pl": 0, "fee": 1, "st": 0 }
                ]
            })),
            42,
        )
        .expect("playlist detail");

        assert_eq!(detail.track_ids, vec![1, 2]);
        assert_eq!(detail.tracks.len(), 2);
        assert!(detail.private);
        assert!(detail.subscribed);
        assert!(!detail.has_more);
        let serialized = serde_json::to_value(detail).expect("serialize detail");
        assert_eq!(serialized["coverUrl"], "https://img.test/p.jpg");
        assert_eq!(serialized["tracks"][1]["playable"], false);
        assert_eq!(serialized["tracks"][1]["unavailableReason"], "VIP Only");
        assert!(serialized.get("track_ids").is_none());
    }

    #[test]
    fn track_pages_preserve_requested_order_and_raw_progress() {
        let page = parse_playlist_track_page(
            response(json!({
                "songs": [track(2, "Two"), track(1, "One")],
                "privileges": [
                    { "id": 1, "pl": 320000 },
                    { "id": 2, "pl": 320000 }
                ]
            })),
            &[1, 2, 3],
        );
        let serialized = serde_json::to_value(&page).expect("serialize page");

        assert_eq!(page.requested_count, 3);
        assert_eq!(serialized["tracks"][0]["id"], 1);
        assert_eq!(serialized["tracks"][1]["id"], 2);
    }

    #[test]
    fn resolves_only_the_authenticated_users_first_playlist_as_liked_songs() {
        let playlist_id = parse_liked_playlist_id(
            response(json!({
                "playlist": [{
                    "id": 99,
                    "creator": { "userId": 42 },
                    "name": "Liked Songs"
                }]
            })),
            42,
        )
        .expect("liked-songs playlist id");
        assert_eq!(playlist_id, 99);

        let mismatched = parse_liked_playlist_id(
            response(json!({
                "playlist": [{ "id": 99, "creator": { "userId": 7 } }]
            })),
            42,
        );
        assert!(mismatched.is_err());
    }

    #[test]
    fn validates_bounded_unique_playlist_mutations() {
        assert!(validate_track_ids(&[1, 2, 3]).is_ok());
        assert!(validate_track_ids(&[]).is_err());
        assert!(validate_track_ids(&[1, 1]).is_err());
        assert!(validate_track_ids(&[0]).is_err());
        assert!(validate_track_ids(&(1..=101).collect::<Vec<_>>()).is_err());
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_playlist_detail_and_track_page_contract() {
        let client = create_client(None);
        let detail = load_playlist_detail(client.clone(), 3778678, None, None)
            .await
            .expect("playlist detail");

        assert_eq!(detail.id, 3778678);
        assert!(!detail.name.is_empty());
        assert!(!detail.track_ids.is_empty());
        assert!(!detail.tracks.is_empty());
        let next_ids = detail
            .track_ids
            .iter()
            .skip(detail.next_offset as usize)
            .take(10)
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(
            next_ids.len(),
            10,
            "live fixture must exercise a second page"
        );
        let page = load_playlist_track_page(client, next_ids.clone(), None, None)
            .await
            .expect("playlist track page");
        assert_eq!(page.requested_count, next_ids.len() as u64);
        assert!(!page.tracks.is_empty());
    }
}
