use tauri::command;
use tokio::process::Command;

use crate::music_api::ApiFailure;

enum NeteaseResource {
    Song,
    Album,
    Artist,
    MusicVideo,
}

impl NeteaseResource {
    fn url(self, id: i64) -> Result<String, ApiFailure> {
        if id <= 0 {
            return Err(ApiFailure::invalid("resourceId must be a positive integer"));
        }
        let path = match self {
            Self::Song => format!("song?id={id}"),
            Self::Album => format!("#/album?id={id}"),
            Self::Artist => format!("#/artist?id={id}"),
            Self::MusicVideo => format!("#/mv?id={id}"),
        };
        Ok(format!("https://music.163.com/{path}"))
    }
}

async fn open_system_url(url: String) -> Result<(), ApiFailure> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg("--")
            .arg(url)
            .status()
            .await
            .map_err(|error| {
                ApiFailure::unavailable(format!("Failed to open the system browser: {error}"))
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(ApiFailure::unavailable(format!(
                "The system browser command exited with {status}"
            )))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err(ApiFailure::unavailable(
            "Opening external links is supported only on macOS",
        ))
    }
}

#[command]
pub async fn open_netease_song(song_id: i64) -> Result<(), ApiFailure> {
    open_system_url(NeteaseResource::Song.url(song_id)?).await
}

#[command]
pub async fn open_netease_album(album_id: i64) -> Result<(), ApiFailure> {
    open_system_url(NeteaseResource::Album.url(album_id)?).await
}

#[command]
pub async fn open_netease_artist(artist_id: i64) -> Result<(), ApiFailure> {
    open_system_url(NeteaseResource::Artist.url(artist_id)?).await
}

#[command]
pub async fn open_netease_music_video(music_video_id: i64) -> Result<(), ApiFailure> {
    open_system_url(NeteaseResource::MusicVideo.url(music_video_id)?).await
}

#[cfg(test)]
mod tests {
    use super::NeteaseResource;

    #[test]
    fn builds_only_positive_netease_links() {
        assert_eq!(
            NeteaseResource::Song.url(42).expect("valid song id"),
            "https://music.163.com/song?id=42"
        );
        assert_eq!(
            NeteaseResource::Album.url(42).expect("valid album id"),
            "https://music.163.com/#/album?id=42"
        );
        assert_eq!(
            NeteaseResource::Artist.url(42).expect("valid artist id"),
            "https://music.163.com/#/artist?id=42"
        );
        assert_eq!(
            NeteaseResource::MusicVideo
                .url(42)
                .expect("valid music video id"),
            "https://music.163.com/#/mv?id=42"
        );
        assert!(NeteaseResource::Song.url(0).is_err());
        assert!(NeteaseResource::Song.url(-1).is_err());
    }
}
