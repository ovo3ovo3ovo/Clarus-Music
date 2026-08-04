use ncm_api_rs::{ApiClient, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::music_api::{with_request_context, ApiFailure, MusicApiState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongLikeState {
    liked: bool,
}

fn value_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn response_like_state(body: &Value, track_id: i64) -> Option<bool> {
    // `/song/like/check` returns `{ data: [{ id, liked }] }`. The previous
    // implementation read a legacy `ids` shape instead, which made every
    // currently-playing liked song look unliked in the desktop player.
    body.get("data")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries.iter().find_map(|entry| {
                let id = entry.get("id").and_then(value_id)?;
                (id == track_id).then(|| entry.get("liked").and_then(Value::as_bool))?
            })
        })
        .or_else(|| body.get("liked").and_then(Value::as_bool))
        .or_else(|| {
            // Keep the old response shape as a compatibility fallback for
            // proxy servers that still expose it.
            body.get("ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(value_id).any(|id| id == track_id))
        })
}

async fn load_song_like_state(
    client: ApiClient,
    track_id: i64,
    cookie: String,
    real_ip: Option<String>,
) -> Result<SongLikeState, ApiFailure> {
    let track_ids = format!("[{track_id}]");
    let query = with_request_context(
        Query::new().param("ids", &track_ids),
        &Some(cookie),
        &real_ip,
    );
    let response = client
        .song_like_check(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let liked = response_like_state(&response.body, track_id).ok_or_else(|| {
        ApiFailure::unavailable("The song like check response did not include the requested track")
    })?;
    Ok(SongLikeState { liked })
}

async fn load_set_song_like(
    client: ApiClient,
    track_id: i64,
    liked: bool,
    cookie: String,
    real_ip: Option<String>,
) -> Result<SongLikeState, ApiFailure> {
    let query = with_request_context(
        Query::new()
            .param("id", &track_id.to_string())
            .param("like", if liked { "true" } else { "false" }),
        &Some(cookie),
        &real_ip,
    );
    client
        .song_like(&query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    Ok(SongLikeState { liked })
}

#[tauri::command]
pub async fn check_song_like(
    request_id: String,
    track_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<SongLikeState, ApiFailure> {
    if track_id <= 0 {
        return Err(ApiFailure::invalid("trackId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = cookie.ok_or_else(|| {
        ApiFailure::auth_required("A NetEase account is required to check liked songs")
    })?;
    state
        .run_cancellable(request_id, async move {
            load_song_like_state(client, track_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn set_song_like(
    request_id: String,
    track_id: i64,
    liked: bool,
    state: State<'_, MusicApiState>,
) -> Result<SongLikeState, ApiFailure> {
    if track_id <= 0 {
        return Err(ApiFailure::invalid("trackId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    let cookie = cookie
        .ok_or_else(|| ApiFailure::auth_required("A NetEase account is required to like songs"))?;
    state
        .run_cancellable(request_id, async move {
            load_set_song_like(client, track_id, liked, cookie, real_ip).await
        })
        .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::response_like_state;

    #[test]
    fn reads_the_song_like_check_data_shape() {
        let body = json!({
            "data": [
                { "id": 1, "liked": false },
                { "id": "2", "liked": true }
            ]
        });

        assert_eq!(response_like_state(&body, 1), Some(false));
        assert_eq!(response_like_state(&body, 2), Some(true));
        assert_eq!(response_like_state(&body, 3), None);
    }

    #[test]
    fn keeps_legacy_ids_as_a_compatibility_fallback() {
        let body = json!({ "ids": [1, "2", "invalid"] });
        assert_eq!(response_like_state(&body, 2), Some(true));
        assert_eq!(response_like_state(&body, 3), Some(false));
    }
}
