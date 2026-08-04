use std::collections::BTreeMap;

use ncm_api_rs::{ApiClient, ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::music_api::{with_request_context, ApiFailure, MusicApiState};

const MAX_LYRIC_BYTES: usize = 512 * 1024;
const MAX_LYRIC_LINES: usize = 1_000;
const MAX_LINE_CHARS: usize = 4_096;
const MAX_WORDS_PER_LINE: usize = 512;
const MAX_WORD_CHARS: usize = 1_024;

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    time_ms: u64,
    original: String,
    translation: Option<String>,
    romanization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    words: Option<Vec<LyricWord>>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyrics {
    lines: Vec<LyricLine>,
    instrumental: bool,
}

fn lyric_text<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key)
        .and_then(|value| value.get("lyric"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn fraction_ms(value: &str) -> Option<u64> {
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
        Some(value) => fraction_ms(value)?,
        None => 0,
    };
    minutes
        .checked_mul(60_000)?
        .checked_add(seconds.checked_mul(1_000)?)?
        .checked_add(milliseconds)
}

fn parse_lrc(raw: &str) -> Result<BTreeMap<u64, String>, ApiFailure> {
    if raw.len() > MAX_LYRIC_BYTES {
        return Err(ApiFailure::unavailable("The lyric response is too large"));
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

/// Parses the optional YRC karaoke payload returned by NetEase. YRC stores a
/// line header (`[start,duration]`) followed by word records such as
/// `(start,duration,voice)text`. Providers have returned both line-relative
/// and absolute word starts over time, so starts below the line timestamp are
/// interpreted as relative while larger values are retained as absolute.
fn parse_yrc(raw: &str) -> Result<BTreeMap<u64, Vec<LyricWord>>, ApiFailure> {
    if raw.is_empty() {
        return Ok(BTreeMap::new());
    }
    if raw.len() > MAX_LYRIC_BYTES {
        return Err(ApiFailure::unavailable("The lyric response is too large"));
    }
    let mut parsed = BTreeMap::new();
    for line in raw.lines() {
        let Some(header) = line.strip_prefix('[') else {
            continue;
        };
        let Some(header_end) = header.find(']') else {
            continue;
        };
        let Some((start_text, _duration_text)) = header[..header_end].split_once(',') else {
            continue;
        };
        let Ok(line_start) = start_text.parse::<u64>() else {
            continue;
        };
        let mut remainder = &header[header_end + 1..];
        let mut words = Vec::new();
        while let Some(open) = remainder.find('(') {
            let token = &remainder[open + 1..];
            let Some(close) = token.find(')') else { break };
            let metadata = &token[..close];
            let mut fields = metadata.split(',');
            let Some(start_text) = fields.next() else {
                break;
            };
            let Some(duration_text) = fields.next() else {
                break;
            };
            let Ok(raw_start) = start_text.parse::<u64>() else {
                break;
            };
            let Ok(duration) = duration_text.parse::<u64>() else {
                break;
            };
            let after_metadata = &token[close + 1..];
            let next_open = after_metadata.find('(');
            let (text, next_remainder) = match next_open {
                Some(index) => (&after_metadata[..index], &after_metadata[index..]),
                None => (after_metadata, ""),
            };
            let text = text.trim_end_matches('\r');
            if !text.is_empty() && text.chars().count() <= MAX_WORD_CHARS {
                let start_ms = if raw_start < line_start {
                    line_start.saturating_add(raw_start)
                } else {
                    raw_start
                };
                let end_ms = start_ms.saturating_add(duration.max(1));
                if end_ms > start_ms {
                    words.push(LyricWord {
                        start_ms,
                        end_ms,
                        text: text.to_string(),
                    });
                }
            }
            if words.len() >= MAX_WORDS_PER_LINE {
                break;
            }
            remainder = next_remainder;
            if remainder.is_empty() {
                break;
            }
        }
        if !words.is_empty() {
            parsed.insert(line_start, words);
        }
        if parsed.len() >= MAX_LYRIC_LINES {
            break;
        }
    }
    Ok(parsed)
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

fn parse_lyrics_response(response: ApiResponse) -> Result<TrackLyrics, ApiFailure> {
    let body = response.body;
    let original = parse_lrc(lyric_text(&body, "lrc"))?;
    let translation = parse_lrc(lyric_text(&body, "tlyric"))?;
    let romanization = parse_lrc(lyric_text(&body, "romalrc"))?;
    let word_timing = parse_yrc(lyric_text(&body, "yrc"))?;
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
            .map(|(time_ms, original)| LyricLine {
                time_ms,
                translation: translation
                    .get(&time_ms)
                    .cloned()
                    .filter(|line| !line.is_empty()),
                romanization: romanization
                    .get(&time_ms)
                    .cloned()
                    .filter(|line| !line.is_empty()),
                words: word_timing.get(&time_ms).cloned(),
                original,
            })
            .collect()
    };
    Ok(TrackLyrics {
        lines,
        instrumental,
    })
}

async fn load_track_lyrics(
    client: ApiClient,
    track_id: i64,
    cookie: Option<String>,
    real_ip: Option<String>,
) -> Result<TrackLyrics, ApiFailure> {
    let query = with_request_context(
        Query::new().param("id", &track_id.to_string()),
        &cookie,
        &real_ip,
    );
    let response = client.lyric(&query).await.map_err(ApiFailure::from_ncm)?;
    parse_lyrics_response(response)
}

#[tauri::command]
pub async fn track_lyrics(
    request_id: String,
    track_id: i64,
    state: State<'_, MusicApiState>,
) -> Result<TrackLyrics, ApiFailure> {
    if track_id <= 0 {
        return Err(ApiFailure::invalid("trackId must be a positive integer"));
    }
    let (client, cookie, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            load_track_lyrics(client, track_id, cookie, real_ip).await
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse};
    use serde_json::json;

    use super::{load_track_lyrics, parse_lrc, parse_lyrics_response, parse_yrc};

    #[test]
    fn parses_multiple_timestamps_and_millisecond_precisions() {
        let parsed =
            parse_lrc("[00:01.2][00:02.34]Line A\n[01:03:456]Line B\n[ar:Metadata]Ignored")
                .expect("parse lrc");
        assert_eq!(parsed.get(&1_200).map(String::as_str), Some("Line A"));
        assert_eq!(parsed.get(&2_340).map(String::as_str), Some("Line A"));
        assert_eq!(parsed.get(&63_456).map(String::as_str), Some("Line B"));
        assert_eq!(parsed.len(), 3);
    }

    #[test]
    fn merges_translation_and_romanization_by_canonical_time() {
        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "lrc": { "lyric": "[00:01.20]Original\n[00:02.00]作词：无\n[00:03]Second" },
                "tlyric": { "lyric": "[00:01.2]Translation" },
                "romalrc": { "lyric": "[00:01.200]Romanization" }
            }),
        })
        .expect("parse lyrics");

        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.lines[0].time_ms, 1_200);
        assert_eq!(lyrics.lines[0].translation.as_deref(), Some("Translation"));
        assert_eq!(
            lyrics.lines[0].romanization.as_deref(),
            Some("Romanization")
        );
        assert_eq!(lyrics.lines[1].original, "Second");
    }

    #[test]
    fn parses_optional_yrc_word_timing_and_merges_it_into_the_line() {
        let parsed = parse_yrc("[1000,2000](0,500,0)Hel(500,700,0)lo").expect("parse yrc");
        let words = parsed.get(&1_000).expect("words");
        assert_eq!(words[0].start_ms, 1_000);
        assert_eq!(words[0].end_ms, 1_500);
        assert_eq!(words[0].text, "Hel");
        assert_eq!(words[1].start_ms, 1_500);

        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "lrc": { "lyric": "[00:01]Hello" },
                "yrc": { "lyric": "[1000,2000](0,500,0)Hel(500,700,0)lo" }
            }),
        })
        .expect("parse lyrics");
        assert_eq!(lyrics.lines[0].words.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn maps_the_legacy_pure_music_marker_to_an_instrumental_state() {
        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({ "lrc": { "lyric": "[00:00]作曲：Artist\n[00:01]纯音乐，请欣赏" } }),
        })
        .expect("parse instrumental");
        assert!(lyrics.instrumental);
        assert!(lyrics.lines.is_empty());
    }

    #[test]
    fn does_not_hide_real_lines_beside_a_pure_music_marker() {
        let lyrics = parse_lyrics_response(ApiResponse {
            status: 200,
            cookie: vec![],
            body: json!({
                "lrc": { "lyric": "[00:00]纯音乐，请欣赏\n[00:10]An actual lyric" }
            }),
        })
        .expect("parse mixed lyrics");

        assert!(!lyrics.instrumental);
        assert_eq!(lyrics.lines.len(), 2);
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_lyrics_contract() {
        let lyrics = load_track_lyrics(create_client(None), 186016, None, None)
            .await
            .expect("lyrics");
        assert!(!lyrics.lines.is_empty() || lyrics.instrumental);
    }
}
