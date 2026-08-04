use std::collections::HashSet;

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{
    catalog::{array, normalized_image_url, value_i64, value_string, value_u64},
    music_api::{with_request_context, ApiFailure, MusicApiState},
};

const SUPPORTED_RESOLUTIONS: [u16; 4] = [1080, 720, 480, 240];
const MAX_SIMILAR_VIDEOS: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MusicVideoSource {
    resolution: u16,
    url: String,
    mime_type: &'static str,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimilarMusicVideo {
    id: i64,
    name: String,
    cover_url: String,
    artist_id: i64,
    artist_name: String,
    duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicVideoDetail {
    id: i64,
    name: String,
    cover_url: String,
    artist_id: i64,
    artist_name: String,
    play_count: u64,
    publish_time: String,
    duration_ms: u64,
    subscribed: bool,
    sources: Vec<MusicVideoSource>,
    similar_videos: Vec<SimilarMusicVideo>,
}

struct MusicVideoCore {
    detail: MusicVideoDetail,
    resolutions: HashSet<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicVideoSubscription {
    subscribed: bool,
}

fn data_object(body: &Value) -> Option<&Value> {
    body.get("data").filter(|value| value.is_object())
}

fn normalized_http_url(value: &Value, key: &str) -> Option<String> {
    let url = value_string(value, key).replacen("http://", "https://", 1);
    (url.starts_with("https://") || url.starts_with("http://")).then_some(url)
}

fn primary_artist(value: &Value) -> Option<(i64, String)> {
    let direct_id = value_i64(value, "artistId");
    let direct_name = value_string(value, "artistName");
    if direct_id.is_some_and(|id| id > 0) && !direct_name.is_empty() {
        return direct_id.map(|id| (id, direct_name));
    }
    array(value, &["artists"]).iter().find_map(|artist| {
        let id = value_i64(artist, "id")?;
        let name = value_string(artist, "name");
        (id > 0 && !name.is_empty()).then_some((id, name))
    })
}

fn parse_music_video_core(
    response: ApiResponse,
    expected_id: i64,
) -> Result<MusicVideoCore, ApiFailure> {
    let subscribed = response
        .body
        .get("subed")
        .and_then(Value::as_bool)
        .or_else(|| {
            response
                .body
                .get("data")
                .and_then(|data| data.get("subed"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    let value = data_object(&response.body)
        .ok_or_else(|| ApiFailure::unavailable("The MV response contained no detail data"))?;
    let id = value_i64(value, "id")
        .filter(|id| *id == expected_id)
        .ok_or_else(|| ApiFailure::unavailable("The MV response returned a different id"))?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["cover", "coverUrl"]);
    let (artist_id, artist_name) = primary_artist(value)
        .ok_or_else(|| ApiFailure::unavailable("The MV response omitted its primary artist"))?;
    let publish_time = value_string(value, "publishTime");
    if name.is_empty() || cover_url.is_empty() || publish_time.is_empty() {
        return Err(ApiFailure::unavailable(
            "The MV response omitted required display metadata",
        ));
    }

    let quality_value = value
        .get("brs")
        .ok_or_else(|| ApiFailure::unavailable("The MV response contained no quality list"))?;
    let resolutions = match quality_value {
        Value::Array(brs) => {
            if brs.len() > 8 {
                return Err(ApiFailure::unavailable(
                    "The MV response exceeded the supported quality count",
                ));
            }
            brs.iter()
                .filter_map(|quality| value_u64(quality, "br").try_into().ok())
                .filter(|resolution: &u16| SUPPORTED_RESOLUTIONS.contains(resolution))
                .collect::<HashSet<_>>()
        }
        Value::Object(brs) => {
            if brs.len() > 8 {
                return Err(ApiFailure::unavailable(
                    "The MV response exceeded the supported quality count",
                ));
            }
            SUPPORTED_RESOLUTIONS
                .into_iter()
                .filter(|resolution| brs.contains_key(&resolution.to_string()))
                .collect::<HashSet<_>>()
        }
        _ => HashSet::new(),
    };
    if resolutions.is_empty() {
        return Err(ApiFailure::unavailable(
            "The MV response contained no supported quality",
        ));
    }

    Ok(MusicVideoCore {
        detail: MusicVideoDetail {
            id,
            name,
            cover_url,
            artist_id,
            artist_name,
            play_count: value_u64(value, "playCount"),
            publish_time,
            duration_ms: value_u64(value, "duration"),
            subscribed,
            sources: Vec::new(),
            similar_videos: Vec::new(),
        },
        resolutions,
    })
}

fn parse_music_video_source(
    response: ApiResponse,
    expected_id: i64,
    expected_resolution: u16,
) -> Result<MusicVideoSource, ApiFailure> {
    let value = data_object(&response.body)
        .ok_or_else(|| ApiFailure::unavailable("The MV URL response contained no data"))?;
    if value_i64(value, "id") != Some(expected_id)
        || value_u64(value, "r") != u64::from(expected_resolution)
    {
        return Err(ApiFailure::unavailable(
            "The MV URL response did not match its request",
        ));
    }
    let url = normalized_http_url(value, "url")
        .ok_or_else(|| ApiFailure::unavailable("The MV URL response contained no HTTP URL"))?;
    Ok(MusicVideoSource {
        resolution: expected_resolution,
        url,
        mime_type: "video/mp4",
        size_bytes: value_u64(value, "size"),
    })
}

fn parse_similar_video(value: &Value, current_id: i64) -> Option<SimilarMusicVideo> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let cover_url = normalized_image_url(value, &["cover", "coverUrl"]);
    let (artist_id, artist_name) = primary_artist(value)?;
    (id > 0 && id != current_id && !name.is_empty() && !cover_url.is_empty()).then_some(
        SimilarMusicVideo {
            id,
            name,
            cover_url,
            artist_id,
            artist_name,
            duration_ms: value_u64(value, "duration"),
        },
    )
}

fn parse_similar_videos(response: ApiResponse, current_id: i64) -> Vec<SimilarMusicVideo> {
    let mut seen = HashSet::new();
    array(&response.body, &["mvs"])
        .iter()
        .filter_map(|video| parse_similar_video(video, current_id))
        .filter(|video| seen.insert(video.id))
        .take(MAX_SIMILAR_VIDEOS)
        .collect()
}

async fn load_source(
    client: &ApiClient,
    query: Query,
    enabled: bool,
    video_id: i64,
    resolution: u16,
) -> Option<Result<MusicVideoSource, ApiFailure>> {
    if !enabled {
        return None;
    }
    Some(
        client
            .mv_url(&query)
            .await
            .map_err(ApiFailure::from_ncm)
            .and_then(|response| parse_music_video_source(response, video_id, resolution)),
    )
}

async fn load_music_video_detail(
    client: ApiClient,
    video_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<MusicVideoDetail, ApiFailure> {
    let detail_query = with_request_context(
        Query::new().param("mvid", &video_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client
        .mv_detail(&detail_query)
        .await
        .map_err(ApiFailure::from_ncm)?;
    let core = parse_music_video_core(response, video_id)?;

    let source_query = |resolution: u16| {
        with_request_context(
            Query::new()
                .param("id", &video_id.to_string())
                .param("r", &resolution.to_string()),
            &cookie,
            &real_ip,
        )
    };
    let similar_query = with_request_context(
        Query::new().param("mvid", &video_id.to_string()),
        &cookie,
        &real_ip,
    );
    let (source_1080, source_720, source_480, source_240, similar) = tokio::join!(
        load_source(
            &client,
            source_query(1080),
            core.resolutions.contains(&1080),
            video_id,
            1080,
        ),
        load_source(
            &client,
            source_query(720),
            core.resolutions.contains(&720),
            video_id,
            720,
        ),
        load_source(
            &client,
            source_query(480),
            core.resolutions.contains(&480),
            video_id,
            480,
        ),
        load_source(
            &client,
            source_query(240),
            core.resolutions.contains(&240),
            video_id,
            240,
        ),
        client.simi_mv(&similar_query),
    );
    let mut sources = [source_1080, source_720, source_480, source_240]
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    sources.sort_unstable_by_key(|source| std::cmp::Reverse(source.resolution));
    if sources.is_empty() {
        return Err(ApiFailure::unavailable(
            "The MV response contained no playable source",
        ));
    }

    let mut detail = core.detail;
    detail.sources = sources;
    if let Ok(response) = similar {
        detail.similar_videos = parse_similar_videos(response, video_id);
    }
    Ok(detail)
}

#[tauri::command]
pub async fn music_video_detail(
    request_id: String,
    video_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<MusicVideoDetail, ApiFailure> {
    if video_id <= 0 {
        return Err(ApiFailure::invalid("videoId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_music_video_detail(client, video_id, cookie, real_ip).await
        })
        .await
}

#[tauri::command]
pub async fn set_music_video_subscription(
    request_id: String,
    video_id: i64,
    subscribed: bool,
    state: State<'_, MusicApiState>,
) -> Result<MusicVideoSubscription, ApiFailure> {
    if video_id <= 0 {
        return Err(ApiFailure::invalid("videoId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    if cookie.is_none() {
        return Err(ApiFailure::auth_required(
            "A NetEase account is required to save MVs",
        ));
    }
    state
        .run_cancellable(request_id, async move {
            let query = with_request_context(
                Query::new()
                    .param("mvid", &video_id.to_string())
                    .param("t", if subscribed { "1" } else { "0" }),
                &cookie,
                &real_ip,
            );
            client.mv_sub(&query).await.map_err(ApiFailure::from_ncm)?;
            Ok(MusicVideoSubscription { subscribed })
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::{json, Value};

    use super::{
        load_music_video_detail, parse_music_video_core, parse_music_video_source,
        parse_similar_videos,
    };

    fn response(body: Value) -> ApiResponse {
        ApiResponse {
            status: 200,
            body,
            cookie: Vec::new(),
        }
    }

    #[test]
    fn maps_detail_and_only_the_legacy_quality_set() {
        let core = parse_music_video_core(
            response(json!({
                "data": {
                    "id": 10,
                    "name": "MV",
                    "cover": "http://img.test/mv.jpg",
                    "artistId": 20,
                    "artistName": "Artist",
                    "playCount": 30,
                    "publishTime": "2026-01-01",
                    "duration": 40,
                    "brs": { "1080": 1, "720": 1, "360": 1 }
                },
                "subed": true
            })),
            10,
        )
        .expect("MV detail");

        assert_eq!(core.detail.cover_url, "https://img.test/mv.jpg");
        assert!(core.detail.subscribed);
        assert_eq!(core.resolutions.len(), 2);
        assert!(!core.resolutions.contains(&360));
    }

    #[test]
    fn validates_source_request_ownership() {
        let source = parse_music_video_source(
            response(json!({
                "data": {
                    "id": 10,
                    "r": 720,
                    "url": "http://video.test/mv.mp4",
                    "size": 100
                }
            })),
            10,
            720,
        )
        .expect("MV source");
        assert_eq!(source.url, "https://video.test/mv.mp4");
        assert!(parse_music_video_source(
            response(json!({ "data": { "id": 11, "r": 720, "url": "https://video.test/mv.mp4" } })),
            10,
            720,
        )
        .is_err());
    }

    #[test]
    fn bounds_and_deduplicates_similar_videos() {
        let videos = parse_similar_videos(
            response(json!({
                "mvs": [
                    { "id": 10, "name": "Current", "cover": "https://img.test/10.jpg", "artistId": 20, "artistName": "Artist" },
                    { "id": 11, "name": "Similar", "cover": "https://img.test/11.jpg", "artistId": 20, "artistName": "Artist", "duration": 10 },
                    { "id": 11, "name": "Duplicate", "cover": "https://img.test/11b.jpg", "artistId": 20, "artistName": "Artist" }
                ]
            })),
            10,
        );
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].id, 11);
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_music_video_contract() {
        let client = create_client(None);
        let detail = load_music_video_detail(client, 10896407, None, None)
            .await
            .expect("MV detail");
        assert_eq!(detail.id, 10896407);
        assert!(!detail.sources.is_empty());
        assert!(detail
            .sources
            .windows(2)
            .all(|pair| pair[0].resolution > pair[1].resolution));
    }
}
