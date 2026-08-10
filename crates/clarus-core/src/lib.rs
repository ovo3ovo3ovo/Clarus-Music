mod cache;
mod cancellation;
mod client;
mod error;
mod models;
mod parse;
mod queue;

pub use cache::{AudioCache, CachedAudio, DEFAULT_AUDIO_CACHE_LIMIT_BYTES};
pub use cancellation::RequestCancellation;
pub use client::MusicCore;
pub use error::CoreError;
pub use models::{
    Album, Artist, AuthSession, AuthUser, DailySongs, LyricLine, PlaylistDetail, PlaylistPage,
    PlaylistScope, PlaylistSummary, PlaylistTrackPage, QrLogin, QrLoginCheck, QrLoginStatus,
    StreamSource, Track, TrackLyrics,
};
pub use parse::{
    parse_lrc, DAILY_SONG_LIMIT, MAX_LINE_CHARS, MAX_LYRIC_BYTES, MAX_LYRIC_LINES,
    MAX_PLAYLIST_TRACKS, PLAYLIST_PAGE_SIZE, USER_PLAYLIST_PAGE_SIZE,
};
pub use queue::{PlaybackQueue, QueueSource};
