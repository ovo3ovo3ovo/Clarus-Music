use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artist {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Album {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub name: String,
    pub duration_ms: u64,
    pub artists: Vec<Artist>,
    pub album: Album,
    pub aliases: Vec<String>,
    pub translated_names: Vec<String>,
    pub explicit: bool,
    pub playable: bool,
    pub unavailable_reason: Option<String>,
}

impl Track {
    pub fn artist_text(&self) -> String {
        self.artists
            .iter()
            .map(|artist| artist.name.as_str())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
            .join(" / ")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistSummary {
    pub id: i64,
    pub name: String,
    /// NetEase calls this field `creator`; it is the playlist owner id.
    pub creator_id: i64,
    pub creator_name: String,
    pub track_count: u64,
    /// True only after the core has compared the owner with the authenticated
    /// account.  The UI must not reimplement ownership classification.
    pub owned: bool,
    /// NetEase's subscription flag.  This is the source of the saved-playlist
    /// classification for playlists not owned by the account.
    pub subscribed: bool,
    /// The account's default liked-songs playlist is returned alongside owned
    /// playlists by NetEase. It has its own top-level TUI entry and must not be
    /// duplicated under “创建的歌单”.
    pub liked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlaylistScope {
    Subscribed,
    Owned,
}

impl PlaylistSummary {
    pub fn belongs_to(&self, user_id: i64) -> bool {
        self.owned || self.creator_id == user_id
    }

    pub fn matches_scope(&self, scope: PlaylistScope, user_id: i64) -> bool {
        match scope {
            PlaylistScope::Owned => !self.liked && self.belongs_to(user_id),
            PlaylistScope::Subscribed => self.subscribed && !self.belongs_to(user_id),
        }
    }
}

#[cfg(test)]
mod playlist_tests {
    use super::{PlaylistScope, PlaylistSummary};

    fn summary(owned: bool, creator_id: i64, subscribed: bool, liked: bool) -> PlaylistSummary {
        PlaylistSummary {
            id: 1,
            name: "list".to_string(),
            creator_id,
            creator_name: "owner".to_string(),
            track_count: 1,
            owned,
            subscribed,
            liked,
        }
    }

    #[test]
    fn playlist_scopes_use_owner_and_subscription_metadata() {
        assert!(summary(true, 7, false, false).matches_scope(PlaylistScope::Owned, 7));
        assert!(!summary(true, 7, true, false).matches_scope(PlaylistScope::Subscribed, 7));
        assert!(summary(false, 9, true, false).matches_scope(PlaylistScope::Subscribed, 7));
        assert!(!summary(false, 9, false, false).matches_scope(PlaylistScope::Subscribed, 7));
        assert!(!summary(true, 7, false, true).matches_scope(PlaylistScope::Owned, 7));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistPage {
    pub items: Vec<PlaylistSummary>,
    pub next_offset: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistDetail {
    pub id: i64,
    pub name: String,
    pub creator_id: i64,
    pub creator_name: String,
    pub update_time: u64,
    pub track_count: u64,
    pub description: String,
    pub private: bool,
    /// Set by the core after the authenticated owner is known.
    pub owned: bool,
    pub subscribed: bool,
    pub track_ids: Vec<i64>,
    pub tracks: Vec<Track>,
    pub next_offset: u64,
    pub has_more: bool,
}

impl PlaylistDetail {
    pub fn creator_user_id(&self) -> i64 {
        self.creator_id
    }

    pub fn belongs_to(&self, user_id: i64) -> bool {
        self.owned || self.creator_id == user_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailySongs {
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistTrackPage {
    pub tracks: Vec<Track>,
    pub requested_count: u64,
}

/// A short-lived key and the URL encoded into the terminal QR code.
///
/// The key is deliberately separate from the URL so the core can poll the
/// service without making the presentation layer parse an external URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrLogin {
    pub key: String,
    pub login_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QrLoginStatus {
    Waiting,
    Scanned,
    Authorized,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrLoginCheck {
    pub status: QrLoginStatus,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthUser {
    pub user_id: i64,
    pub nickname: String,
    pub vip_type: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthSession {
    pub authenticated: bool,
    pub user: Option<AuthUser>,
}

/// Result of a successful SMS login. The session is always kept in memory;
/// `saved_to_keychain` tells the UI whether it will also survive the next
/// launch without exposing the authenticated cookie.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmsLogin {
    pub user: AuthUser,
    pub saved_to_keychain: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LyricLine {
    pub time_ms: u64,
    pub original: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackLyrics {
    pub lines: Vec<LyricLine>,
    pub instrumental: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamSource {
    pub url: String,
    pub mime_type: String,
    pub bitrate: u64,
    pub size_bytes: u64,
    pub duration_ms: u64,
    pub level: String,
}
