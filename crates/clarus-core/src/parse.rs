use std::collections::{BTreeMap, HashMap, HashSet};

use ncm_api_rs::ApiResponse;
use serde_json::Value;
use url::Url;

use crate::{
    error::CoreError,
    models::{
        Album, Artist, AuthUser, DailySongs, LyricLine, PlaylistDetail, PlaylistPage,
        PlaylistSummary, PlaylistTrackPage, QrLoginStatus, StreamSource, Track, TrackLyrics,
    },
};

pub const DAILY_SONG_LIMIT: usize = 100;
pub const PLAYLIST_PAGE_SIZE: usize = 100;
pub const USER_PLAYLIST_PAGE_SIZE: usize = 50;
pub const MAX_PLAYLIST_TRACKS: usize = 100_000;
pub const MAX_LYRIC_BYTES: usize = 512 * 1024;
pub const MAX_LYRIC_LINES: usize = 1_000;
pub const MAX_LINE_CHARS: usize = 4_096;

pub fn value_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|candidate| {
        candidate
            .as_i64()
            .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
    })
}

pub fn value_u64(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|candidate| {
            candidate
                .as_u64()
                .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or_default()
}

pub fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn array<'a>(value: &'a Value, keys: &[&str]) -> &'a [Value] {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_array).map(Vec::as_slice))
        .unwrap_or_default()
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| value.get(key).filter(|candidate| candidate.is_object()))
}

fn parse_artist(value: &Value) -> Option<Artist> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    (id > 0 && !name.is_empty()).then_some(Artist { id, name })
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

pub fn parse_track_with_privilege(value: &Value, privilege: Option<&Value>) -> Option<Track> {
    let id = value_i64(value, "id")?;
    let name = value_string(value, "name");
    let album_value = object(value, &["al", "album"])?;
    if id <= 0 || name.is_empty() {
        return None;
    }
    let artists = array(value, &["ar", "artists"])
        .iter()
        .filter_map(parse_artist)
        .collect();
    let album = Album {
        id: value_i64(album_value, "id").unwrap_or_default(),
        name: value_string(album_value, "name"),
    };
    let aliases = track_names(value, &["alia", "alias"], &name);
    let translated_names = track_names(value, &["tns"], &name);
    let (playable, unavailable_reason) = track_availability(value, privilege);
    Some(Track {
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

fn privilege_map<'a>(body: &'a Value, data: &'a Value) -> HashMap<i64, &'a Value> {
    let values = if array(data, &["privileges"]).is_empty() {
        array(body, &["privileges"])
    } else {
        array(data, &["privileges"])
    };
    values
        .iter()
        .filter_map(|privilege| value_i64(privilege, "id").map(|id| (id, privilege)))
        .collect()
}

fn parse_tracks_in_order(body: &Value, raw_tracks: &[Value], expected_ids: &[i64]) -> Vec<Track> {
    let privileges = privilege_map(body, body);
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

pub fn parse_daily_songs_response(response: ApiResponse) -> Result<DailySongs, CoreError> {
    let body = response.body;
    let data = body
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(&body);
    let raw_tracks = array(data, &["dailySongs", "songs"]);
    let privileges = privilege_map(&body, data);
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
        .take(DAILY_SONG_LIMIT)
        .collect::<Vec<_>>();
    if !raw_tracks.is_empty() && tracks.is_empty() {
        return Err(CoreError::Unavailable(
            "The daily recommendation contained no valid songs".to_string(),
        ));
    }
    Ok(DailySongs { tracks })
}

pub fn parse_playlist_page_response(
    response: ApiResponse,
    offset: u64,
) -> Result<PlaylistPage, CoreError> {
    let raw_items = array(&response.body, &["playlist"]);
    if raw_items.len() > USER_PLAYLIST_PAGE_SIZE {
        return Err(CoreError::Unavailable(
            "The playlist response exceeded the requested page size".to_string(),
        ));
    }
    let mut seen = HashSet::new();
    let items = raw_items
        .iter()
        .filter_map(|value| {
            let id = value_i64(value, "id")?;
            let name = value_string(value, "name");
            let creator = value.get("creator")?.as_object()?;
            let creator_id = creator.get("userId").and_then(|candidate| {
                candidate
                    .as_i64()
                    .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
            })?;
            if id <= 0 || name.is_empty() || creator_id <= 0 || !seen.insert(id) {
                return None;
            }
            Some(PlaylistSummary {
                id,
                name,
                creator_id,
                creator_name: creator
                    .get("nickname")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                track_count: value_u64(value, "trackCount"),
                owned: false,
                subscribed: value
                    .get("subscribed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                liked: value_i64(value, "specialType") == Some(5),
            })
        })
        .collect::<Vec<_>>();
    if !raw_items.is_empty() && items.is_empty() {
        return Err(CoreError::Unavailable(
            "The playlist response contained no valid playlists".to_string(),
        ));
    }
    let returned = raw_items.len() as u64;
    Ok(PlaylistPage {
        items,
        next_offset: offset.saturating_add(returned),
        has_more: returned > 0
            && response
                .body
                .get("more")
                .or_else(|| response.body.get("hasMore"))
                .and_then(Value::as_bool)
                .unwrap_or(raw_items.len() == USER_PLAYLIST_PAGE_SIZE),
    })
}

pub fn parse_playlist_detail_response(
    response: ApiResponse,
    expected_id: i64,
) -> Result<PlaylistDetail, CoreError> {
    let body = response.body;
    let playlist = body
        .get("playlist")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            CoreError::Unavailable("The playlist response contained no playlist".into())
        })?;
    let id = value_i64(playlist, "id")
        .filter(|id| *id == expected_id)
        .ok_or_else(|| {
            CoreError::Unavailable("The playlist response contained an invalid id".into())
        })?;
    let name = value_string(playlist, "name");
    if name.is_empty() {
        return Err(CoreError::Unavailable(
            "The playlist response omitted a name".to_string(),
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
    let has_more = next_offset < track_ids.len() as u64;
    Ok(PlaylistDetail {
        id,
        name,
        creator_id: creator
            .map(|value| value_i64(value, "userId").unwrap_or_default())
            .unwrap_or_default(),
        creator_name: creator
            .map(|value| value_string(value, "nickname"))
            .unwrap_or_default(),
        update_time: value_u64(playlist, "updateTime"),
        track_count: value_u64(playlist, "trackCount").max(track_ids.len() as u64),
        description: value_string(playlist, "description"),
        private: value_i64(playlist, "privacy") == Some(10),
        owned: false,
        subscribed: playlist
            .get("subscribed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        track_ids,
        tracks,
        has_more,
        next_offset,
    })
}

pub fn parse_playlist_track_page_response(
    response: ApiResponse,
    expected_ids: &[i64],
) -> PlaylistTrackPage {
    let body = response.body;
    let tracks = parse_tracks_in_order(&body, array(&body, &["songs"]), expected_ids);
    PlaylistTrackPage {
        tracks,
        requested_count: expected_ids.len() as u64,
    }
}

pub fn parse_liked_playlist_id(
    response: ApiResponse,
    expected_user_id: i64,
) -> Result<i64, CoreError> {
    let playlist = array(&response.body, &["playlist"])
        .first()
        .filter(|value| value.is_object())
        .ok_or_else(|| CoreError::Unavailable("The account has no liked-songs playlist".into()))?;
    let playlist_id = value_i64(playlist, "id")
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            CoreError::Unavailable("The liked-songs playlist has an invalid id".into())
        })?;
    let creator_id = playlist
        .get("creator")
        .and_then(|creator| value_i64(creator, "userId"));
    if creator_id != Some(expected_user_id) {
        return Err(CoreError::Unavailable(
            "The liked-songs playlist did not belong to the authenticated account".into(),
        ));
    }
    Ok(playlist_id)
}

pub fn parse_auth_user(body: &Value) -> Option<AuthUser> {
    let data = body.get("data").unwrap_or(body);
    let profile = data.get("profile").or_else(|| body.get("profile"))?;
    let user_id = value_i64(profile, "userId")?;
    let nickname = value_string(profile, "nickname");
    (user_id > 0 && !nickname.is_empty()).then_some(AuthUser {
        user_id,
        nickname,
        vip_type: value_i64(profile, "vipType").unwrap_or_default(),
    })
}

pub fn response_code(body: &Value) -> i64 {
    body.get("code")
        .and_then(|code| {
            code.as_i64()
                .or_else(|| code.as_str().and_then(|value| value.parse().ok()))
        })
        .unwrap_or_default()
}

pub fn response_message(body: &Value, fallback: &str) -> String {
    body.get("message")
        .or_else(|| body.get("msg"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub fn qr_login_key(body: &Value) -> Option<&str> {
    body.get("data")
        .and_then(|data| data.get("unikey"))
        .or_else(|| body.get("unikey"))
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
}

pub fn qr_status(code: i64) -> (QrLoginStatus, &'static str) {
    match code {
        800 => (QrLoginStatus::Expired, "QR code expired"),
        802 => (
            QrLoginStatus::Scanned,
            "QR code scanned; confirm login on your device",
        ),
        803 => (QrLoginStatus::Authorized, "Login authorized"),
        _ => (QrLoginStatus::Waiting, "Waiting for QR code scan"),
    }
}

pub fn authenticated_cookie(response: &ApiResponse) -> Result<String, CoreError> {
    let mut cookies = BTreeMap::new();
    if let Some(cookie) = response.body.get("cookie").and_then(Value::as_str) {
        insert_cookie_pairs(&mut cookies, cookie);
    }
    for cookie in &response.cookie {
        insert_cookie_pairs(&mut cookies, cookie);
    }
    if !cookies.contains_key("MUSIC_U") {
        return Err(CoreError::SecureStorage(
            "The login response did not contain an authenticated session".to_string(),
        ));
    }
    Ok(cookies
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

fn insert_cookie_pairs(cookies: &mut BTreeMap<String, String>, source: &str) {
    const ATTRIBUTES: &[&str] = &[
        "domain",
        "expires",
        "httponly",
        "max-age",
        "partitioned",
        "path",
        "samesite",
        "secure",
    ];
    for segment in source.replace(";;", ";").split(';') {
        let Some((name, value)) = segment.trim().split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty()
            || name.len() > 128
            || ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        }
        let value = value.trim();
        if value.len() <= 8192 {
            cookies.insert(name.to_string(), value.to_string());
        }
    }
}

pub fn parse_lyrics_response(response: ApiResponse) -> Result<TrackLyrics, CoreError> {
    let body = response.body;
    let original = parse_lrc(lyric_text(&body, "lrc"))?;
    let pure_music = original.len() <= 10
        && original.values().any(|line| line == "纯音乐，请欣赏")
        && original
            .values()
            .all(|line| line == "纯音乐，请欣赏" || is_credit(line));
    let instrumental = body
        .get("nolyric")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || pure_music;
    let lines = if instrumental {
        Vec::new()
    } else {
        original
            .into_iter()
            .filter(|(_, content)| !is_empty_credit(content))
            .take(MAX_LYRIC_LINES)
            .map(|(time_ms, original)| LyricLine { time_ms, original })
            .collect()
    };
    Ok(TrackLyrics {
        lines,
        instrumental,
    })
}

fn lyric_text<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key)
        .and_then(|value| value.get("lyric"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

pub fn parse_lrc(raw: &str) -> Result<BTreeMap<u64, String>, CoreError> {
    if raw.len() > MAX_LYRIC_BYTES {
        return Err(CoreError::Unavailable(
            "The lyric response is too large".to_string(),
        ));
    }
    let mut parsed = BTreeMap::new();
    for line in raw.lines() {
        let mut remainder = line.trim();
        let mut timestamps = Vec::new();
        while let Some(rest) = remainder.strip_prefix('[') {
            let Some(end) = rest.find(']') else { break };
            if let Some(time_ms) = timestamp_ms(&rest[..end]) {
                timestamps.push(time_ms);
            }
            remainder = &rest[end + 1..];
        }
        let content = remainder.trim();
        if content.is_empty() || content.chars().count() > MAX_LINE_CHARS {
            continue;
        }
        for time_ms in timestamps {
            parsed.entry(time_ms).or_insert_with(|| content.to_string());
            if parsed.len() >= MAX_LYRIC_LINES {
                return Ok(parsed);
            }
        }
    }
    Ok(parsed)
}

fn timestamp_ms(tag: &str) -> Option<u64> {
    let (minutes, remainder) = tag.split_once(':')?;
    if minutes.is_empty() || !minutes.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let split = remainder.find(['.', ':']);
    let (seconds, fraction) = match split {
        Some(index) => (&remainder[..index], Some(&remainder[index + 1..])),
        None => (remainder, None),
    };
    if seconds.is_empty() || !seconds.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<u64>().ok()?;
    if seconds >= 60 {
        return None;
    }
    let milliseconds = match fraction {
        Some(value) => parse_fraction_ms(value)?,
        None => 0,
    };
    minutes
        .checked_mul(60_000)?
        .checked_add(seconds.checked_mul(1_000)?)?
        .checked_add(milliseconds)
}

fn parse_fraction_ms(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let normalized = match value.len() {
        1 => format!("{value}00"),
        2 => format!("{value}0"),
        _ => value[..3].to_string(),
    };
    normalized.parse().ok()
}

fn is_empty_credit(content: &str) -> bool {
    let normalized = content.replace('：', ":").replace(' ', "");
    matches!(
        normalized.as_str(),
        "作词:无" | "作詞:無" | "作曲:无" | "作曲:無"
    )
}

fn is_credit(content: &str) -> bool {
    let normalized = content.trim_start().replace('：', ":");
    ["作词:", "作詞:", "作曲:"]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
}

pub fn parse_stream_source(response: ApiResponse) -> Result<StreamSource, CoreError> {
    let source = response
        .body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| {
            CoreError::Unavailable("The playback response contained no source".into())
        })?;
    let url = value_string(source, "url");
    let parsed = Url::parse(&url)
        .map_err(|_| CoreError::Unavailable("The playback source URL was invalid".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
        return Err(CoreError::Unavailable(
            "No playable HTTP audio source is available for this track".into(),
        ));
    }
    let mime_type = match value_string(source, "type").to_ascii_lowercase().as_str() {
        "flac" => "audio/flac",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" => "audio/ogg",
        _ => "audio/mpeg",
    };
    Ok(StreamSource {
        url,
        mime_type: mime_type.to_string(),
        bitrate: value_u64(source, "br"),
        size_bytes: value_u64(source, "size"),
        duration_ms: value_u64(source, "time"),
        level: value_string(source, "level"),
    })
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::ApiResponse;
    use serde_json::json;

    use super::{
        parse_daily_songs_response, parse_lrc, parse_lyrics_response,
        parse_playlist_detail_response, parse_playlist_page_response,
    };

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
    fn parses_lrc_with_multiple_timestamp_precisions() {
        let parsed = parse_lrc("[00:01.2][00:02.34]Line A\n[01:03:456]Line B").unwrap();
        assert_eq!(parsed.get(&1_200).map(String::as_str), Some("Line A"));
        assert_eq!(parsed.get(&2_340).map(String::as_str), Some("Line A"));
        assert_eq!(parsed.get(&63_456).map(String::as_str), Some("Line B"));
    }

    #[test]
    fn parses_daily_tracks_and_rejects_duplicates() {
        let response = ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "data": {
                    "dailySongs": [track(10), track(10)],
                    "privileges": [{ "id": 10, "pl": 320000, "fee": 0, "st": 0 }]
                }
            }),
        };
        let daily = parse_daily_songs_response(response).unwrap();
        assert_eq!(daily.tracks.len(), 1);
        assert_eq!(daily.tracks[0].id, 10);
    }

    #[test]
    fn instrumental_lyrics_are_empty() {
        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({ "lrc": { "lyric": "[00:00.00]纯音乐，请欣赏" } }),
        })
        .unwrap();
        assert!(lyrics.instrumental);
        assert!(lyrics.lines.is_empty());
    }

    #[test]
    fn playlist_page_preserves_service_offset_and_subscription_metadata() {
        let response = ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "playlist": [{
                    "id": 42,
                    "name": "Saved list",
                    "trackCount": 17,
                    "subscribed": true,
                    "specialType": 5,
                    "creator": { "userId": 7, "nickname": "owner" }
                }],
                "more": true
            }),
        };
        let page = parse_playlist_page_response(response, 50).unwrap();
        assert_eq!(page.next_offset, 51);
        assert!(page.has_more);
        assert_eq!(page.items[0].id, 42);
        assert!(page.items[0].subscribed);
        assert!(page.items[0].liked);
        assert!(!page.items[0].owned);
    }

    #[test]
    fn playlist_detail_keeps_requested_track_order_and_page_boundary() {
        let response = ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "playlist": {
                    "id": 99,
                    "name": "Ordered list",
                    "trackCount": 3,
                    "trackIds": [{ "id": 3 }, { "id": 1 }, { "id": 2 }],
                    "tracks": [track(1), track(3)],
                    "creator": { "userId": 7, "nickname": "owner" }
                }
            }),
        };
        let detail = parse_playlist_detail_response(response, 99).unwrap();
        assert_eq!(
            detail.tracks.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![3, 1]
        );
        assert_eq!(detail.next_offset, 2);
        assert!(detail.has_more);
    }

    #[test]
    fn lyrics_filter_credits_but_keeps_audio_timestamps() {
        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "lrc": { "lyric": "[00:00.50]作词：无\n[00:01.00]第一句\n[00:01.50]第二句" }
            }),
        })
        .unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| (line.time_ms, line.original.as_str()))
                .collect::<Vec<_>>(),
            vec![(1_000, "第一句"), (1_500, "第二句")]
        );
    }
}
