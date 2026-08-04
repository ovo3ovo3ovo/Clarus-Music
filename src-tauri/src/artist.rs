use std::collections::{HashMap, HashSet};

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

const MAX_POPULAR_TRACKS: usize = 100;
const ARTIST_ALBUM_LIMIT: u16 = 200;
const ARTIST_OVERVIEW_VIDEO_LIMIT: u16 = 30;
const ARTIST_VIDEO_PAGE_SIZE: u16 = 100;
const MAX_SIMILAR_ARTISTS: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistIdentity {
    id: i64,
    name: String,
    cover_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistProfile {
    id: i64,
    name: String,
    cover_url: String,
    brief_description: String,
    music_count: u64,
    album_count: u64,
    video_count: u64,
    followed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistAlbum {
    id: i64,
    artist_id: i64,
    name: String,
    cover_url: String,
    publish_time: u64,
    album_type: String,
    track_count: u64,
    explicit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtistVideo {
    id: i64,
    artist_id: i64,
    name: String,
    cover_url: String,
    publish_time: String,
}

struct ArtistAlbumSections {
    latest: Option<ArtistAlbum>,
    albums: Vec<ArtistAlbum>,
    eps: Vec<ArtistAlbum>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetail {
    artist: ArtistProfile,
    popular_tracks: Vec<CatalogItem>,
    latest_release: Option<ArtistAlbum>,
    albums: Vec<ArtistAlbum>,
    eps: Vec<ArtistAlbum>,
    videos: Vec<ArtistVideo>,
    videos_has_more: bool,
    similar_artists: Vec<ArtistIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistVideoPage {
    items: Vec<ArtistVideo>,
    next_offset: u64,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSubscription {
    followed: bool,
}

fn artist_object(body: &Value) -> Option<&Value> {
    body.get("artist")
        .filter(|value| value.is_object())
        .or_else(|| {
            body.get("data")
                .and_then(|data| data.get("artist"))
                .filter(|value| value.is_object())
        })
}

fn parse_artist_identity(value: &Value, expected_id: Option<i64>) -> Option<ArtistIdentity> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["cover", "img1v1Url", "picUrl"]);
    (id > 0
        && expected_id.is_none_or(|expected| expected == id)
        && !name.is_empty()
        && !cover_url.is_empty())
    .then_some(ArtistIdentity {
        id,
        name,
        cover_url,
    })
}

fn privilege_map(body: &Value) -> HashMap<i64, &Value> {
    array(body, &["privileges"])
        .iter()
        .filter_map(|privilege| value_i64(privilege, "id").map(|id| (id, privilege)))
        .collect()
}

fn parse_artist_detail_response(
    response: ApiResponse,
    expected_id: i64,
) -> Result<ArtistDetail, ApiFailure> {
    let body = response.body;
    let artist_value = artist_object(&body)
        .ok_or_else(|| ApiFailure::unavailable("The artist response contained no artist"))?;
    let identity = parse_artist_identity(artist_value, Some(expected_id)).ok_or_else(|| {
        ApiFailure::unavailable("The artist response omitted required profile metadata")
    })?;
    let raw_tracks = array(&body, &["hotSongs"]);
    if raw_tracks.len() > MAX_POPULAR_TRACKS {
        return Err(ApiFailure::unavailable(
            "The artist response exceeded the supported popular-track count",
        ));
    }
    let privileges = privilege_map(&body);
    let mut seen_tracks = HashSet::new();
    let mut popular_tracks = Vec::new();
    for track in raw_tracks {
        let Some(id) = value_i64(track, "id").filter(|id| *id > 0) else {
            continue;
        };
        if !seen_tracks.insert(id) {
            return Err(ApiFailure::unavailable(
                "The artist response contained duplicate popular tracks",
            ));
        }
        if let Some(track) = parse_track_with_privilege(track, privileges.get(&id).copied()) {
            popular_tracks.push(track);
        }
    }
    if !raw_tracks.is_empty() && popular_tracks.is_empty() {
        return Err(ApiFailure::unavailable(
            "The artist response contained no valid popular tracks",
        ));
    }

    Ok(ArtistDetail {
        artist: ArtistProfile {
            id: identity.id,
            name: identity.name,
            cover_url: identity.cover_url,
            brief_description: value_string(artist_value, "briefDesc"),
            music_count: value_u64(artist_value, "musicSize").max(popular_tracks.len() as u64),
            album_count: value_u64(artist_value, "albumSize"),
            video_count: value_u64(artist_value, "mvSize"),
            followed: artist_value
                .get("followed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        popular_tracks,
        latest_release: None,
        albums: Vec::new(),
        eps: Vec::new(),
        videos: Vec::new(),
        videos_has_more: false,
        similar_artists: Vec::new(),
    })
}

fn embedded_artist_id(value: &Value) -> Option<i64> {
    value
        .get("artist")
        .and_then(|artist| value_i64(artist, "id"))
        .or_else(|| {
            array(value, &["artists"])
                .first()
                .and_then(|artist| value_i64(artist, "id"))
        })
}

fn parse_artist_album(value: &Value, expected_artist_id: i64) -> Option<ArtistAlbum> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["picUrl", "coverUrl"]);
    (id > 0
        && embedded_artist_id(value) == Some(expected_artist_id)
        && !name.is_empty()
        && !cover_url.is_empty())
    .then_some(ArtistAlbum {
        id,
        artist_id: expected_artist_id,
        name,
        cover_url,
        publish_time: value_u64(value, "publishTime"),
        album_type: value_string(value, "type"),
        track_count: value_u64(value, "size"),
        explicit: value_u64(value, "mark") & 1_048_576 == 1_048_576,
    })
}

fn parse_artist_albums(
    response: ApiResponse,
    expected_artist_id: i64,
) -> Result<ArtistAlbumSections, ApiFailure> {
    let raw_albums = array(&response.body, &["hotAlbums"]);
    if raw_albums.len() > usize::from(ARTIST_ALBUM_LIMIT) {
        return Err(ApiFailure::unavailable(
            "The artist album response exceeded the requested limit",
        ));
    }
    let mut seen = HashSet::new();
    let mapped = raw_albums
        .iter()
        .filter_map(|value| parse_artist_album(value, expected_artist_id))
        .filter(|album| seen.insert(album.id))
        .collect::<Vec<_>>();
    let latest = mapped.first().cloned();
    let albums = mapped
        .iter()
        .filter(|album| album.album_type == "专辑" || album.album_type == "精选集")
        .cloned()
        .collect();
    let eps = mapped
        .iter()
        .filter(|album| matches!(album.album_type.as_str(), "EP/Single" | "EP" | "Single"))
        .cloned()
        .collect();
    Ok(ArtistAlbumSections {
        latest,
        albums,
        eps,
    })
}

fn publish_time(value: &Value) -> String {
    value
        .get("publishTime")
        .and_then(|candidate| {
            candidate
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .or_else(|| candidate.as_u64().map(|time| time.to_string()))
        })
        .unwrap_or_default()
}

fn parse_artist_video(value: &Value, expected_artist_id: i64) -> Option<ArtistVideo> {
    let id = value_i64(value, "id").or_else(|| value_i64(value, "vid"))?;
    let name = match value_string(value, "name") {
        name if name.is_empty() => value_string(value, "title"),
        name => name,
    };
    let cover_url = normalized_image_url(value, &["imgurl16v9", "cover", "coverUrl"]);
    (id > 0 && !name.is_empty() && !cover_url.is_empty()).then_some(ArtistVideo {
        id,
        artist_id: expected_artist_id,
        name,
        cover_url,
        publish_time: publish_time(value),
    })
}

fn parse_artist_videos(
    response: ApiResponse,
    maximum: usize,
    expected_artist_id: i64,
) -> Result<(Vec<ArtistVideo>, u64, Option<bool>), ApiFailure> {
    let raw_videos = array(&response.body, &["mvs"]);
    if raw_videos.len() > maximum {
        return Err(ApiFailure::unavailable(
            "The artist video response exceeded the requested limit",
        ));
    }
    let mut seen = HashSet::new();
    let videos = raw_videos
        .iter()
        .filter_map(|video| parse_artist_video(video, expected_artist_id))
        .filter(|video| seen.insert(video.id))
        .collect();
    Ok((
        videos,
        raw_videos.len() as u64,
        response.body.get("hasMore").and_then(Value::as_bool),
    ))
}

fn parse_similar_artists(response: ApiResponse, current_id: i64) -> Vec<ArtistIdentity> {
    let mut seen = HashSet::new();
    array(&response.body, &["artists"])
        .iter()
        .filter_map(|artist| parse_artist_identity(artist, None))
        .filter(|artist| artist.id != current_id && seen.insert(artist.id))
        .take(MAX_SIMILAR_ARTISTS)
        .collect()
}

async fn load_artist_detail(
    client: ApiClient,
    artist_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<ArtistDetail, ApiFailure> {
    let core_query = with_request_context(
        Query::new().param("id", &artist_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .artists(&core_query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let mut detail = parse_artist_detail_response(response, artist_id)?;

    let albums_query = with_request_context(
        Query::new()
            .param("id", &artist_id.to_string())
            .param("limit", &ARTIST_ALBUM_LIMIT.to_string())
            .param("offset", "0"),
        &cookie,
        &real_ip,
    );
    let videos_query = with_request_context(
        Query::new()
            .param("id", &artist_id.to_string())
            .param("limit", &ARTIST_OVERVIEW_VIDEO_LIMIT.to_string())
            .param("offset", "0"),
        &cookie,
        &real_ip,
    );
    let similar_query = with_request_context(
        Query::new().param("id", &artist_id.to_string()),
        &cookie,
        &real_ip,
    );
    let should_load_similar = cookie.is_some();
    let (albums, videos, similar) = tokio::join!(
        client.artist_album(&albums_query),
        client.artist_mv(&videos_query),
        async {
            if should_load_similar {
                client.simi_artist(&similar_query).await.ok()
            } else {
                None
            }
        }
    );
    if let Ok(response) = albums {
        if let Ok(sections) = parse_artist_albums(response, artist_id) {
            detail.latest_release = sections.latest;
            detail.albums = sections.albums;
            detail.eps = sections.eps;
        }
    }
    if let Ok(response) = videos {
        if let Ok((videos, returned, api_has_more)) = parse_artist_videos(
            response,
            usize::from(ARTIST_OVERVIEW_VIDEO_LIMIT),
            artist_id,
        ) {
            detail.videos = videos;
            detail.videos_has_more = returned > 0
                && api_has_more.unwrap_or(returned == u64::from(ARTIST_OVERVIEW_VIDEO_LIMIT));
        }
    }
    if let Some(response) = similar {
        detail.similar_artists = parse_similar_artists(response, artist_id);
    }
    Ok(detail)
}

fn parse_artist_header_response(
    response: ApiResponse,
    expected_id: i64,
) -> Result<ArtistIdentity, ApiFailure> {
    artist_object(&response.body)
        .and_then(|artist| parse_artist_identity(artist, Some(expected_id)))
        .ok_or_else(|| ApiFailure::unavailable("The artist header response was invalid"))
}

async fn load_artist_header(
    client: ApiClient,
    artist_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<ArtistIdentity, ApiFailure> {
    let query = with_request_context(
        Query::new().param("id", &artist_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .artist_detail(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    parse_artist_header_response(response, artist_id)
}

async fn load_artist_video_page(
    client: ApiClient,
    artist_id: i64,
    offset: u64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<ArtistVideoPage, ApiFailure> {
    let query = with_request_context(
        Query::new()
            .param("id", &artist_id.to_string())
            .param("limit", &ARTIST_VIDEO_PAGE_SIZE.to_string())
            .param("offset", &offset.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .artist_mv(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let (items, returned, api_has_more) =
        parse_artist_videos(response, usize::from(ARTIST_VIDEO_PAGE_SIZE), artist_id)?;
    let next_offset = offset.saturating_add(returned);
    Ok(ArtistVideoPage {
        items,
        next_offset,
        has_more: returned > 0
            && api_has_more.unwrap_or(returned == u64::from(ARTIST_VIDEO_PAGE_SIZE)),
    })
}

#[tauri::command]
pub async fn artist_detail(
    request_id: String,
    artist_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<ArtistDetail, ApiFailure> {
    if artist_id <= 0 {
        return Err(ApiFailure::invalid("artistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_artist_detail(client, artist_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn artist_header(
    request_id: String,
    artist_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<ArtistIdentity, ApiFailure> {
    if artist_id <= 0 {
        return Err(ApiFailure::invalid("artistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_artist_header(client, artist_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn artist_video_page(
    request_id: String,
    artist_id: i64,
    offset: u64,
    state: State<'_, MusicApiState>,
) -> Result<ArtistVideoPage, ApiFailure> {
    if artist_id <= 0 {
        return Err(ApiFailure::invalid("artistId must be a positive integer"));
    }
    if offset > 1_000_000 {
        return Err(ApiFailure::invalid("offset is outside the supported range"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_artist_video_page(client, artist_id, offset, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn set_artist_subscription(
    request_id: String,
    artist_id: i64,
    followed: bool,
    state: State<'_, MusicApiState>,
) -> Result<ArtistSubscription, ApiFailure> {
    if artist_id <= 0 {
        return Err(ApiFailure::invalid("artistId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    if cookie.is_none() {
        return Err(ApiFailure::auth_required(
            "A NetEase account is required to follow artists",
        ));
    }
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("id", &artist_id.to_string())
                    .param("t", if followed { "1" } else { "0" }),
                &cookie,
                &real_ip,
            );
            client
                .artist_sub(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(ArtistSubscription { followed })
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::{json, Value};

    use super::{
        load_artist_detail, load_artist_header, load_artist_video_page, parse_artist_albums,
        parse_artist_detail_response, parse_artist_videos,
    };

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    #[test]
    fn maps_artist_profile_and_popular_track_privileges() {
        let detail = parse_artist_detail_response(
            response(json!({
                "artist": {
                    "id": 20,
                    "name": "Artist",
                    "img1v1Url": "http://img.test/artist.jpg",
                    "briefDesc": "Description",
                    "musicSize": 100,
                    "albumSize": 12,
                    "mvSize": 4,
                    "followed": true
                },
                "hotSongs": [{
                    "id": 1,
                    "name": "Track",
                    "dt": 1_000,
                    "ar": [{ "id": 20, "name": "Artist" }],
                    "al": { "id": 30, "name": "Album", "picUrl": "https://img.test/a.jpg" }
                }],
                "privileges": [{ "id": 1, "pl": 0, "fee": 1, "st": 0 }]
            })),
            20,
        )
        .expect("artist detail");

        let serialized = serde_json::to_value(detail).expect("serialize artist detail");
        assert_eq!(
            serialized["artist"]["coverUrl"],
            "https://img.test/artist.jpg"
        );
        assert_eq!(serialized["popularTracks"][0]["playable"], false);
        assert_eq!(
            serialized["popularTracks"][0]["unavailableReason"],
            "VIP Only"
        );
    }

    #[test]
    fn rejects_duplicate_popular_tracks() {
        let result = parse_artist_detail_response(
            response(json!({
                "artist": {
                    "id": 20,
                    "name": "Artist",
                    "img1v1Url": "https://img.test/artist.jpg"
                },
                "hotSongs": [
                    {
                        "id": 1,
                        "name": "Track",
                        "ar": [{ "id": 20, "name": "Artist" }],
                        "al": { "id": 30, "name": "Album", "picUrl": "https://img.test/a.jpg" }
                    },
                    {
                        "id": 1,
                        "name": "Duplicate",
                        "ar": [{ "id": 20, "name": "Artist" }],
                        "al": { "id": 30, "name": "Album", "picUrl": "https://img.test/a.jpg" }
                    }
                ]
            })),
            20,
        );

        assert!(result.is_err());
    }

    #[test]
    fn groups_artist_albums_like_the_legacy_page() {
        let sections = parse_artist_albums(
            response(json!({
                "hotAlbums": [
                    { "id": 1, "name": "Latest EP", "picUrl": "https://img.test/1.jpg", "type": "EP/Single", "size": 3, "artist": { "id": 20 } },
                    { "id": 2, "name": "Album", "picUrl": "https://img.test/2.jpg", "type": "专辑", "size": 10, "artist": { "id": 20 } },
                    { "id": 3, "name": "Compilation", "picUrl": "https://img.test/3.jpg", "type": "精选集", "size": 8, "artist": { "id": 20 } },
                    { "id": 4, "name": "Other", "picUrl": "https://img.test/4.jpg", "type": "Other", "size": 1, "artist": { "id": 20 } }
                ]
            })),
            20,
        )
        .expect("artist albums");

        assert_eq!(sections.latest.expect("latest").id, 1);
        assert_eq!(
            sections
                .albums
                .iter()
                .map(|album| album.id)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            sections
                .eps
                .iter()
                .map(|album| album.id)
                .collect::<Vec<_>>(),
            [1]
        );
    }

    #[test]
    fn maps_artist_video_ids_and_raw_pagination_progress() {
        let (videos, returned, has_more) = parse_artist_videos(
            response(json!({
                "mvs": [
                    { "id": 1, "name": "MV", "imgurl16v9": "http://img.test/1.jpg", "publishTime": "2026-01-01" },
                    { "vid": 2, "title": "Video", "coverUrl": "https://img.test/2.jpg" }
                ],
                "hasMore": true
            })),
            100,
            20,
        )
        .expect("artist videos");

        assert_eq!(videos.len(), 2);
        assert_eq!(returned, 2);
        assert_eq!(has_more, Some(true));
        assert_eq!(videos[0].cover_url, "https://img.test/1.jpg");
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_artist_contracts() {
        let client = create_client(None);
        let detail = load_artist_detail(client.clone(), 6452, None, None)
            .await
            .expect("artist detail");
        assert_eq!(detail.artist.id, 6452);
        assert!(!detail.popular_tracks.is_empty());
        assert!(detail.latest_release.is_some());

        let header = load_artist_header(client.clone(), 6452, None, None)
            .await
            .expect("artist header");
        assert_eq!(header.id, 6452);

        let page = load_artist_video_page(client, 6452, 0, None, None)
            .await
            .expect("artist video page");
        assert!(page.next_offset > 0);
        assert!(!page.items.is_empty());
    }
}
