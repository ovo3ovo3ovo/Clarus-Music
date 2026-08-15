use std::collections::{HashMap, HashSet};

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    catalog::{
        array, parse_track_with_privilege, performance_fixture_track, value_i64, CatalogItem,
    },
    music_api::{with_request_context, ApiFailure, MusicApiState},
    performance::PerformanceState,
};

const MAX_DAILY_SONGS: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySongs {
    tracks: Vec<CatalogItem>,
}

fn privilege_map<'a>(data: &'a Value, body: &'a Value) -> HashMap<i64, &'a Value> {
    let privileges = array(data, &["privileges"]);
    let privileges = if privileges.is_empty() {
        array(body, &["privileges"])
    } else {
        privileges
    };
    privileges
        .iter()
        .filter_map(|privilege| value_i64(privilege, "id").map(|id| (id, privilege)))
        .collect()
}

fn parse_daily_songs_response(response: ApiResponse) -> Result<DailySongs, ApiFailure> {
    let body = response.body;
    let data = body
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(&body);
    let raw_tracks = array(data, &["dailySongs", "songs"]);
    let privileges = privilege_map(data, &body);
    let mut seen = HashSet::new();
    let tracks = raw_tracks
        .iter()
        .filter_map(|track| {
            let id = value_i64(track, "id")?;
            if id <= 0 || !seen.insert(id) {
                return None;
            }
            parse_track_with_privilege(track, privileges.get(&id).copied())
        })
        .take(MAX_DAILY_SONGS)
        .collect::<Vec<_>>();

    if !raw_tracks.is_empty() && tracks.is_empty() {
        return Err(ApiFailure::unavailable(
            "The daily recommendation contained no valid songs",
        ));
    }
    Ok(DailySongs { tracks })
}

async fn load_daily_songs(
    client: ApiClient,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<DailySongs, ApiFailure> {
    let cookie = cookie.ok_or_else(|| {
        ApiFailure::auth_required("Daily song recommendations require an authenticated account")
    })?;
    let query = with_request_context(Query::new(), &Some(cookie), &real_ip);
    let response = client
        .recommend_songs(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    parse_daily_songs_response(response)
}

fn performance_daily_songs(performance_state: &PerformanceState) -> DailySongs {
    DailySongs {
        tracks: (0_i64..24)
            .map(|index| {
                performance_fixture_track(
                    999_000 + index,
                    900_000,
                    performance_state
                        .image_fixture_url(&format!("/clarus-perf/daily/{index}.png"))
                        .unwrap_or_else(|| {
                            format!("https://p1.music.126.net/clarus-perf/daily/{index}.png")
                        }),
                )
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn daily_songs(
    request_id: String,
    state: State<'_, MusicApiState>,
    performance_state: State<'_, PerformanceState>,
) -> Result<DailySongs, ApiFailure> {
    if performance_state.artist_fixtures_enabled() {
        return Ok(performance_daily_songs(&performance_state));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_daily_songs(client, cookie, real_ip).await
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::json;

    use super::{load_daily_songs, parse_daily_songs_response};

    fn track(id: i64) -> serde_json::Value {
        json!({
            "id": id,
            "name": format!("Track {id}"),
            "dt": 180000,
            "ar": [{ "id": id + 1000, "name": "Artist" }],
            "al": { "id": id + 2000, "name": "Album", "picUrl": "https://img.test/a.jpg" }
        })
    }

    #[test]
    fn maps_daily_songs_with_separate_privileges_and_deduplication() {
        let response = ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "data": {
                    "dailySongs": [
                        {
                            "id": 10,
                            "name": "Playable",
                            "dt": 180000,
                            "ar": [{ "id": 20, "name": "Artist" }],
                            "al": { "id": 30, "name": "Album", "picUrl": "http://img.test/a.jpg" }
                        },
                        {
                            "id": 11,
                            "name": "Unavailable",
                            "dt": 190000,
                            "ar": [{ "id": 21, "name": "Artist 2" }],
                            "al": { "id": 31, "name": "Album 2", "picUrl": "https://img.test/b.jpg" }
                        },
                        { "id": 10, "name": "Duplicate" }
                    ],
                    "privileges": [
                        { "id": 10, "pl": 320000, "fee": 0, "st": 0 },
                        { "id": 11, "pl": 0, "fee": 1, "st": 0 }
                    ]
                }
            }),
        };

        let daily = parse_daily_songs_response(response).expect("daily songs");
        assert_eq!(daily.tracks.len(), 2);
        let serialized = serde_json::to_value(daily).expect("serialize daily songs");
        assert_eq!(serialized["tracks"][0]["id"], 10);
        assert_eq!(serialized["tracks"][0]["playable"], true);
        assert_eq!(serialized["tracks"][1]["playable"], false);
        assert_eq!(serialized["tracks"][1]["unavailableReason"], "VIP Only");
    }

    #[test]
    fn caps_after_discarding_invalid_rows() {
        let mut songs = vec![json!({ "id": 0 })];
        songs.extend((1..=100).map(track));
        let response = ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({ "data": { "dailySongs": songs } }),
        };

        let daily = parse_daily_songs_response(response).expect("daily songs");
        assert_eq!(daily.tracks.len(), 100);
        let serialized = serde_json::to_value(daily).expect("serialize daily songs");
        assert_eq!(serialized["tracks"][99]["id"], 100);
    }

    #[tokio::test]
    async fn rejects_daily_songs_without_a_session_before_network_access() {
        let error = load_daily_songs(create_client(None), None, None)
            .await
            .expect_err("authentication should be required");
        assert_eq!(
            error.into_message(),
            "Daily song recommendations require an authenticated account"
        );
    }
}
