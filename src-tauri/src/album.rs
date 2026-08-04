use std::collections::{BTreeMap, HashMap};

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    catalog::{
        array, normalized_image_url, parse_album_card, parse_track_with_privilege, value_i64,
        value_string, value_u64, CatalogItem,
    },
    music_api::{with_request_context, ApiFailure, MusicApiState},
};

const MAX_ALBUM_TRACKS: usize = 10_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumArtist {
    id: i64,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumDisc {
    disc: String,
    tracks: Vec<CatalogItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetail {
    id: i64,
    name: String,
    cover_url: String,
    artist: AlbumArtist,
    publish_time: u64,
    track_count: u64,
    duration_ms: u64,
    description: String,
    company: String,
    album_type: String,
    explicit: bool,
    subscribed: bool,
    discs: Vec<AlbumDisc>,
    more_albums: Vec<CatalogItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSubscription {
    subscribed: bool,
}

fn privilege_map(body: &Value) -> HashMap<i64, &Value> {
    array(body, &["privileges"])
        .iter()
        .filter_map(|privilege| value_i64(privilege, "id").map(|id| (id, privilege)))
        .collect()
}

fn parse_album_detail_response(
    response: ApiResponse,
    expected_id: i64,
) -> Result<AlbumDetail, ApiFailure> {
    let body = response.body;
    let album = body
        .get("album")
        .filter(|value| value.is_object())
        .ok_or_else(|| ApiFailure::unavailable("The album response contained no album"))?;
    let id = value_i64(album, "id")
        .filter(|id| *id == expected_id)
        .ok_or_else(|| ApiFailure::unavailable("The album response contained an invalid id"))?;
    let name = value_string(album, "name");
    let cover_url = normalized_image_url(album, &["picUrl", "coverUrl"]);
    let artist = album
        .get("artist")
        .filter(|value| value.is_object())
        .or_else(|| array(album, &["artists"]).first())
        .ok_or_else(|| ApiFailure::unavailable("The album response contained no artist"))?;
    let artist_id = value_i64(artist, "id")
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            ApiFailure::unavailable("The album response contained an invalid artist id")
        })?;
    let artist_name = value_string(artist, "name");
    if name.is_empty() || cover_url.is_empty() || artist_name.is_empty() {
        return Err(ApiFailure::unavailable(
            "The album response omitted required metadata",
        ));
    }

    let raw_tracks = array(&body, &["songs"]);
    if raw_tracks.len() > MAX_ALBUM_TRACKS {
        return Err(ApiFailure::unavailable(
            "The album response exceeded the supported track count",
        ));
    }
    let privileges = privilege_map(&body);
    let mut seen = std::collections::HashSet::new();
    let mut discs = BTreeMap::<String, Vec<CatalogItem>>::new();
    for track in raw_tracks {
        let Some(track_id) = value_i64(track, "id").filter(|id| *id > 0) else {
            continue;
        };
        if !seen.insert(track_id) {
            return Err(ApiFailure::unavailable(
                "The album response contained duplicate tracks",
            ));
        }
        let Some(mapped) = parse_track_with_privilege(track, privileges.get(&track_id).copied())
        else {
            continue;
        };
        let disc = match value_string(track, "cd") {
            value if value.is_empty() => "1".to_string(),
            value => value,
        };
        discs.entry(disc).or_default().push(mapped);
    }
    if !raw_tracks.is_empty() && discs.values().all(Vec::is_empty) {
        return Err(ApiFailure::unavailable(
            "The album response contained no valid tracks",
        ));
    }
    let duration_ms = discs
        .values()
        .flatten()
        .filter_map(|track| match track {
            CatalogItem::Track { duration_ms, .. } => Some(*duration_ms),
            _ => None,
        })
        .sum();
    let mapped_track_count = discs.values().map(Vec::len).sum::<usize>() as u64;

    Ok(AlbumDetail {
        id,
        name,
        cover_url,
        artist: AlbumArtist {
            id: artist_id,
            name: artist_name,
        },
        publish_time: value_u64(album, "publishTime"),
        track_count: value_u64(album, "size").max(mapped_track_count),
        duration_ms,
        description: value_string(album, "description"),
        company: value_string(album, "company"),
        album_type: value_string(album, "type"),
        explicit: value_u64(album, "mark") & 1_048_576 == 1_048_576,
        subscribed: false,
        discs: discs
            .into_iter()
            .map(|(disc, tracks)| AlbumDisc { disc, tracks })
            .collect(),
        more_albums: Vec::new(),
    })
}

fn parse_related_albums(response: ApiResponse, current_id: i64) -> Vec<CatalogItem> {
    enum Group {
        Album,
        Ep,
        Other,
    }

    let mut albums = Vec::new();
    let mut eps = Vec::new();
    let mut others = Vec::new();
    for value in array(&response.body, &["hotAlbums"]) {
        if value_i64(value, "id") == Some(current_id) {
            continue;
        }
        let Some(item) = parse_album_card(value) else {
            continue;
        };
        let album_type = value_string(value, "type");
        let group = if album_type == "专辑" {
            Group::Album
        } else if album_type == "EP" || (album_type == "EP/Single" && value_u64(value, "size") > 1)
        {
            Group::Ep
        } else {
            Group::Other
        };
        match group {
            Group::Album => albums.push(item),
            Group::Ep => eps.push(item),
            Group::Other => others.push(item),
        }
    }

    let mut selected = Vec::new();
    if albums.is_empty() {
        selected.append(&mut eps);
    } else {
        selected.append(&mut albums);
    }
    selected.append(&mut others);
    selected.truncate(5);
    selected
}

async fn load_album_detail(
    client: ApiClient,
    album_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<AlbumDetail, ApiFailure> {
    let album_query = with_request_context(
        Query::new().param("id", &album_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .album(&album_query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let mut detail = parse_album_detail_response(response, album_id)?;

    let dynamic_query = with_request_context(
        Query::new().param("id", &album_id.to_string()),
        &cookie,
        &real_ip,
    );
    let related_query = with_request_context(
        Query::new()
            .param("id", &detail.artist.id.to_string())
            .param("limit", "100")
            .param("offset", "0"),
        &cookie,
        &real_ip,
    );
    let (dynamic, related) = tokio::join!(
        client.album_detail_dynamic(&dynamic_query),
        client.artist_album(&related_query)
    );
    if let Ok(response) = dynamic {
        detail.subscribed = response
            .body
            .get("isSub")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    if let Ok(response) = related {
        detail.more_albums = parse_related_albums(response, album_id);
    }
    Ok(detail)
}

#[tauri::command]
pub async fn album_detail(
    request_id: String,
    album_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<AlbumDetail, ApiFailure> {
    if album_id <= 0 {
        return Err(ApiFailure::invalid("albumId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_album_detail(client, album_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn set_album_subscription(
    request_id: String,
    album_id: i64,
    subscribed: bool,
    state: State<'_, MusicApiState>,
) -> Result<AlbumSubscription, ApiFailure> {
    if album_id <= 0 {
        return Err(ApiFailure::invalid("albumId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    if cookie.is_none() {
        return Err(ApiFailure::auth_required(
            "A NetEase account is required to save albums",
        ));
    }
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("id", &album_id.to_string())
                    .param("t", if subscribed { "1" } else { "0" }),
                &cookie,
                &real_ip,
            );
            client
                .album_sub(&query)
                .await
                .map_err(ApiFailure::from_ncm)?;
            Ok(AlbumSubscription { subscribed })
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::{json, Value};

    use super::{load_album_detail, parse_album_detail_response, parse_related_albums};

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    #[test]
    fn maps_album_metadata_disc_tracks_and_privileges() {
        let detail = parse_album_detail_response(
            response(json!({
                "album": {
                    "id": 10,
                    "name": "Album",
                    "picUrl": "http://img.test/album.jpg",
                    "artist": { "id": 20, "name": "Artist" },
                    "publishTime": 1_700_000_000_000_u64,
                    "size": 2,
                    "description": "Description",
                    "company": "Label",
                    "type": "专辑",
                    "mark": 1_048_576
                },
                "songs": [
                    {
                        "id": 1, "name": "First", "dt": 1_000, "cd": "1", "mark": 1_048_576,
                        "ar": [{ "id": 20, "name": "Artist" }],
                        "al": { "id": 10, "name": "Album", "picUrl": "https://img.test/a.jpg" }
                    },
                    {
                        "id": 2, "name": "Second", "dt": 2_000, "cd": "2",
                        "ar": [{ "id": 20, "name": "Artist" }],
                        "al": { "id": 10, "name": "Album", "picUrl": "https://img.test/a.jpg" }
                    }
                ],
                "privileges": [
                    { "id": 1, "pl": 320000, "fee": 0, "st": 0 },
                    { "id": 2, "pl": 0, "fee": 1, "st": 0 }
                ]
            })),
            10,
        )
        .expect("album detail");

        assert_eq!(detail.cover_url, "https://img.test/album.jpg");
        assert_eq!(detail.duration_ms, 3_000);
        assert!(detail.explicit);
        assert_eq!(detail.discs.len(), 2);
        assert_eq!(detail.track_count, 2);
        let serialized = serde_json::to_value(detail).expect("serialize album detail");
        assert_eq!(serialized["discs"][0]["tracks"][0]["explicit"], true);
        assert_eq!(serialized["discs"][1]["tracks"][0]["playable"], false);
    }

    #[test]
    fn keeps_legacy_related_album_priority_and_limit() {
        let related = parse_related_albums(
            response(json!({
                "hotAlbums": [
                    { "id": 10, "name": "Current", "picUrl": "https://img.test/0.jpg", "type": "专辑", "artist": { "id": 20, "name": "Artist" } },
                    { "id": 11, "name": "Album 1", "picUrl": "https://img.test/1.jpg", "type": "专辑", "artist": { "id": 20, "name": "Artist" } },
                    { "id": 12, "name": "EP", "picUrl": "https://img.test/2.jpg", "type": "EP", "artist": { "id": 20, "name": "Artist" } },
                    { "id": 13, "name": "Single", "picUrl": "https://img.test/3.jpg", "type": "Single", "artist": { "id": 20, "name": "Artist" } },
                    { "id": 14, "name": "Album 2", "picUrl": "https://img.test/4.jpg", "type": "专辑", "artist": { "id": 20, "name": "Artist" } }
                ]
            })),
            10,
        );
        let serialized = serde_json::to_value(related).expect("serialize related albums");
        assert_eq!(serialized[0]["id"], 11);
        assert_eq!(serialized[1]["id"], 14);
        assert_eq!(serialized[2]["id"], 13);
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_album_detail_contract() {
        let detail = load_album_detail(create_client(None), 18905, None, None)
            .await
            .expect("album detail");
        assert_eq!(detail.id, 18905);
        assert!(!detail.discs.is_empty());
        assert!(detail.track_count > 0);
        assert!(detail.duration_ms > 0);
    }
}
