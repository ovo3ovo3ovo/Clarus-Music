use std::{
    fs::{File, OpenOptions},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use fs2::FileExt;
use keyring::{Entry, Error as KeyringError};
use ncm_api_rs::{create_client, ApiClient, Query};
use tokio::sync::RwLock;
use url::Url;
use zeroize::Zeroizing;

use crate::{
    cache::{AudioCache, CachedAudio},
    cancellation::{cancelable, RequestCancellation},
    error::CoreError,
    models::{
        AuthSession, DailySongs, PlaylistDetail, PlaylistPage, PlaylistScope, PlaylistTrackPage,
        QrLogin, QrLoginCheck, QrLoginStatus, StreamSource, TrackLyrics,
    },
    parse,
};

const KEYRING_SERVICE: &str = "com.ovo3ovo3ovo.clarusmusic";
const KEYRING_ACCOUNT: &str = "netease-session";
const MAX_OFFSET: u64 = 100_000;
const MAX_FILTERED_PAGE_PROBES: usize = 8;
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const KEYCHAIN_LOCK_FILE: &str = "clarus-music-keychain-access.lock";

// A keyring operation can raise a macOS permission sheet.  It cannot be
// safely cancelled once it reaches the platform API, so timing out the Rust
// waiter merely detaches a live prompt.  Repeating that pattern produced a
// stack of password sheets.  Keep two levels of admission control instead:
// one in this process and one advisory lock shared by every Clarus process.
// A failed automatic restore is deliberately attempted once per process; the
// listener can immediately use QR login instead of creating another prompt.
static KEYCHAIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static KEYCHAIN_RESTORE_ATTEMPTED: AtomicBool = AtomicBool::new(false);
static KEYCHAIN_SAVE_ATTEMPTED: AtomicBool = AtomicBool::new(false);
static KEYCHAIN_DELETE_ATTEMPTED: AtomicBool = AtomicBool::new(false);

struct KeychainOperationGuard {
    lock_file: File,
}

impl Drop for KeychainOperationGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock_file);
        KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn begin_keychain_operation() -> Result<KeychainOperationGuard, CoreError> {
    if KEYCHAIN_IN_FLIGHT
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return Err(keychain_busy_error());
    }

    let lock_path = std::env::temp_dir().join(KEYCHAIN_LOCK_FILE);
    let lock_file = match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
    {
        Ok(file) => file,
        Err(error) => {
            KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release);
            return Err(CoreError::SecureStorage(format!(
                "Unable to coordinate system Keychain access: {error}"
            )));
        }
    };

    match lock_file.try_lock_exclusive() {
        Ok(()) => Ok(KeychainOperationGuard { lock_file }),
        Err(_) => {
            KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release);
            Err(keychain_busy_error())
        }
    }
}

fn keychain_busy_error() -> CoreError {
    CoreError::SecureStorage(
        "Another Clarus process is already waiting for a Keychain decision; use QR login in this window"
            .to_string(),
    )
}

fn reserve_keychain_attempt(attempted: &AtomicBool, action: &str) -> Result<(), CoreError> {
    attempted
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ())
        .map_err(|_| {
            CoreError::SecureStorage(format!(
                "System Keychain {action} was already attempted in this run; use QR login or restart after resolving the system prompt"
            ))
        })
}

#[derive(Clone)]
pub struct MusicCore {
    client: ApiClient,
    session_cookie: Arc<RwLock<Option<Zeroizing<String>>>>,
    session_user_id: Arc<RwLock<Option<i64>>>,
    /// Optional API origin override used by deterministic integration tests
    /// and local development proxies. Production construction leaves this
    /// unset, so `ncm-api-rs` keeps using the service's normal origins.
    api_domain: Option<String>,
    real_ip: Option<String>,
    audio_cache: AudioCache,
}

impl Default for MusicCore {
    fn default() -> Self {
        Self::new()
    }
}

impl MusicCore {
    pub fn new() -> Self {
        Self::with_config(None, None)
    }

    /// Creates a core that sends API requests to `api_domain`.
    ///
    /// This is intentionally an explicit constructor instead of an ambient
    /// environment variable: a production TUI should never silently redirect
    /// account cookies to an unexpected host. It is useful for a local API
    /// proxy and for the in-process HTTP fixture used by the core's end-to-end
    /// tests.
    pub fn with_api_domain(api_domain: impl Into<String>) -> Result<Self, CoreError> {
        let domain = api_domain.into().trim_end_matches('/').to_string();
        let parsed = Url::parse(&domain).map_err(|error| {
            CoreError::Invalid(format!("API domain is not a valid URL: {error}"))
        })?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(CoreError::Invalid(
                "API domain must use http(s) and include a host".to_string(),
            ));
        }
        Ok(Self::with_config(Some(domain), None))
    }

    fn with_config(api_domain: Option<String>, audio_cache: Option<AudioCache>) -> Self {
        Self {
            client: create_client(None),
            session_cookie: Arc::new(RwLock::new(None)),
            session_user_id: Arc::new(RwLock::new(None)),
            api_domain,
            real_ip: None,
            audio_cache: audio_cache.unwrap_or_default(),
        }
    }

    pub async fn restore_session(&self) -> Result<AuthSession, CoreError> {
        self.restore_session_cancellable(&RequestCancellation::new())
            .await
    }

    pub async fn restore_session_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<AuthSession, CoreError> {
        // A just-authorized QR login already has a validated cookie in the
        // core. Re-reading Keychain immediately adds an avoidable platform
        // round trip and can turn a usable in-memory login into a failure if
        // the credential UI is temporarily unavailable.
        let cookie = match self.session_cookie().await {
            Some(cookie) => Some(cookie),
            None => cancelable(cancellation, load_credential()).await?,
        };
        let Some(cookie) = cookie else {
            *self.session_cookie.write().await = None;
            *self.session_user_id.write().await = None;
            return Ok(AuthSession {
                authenticated: false,
                user: None,
            });
        };
        let response = api_request(
            cancellation,
            self.client
                .login_status(&self.request_query(Query::new(), &Some(cookie.clone()))),
        )
        .await?;
        let user = parse::parse_auth_user(&response.body);
        if let Some(user) = user.clone() {
            *self.session_cookie.write().await = Some(Zeroizing::new(cookie));
            *self.session_user_id.write().await = Some(user.user_id);
            Ok(AuthSession {
                authenticated: true,
                user: Some(user),
            })
        } else {
            *self.session_cookie.write().await = None;
            *self.session_user_id.write().await = None;
            // Do not turn an expired cookie into a second Keychain prompt at
            // startup. A later successful QR login overwrites it, and the
            // explicit logout path remains responsible for removal.
            Ok(AuthSession {
                authenticated: false,
                user: None,
            })
        }
    }

    pub async fn begin_qr_login(&self) -> Result<QrLogin, CoreError> {
        self.begin_qr_login_cancellable(&RequestCancellation::new())
            .await
    }

    pub async fn begin_qr_login_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<QrLogin, CoreError> {
        let response = api_request(
            cancellation,
            self.client
                .login_qr_key(&self.request_query(Query::new(), &None)),
        )
        .await?;
        let key = parse::qr_login_key(&response.body)
            .ok_or_else(|| CoreError::Unavailable("The QR login key was missing".into()))?
            .to_string();
        Ok(QrLogin {
            login_url: format!("https://music.163.com/login?codekey={key}"),
            key,
        })
    }

    pub async fn check_qr_login(&self, key: &str) -> Result<QrLoginCheck, CoreError> {
        self.check_qr_login_cancellable(key, &RequestCancellation::new())
            .await
    }

    pub async fn check_qr_login_cancellable(
        &self,
        key: &str,
        cancellation: &RequestCancellation,
    ) -> Result<QrLoginCheck, CoreError> {
        if key.is_empty() || key.len() > 512 {
            return Err(CoreError::Invalid(
                "The QR login key must contain between 1 and 512 bytes".into(),
            ));
        }
        let response = api_request(
            cancellation,
            self.client
                .login_qr_check(&self.request_query(Query::new().param("key", key), &None)),
        )
        .await?;
        let (status, fallback) = parse::qr_status(parse::response_code(&response.body));
        let mut message = parse::response_message(&response.body, fallback);
        if status == QrLoginStatus::Authorized {
            let cookie = parse::authenticated_cookie(&response)?;
            if cancellation.is_cancelled() {
                return Err(CoreError::Cancelled);
            }
            // Keep the current process usable even if Keychain cannot save
            // right now. The UI reports that persistence was unavailable, but
            // a successful server-side QR authorization must not strand the
            // listener at the login screen.
            *self.session_cookie.write().await = Some(Zeroizing::new(cookie.clone()));
            match cancelable(cancellation, save_credential(&cookie)).await {
                Ok(()) => {}
                Err(CoreError::Cancelled) => {
                    *self.session_cookie.write().await = None;
                    *self.session_user_id.write().await = None;
                    return Err(CoreError::Cancelled);
                }
                Err(CoreError::SecureStorage(_)) => {
                    message.push_str("；系统 Keychain 不可用，本次登录态仅在当前运行内有效");
                }
                Err(error) => {
                    // Do not leave an authorized cookie behind if the caller
                    // cancelled or an unexpected persistence error occurred.
                    *self.session_cookie.write().await = None;
                    *self.session_user_id.write().await = None;
                    return Err(error);
                }
            }
        }
        Ok(QrLoginCheck { status, message })
    }

    pub async fn logout(&self) -> Result<bool, CoreError> {
        self.logout_cancellable(&RequestCancellation::new()).await
    }

    pub async fn logout_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<bool, CoreError> {
        let cookie = self.session_cookie().await;
        let remote_logout_succeeded = match cookie.as_ref() {
            Some(cookie) => api_request(
                cancellation,
                self.client
                    .logout(&self.request_query(Query::new(), &Some(cookie.clone()))),
            )
            .await
            .is_ok(),
            None => true,
        };
        *self.session_cookie.write().await = None;
        *self.session_user_id.write().await = None;
        cancelable(cancellation, delete_credential()).await?;
        Ok(remote_logout_succeeded)
    }

    pub async fn daily_songs(&self) -> Result<DailySongs, CoreError> {
        self.daily_songs_cancellable(&RequestCancellation::new())
            .await
    }

    pub async fn daily_songs_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<DailySongs, CoreError> {
        let cookie = self
            .require_cookie("Daily song recommendations require an authenticated account")
            .await?;
        let response = api_request(
            cancellation,
            self.client
                .recommend_songs(&self.request_query(Query::new(), &Some(cookie))),
        )
        .await?;
        parse::parse_daily_songs_response(response)
    }

    pub async fn playlist_page(
        &self,
        user_id: i64,
        offset: u64,
    ) -> Result<PlaylistPage, CoreError> {
        self.playlist_page_cancellable(user_id, offset, &RequestCancellation::new())
            .await
    }

    pub async fn playlist_page_cancellable(
        &self,
        user_id: i64,
        offset: u64,
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistPage, CoreError> {
        if user_id <= 0 {
            return Err(CoreError::Invalid("userId must be positive".into()));
        }
        validate_offset(offset)?;
        let cookie = self
            .require_cookie("A NetEase account is required to access playlists")
            .await?;
        let query = Query::new()
            .param("uid", &user_id.to_string())
            .param("limit", &parse::USER_PLAYLIST_PAGE_SIZE.to_string())
            .param("offset", &offset.to_string());
        let mut page = parse::parse_playlist_page_response(
            api_request(
                cancellation,
                self.client
                    .user_playlist(&self.request_query(query, &Some(cookie))),
            )
            .await?,
            offset,
        )?;
        for item in &mut page.items {
            item.owned = item.creator_id == user_id;
        }
        Ok(page)
    }

    /// Returns one raw service page filtered by the TUI's two playlist scopes.
    /// The raw offset/`has_more` metadata is intentionally retained so a page
    /// containing only the other scope still advances correctly.
    pub async fn playlist_page_for(
        &self,
        user_id: i64,
        scope: PlaylistScope,
        offset: u64,
    ) -> Result<PlaylistPage, CoreError> {
        self.playlist_page_for_cancellable(user_id, scope, offset, &RequestCancellation::new())
            .await
    }

    pub async fn playlist_page_for_cancellable(
        &self,
        user_id: i64,
        scope: PlaylistScope,
        offset: u64,
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistPage, CoreError> {
        let mut cursor = offset;
        let mut probes = 0;
        loop {
            let page = self
                .playlist_page_cancellable(user_id, cursor, cancellation)
                .await?;
            let items = page
                .items
                .into_iter()
                .filter(|item| item.matches_scope(scope, user_id))
                .collect::<Vec<_>>();
            if !items.is_empty()
                || !page.has_more
                || page.next_offset <= cursor
                || probes >= MAX_FILTERED_PAGE_PROBES
            {
                return Ok(PlaylistPage { items, ..page });
            }
            cursor = page.next_offset;
            probes += 1;
        }
    }

    pub async fn liked_songs(&self, user_id: i64) -> Result<PlaylistDetail, CoreError> {
        self.liked_songs_cancellable(user_id, &RequestCancellation::new())
            .await
    }

    pub async fn liked_songs_cancellable(
        &self,
        user_id: i64,
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistDetail, CoreError> {
        if user_id <= 0 {
            return Err(CoreError::Invalid("userId must be positive".into()));
        }
        let cookie = self
            .require_cookie("A NetEase account is required to load liked songs")
            .await?;
        let query = Query::new()
            .param("uid", &user_id.to_string())
            .param("limit", "1")
            .param("offset", "0");
        let response = api_request(
            cancellation,
            self.client
                .user_playlist(&self.request_query(query, &Some(cookie.clone()))),
        )
        .await?;
        let playlist_id = parse::parse_liked_playlist_id(response, user_id)?;
        let detail = self
            .playlist_detail_with_cookie(playlist_id, Some(cookie), cancellation)
            .await?;
        if !detail.belongs_to(user_id) {
            return Err(CoreError::Unavailable(
                "The liked-songs playlist owner changed between requests".into(),
            ));
        }
        Ok(PlaylistDetail {
            owned: true,
            ..detail
        })
    }

    pub async fn playlist_detail(&self, playlist_id: i64) -> Result<PlaylistDetail, CoreError> {
        self.playlist_detail_cancellable(playlist_id, &RequestCancellation::new())
            .await
    }

    pub async fn playlist_detail_cancellable(
        &self,
        playlist_id: i64,
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistDetail, CoreError> {
        self.playlist_detail_with_cookie(
            playlist_id,
            Some(
                self.require_cookie("A NetEase account is required to access playlists")
                    .await?,
            ),
            cancellation,
        )
        .await
    }

    pub async fn playlist_track_page(
        &self,
        track_ids: &[i64],
    ) -> Result<PlaylistTrackPage, CoreError> {
        self.playlist_track_page_cancellable(track_ids, &RequestCancellation::new())
            .await
    }

    pub async fn playlist_track_page_cancellable(
        &self,
        track_ids: &[i64],
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistTrackPage, CoreError> {
        if track_ids.is_empty()
            || track_ids.len() > parse::PLAYLIST_PAGE_SIZE
            || track_ids.iter().any(|id| *id <= 0)
        {
            return Err(CoreError::Invalid(
                "trackIds must contain between 1 and 100 positive integers".into(),
            ));
        }
        let ids = track_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let cookie = self
            .require_cookie("A NetEase account is required to load playlist songs")
            .await?;
        let response = api_request(
            cancellation,
            self.client
                .song_detail(&self.request_query(Query::new().param("ids", &ids), &Some(cookie))),
        )
        .await?;
        Ok(parse::parse_playlist_track_page_response(
            response, track_ids,
        ))
    }

    pub async fn lyrics(&self, track_id: i64) -> Result<TrackLyrics, CoreError> {
        self.lyrics_cancellable(track_id, &RequestCancellation::new())
            .await
    }

    pub async fn lyrics_cancellable(
        &self,
        track_id: i64,
        cancellation: &RequestCancellation,
    ) -> Result<TrackLyrics, CoreError> {
        if track_id <= 0 {
            return Err(CoreError::Invalid("trackId must be positive".into()));
        }
        let response = api_request(
            cancellation,
            self.client.lyric(&self.request_query(
                Query::new().param("id", &track_id.to_string()),
                &self.session_cookie().await,
            )),
        )
        .await?;
        parse::parse_lyrics_response(response)
    }

    pub async fn resolve_stream_url(
        &self,
        track_id: i64,
        quality: &str,
    ) -> Result<StreamSource, CoreError> {
        self.resolve_stream_url_cancellable(track_id, quality, &RequestCancellation::new())
            .await
    }

    pub async fn resolve_stream_url_cancellable(
        &self,
        track_id: i64,
        quality: &str,
        cancellation: &RequestCancellation,
    ) -> Result<StreamSource, CoreError> {
        if track_id <= 0 {
            return Err(CoreError::Invalid("trackId must be positive".into()));
        }
        let level = quality_level(quality)
            .ok_or_else(|| CoreError::Invalid("music quality is unsupported".into()))?;
        let query = self.request_query(
            Query::new()
                .param("id", &track_id.to_string())
                .param("level", level),
            &self.session_cookie().await,
        );
        let response = api_request(cancellation, self.client.song_url_v1(&query)).await?;
        parse::parse_stream_source(response)
    }

    /// Downloads the current stream into the bounded disk cache. The caller can
    /// abort this future when the user skips a track; partially written files are
    /// never published as cache entries.
    pub async fn cache_stream(
        &self,
        track_id: i64,
        source: &StreamSource,
    ) -> Result<CachedAudio, CoreError> {
        self.cache_stream_cancellable(track_id, source, &RequestCancellation::new())
            .await
    }

    pub async fn cache_stream_cancellable(
        &self,
        track_id: i64,
        source: &StreamSource,
        cancellation: &RequestCancellation,
    ) -> Result<CachedAudio, CoreError> {
        self.audio_cache
            .fetch_cancellable(track_id, source, cancellation)
            .await
    }

    pub fn audio_cache(&self) -> &AudioCache {
        &self.audio_cache
    }

    async fn playlist_detail_with_cookie(
        &self,
        playlist_id: i64,
        cookie: Option<String>,
        cancellation: &RequestCancellation,
    ) -> Result<PlaylistDetail, CoreError> {
        if playlist_id <= 0 {
            return Err(CoreError::Invalid("playlistId must be positive".into()));
        }
        let response = api_request(
            cancellation,
            self.client.playlist_detail(
                &self.request_query(Query::new().param("id", &playlist_id.to_string()), &cookie),
            ),
        )
        .await?;
        let mut detail = parse::parse_playlist_detail_response(response, playlist_id)?;
        if let Some(user_id) = *self.session_user_id.read().await {
            detail.owned = detail.creator_id == user_id;
        }
        Ok(detail)
    }

    async fn require_cookie(&self, message: &'static str) -> Result<String, CoreError> {
        self.session_cookie()
            .await
            .ok_or_else(|| CoreError::AuthRequired(message.to_string()))
    }

    async fn session_cookie(&self) -> Option<String> {
        self.session_cookie
            .read()
            .await
            .as_ref()
            .map(|cookie| cookie.as_str().to_owned())
    }

    fn request_query(&self, mut query: Query, cookie: &Option<String>) -> Query {
        if let Some(cookie) = cookie {
            query = query.cookie(cookie);
        }
        query.real_ip = self.real_ip.clone();
        query.domain = self.api_domain.clone();
        query
    }
}

async fn api_request<T, F>(cancellation: &RequestCancellation, future: F) -> Result<T, CoreError>
where
    F: std::future::Future<Output = Result<T, ncm_api_rs::NcmError>>,
{
    api_request_with_timeout(cancellation, API_REQUEST_TIMEOUT, future).await
}

async fn api_request_with_timeout<T, F>(
    cancellation: &RequestCancellation,
    timeout: Duration,
    future: F,
) -> Result<T, CoreError>
where
    F: std::future::Future<Output = Result<T, ncm_api_rs::NcmError>>,
{
    cancelable(cancellation, async move {
        match tokio::time::timeout(timeout, future).await {
            Ok(result) => result.map_err(CoreError::from),
            Err(_) => Err(CoreError::Network(format!(
                "request timed out after {} seconds",
                timeout.as_secs_f32()
            ))),
        }
    })
    .await
}

fn quality_level(quality: &str) -> Option<&'static str> {
    match quality {
        "128000" => Some("standard"),
        "192000" => Some("higher"),
        "320000" => Some("exhigh"),
        "flac" => Some("lossless"),
        "999000" => Some("hires"),
        _ => None,
    }
}

fn validate_offset(offset: u64) -> Result<(), CoreError> {
    if offset > MAX_OFFSET {
        return Err(CoreError::Invalid(
            "offset must be between 0 and 100000".into(),
        ));
    }
    Ok(())
}

fn keyring_entry() -> Result<Entry, CoreError> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| {
        CoreError::SecureStorage(format!(
            "Failed to open the system credential store: {error}"
        ))
    })
}

async fn load_credential() -> Result<Option<String>, CoreError> {
    reserve_keychain_attempt(&KEYCHAIN_RESTORE_ATTEMPTED, "restore")?;
    let guard = begin_keychain_operation()?;
    let task = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        match keyring_entry()?.get_password() {
            Ok(cookie) => Ok(Some(cookie)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(CoreError::SecureStorage(format!(
                "Failed to read the saved session: {error}"
            ))),
        }
    });
    await_credential_task(task).await
}

async fn save_credential(cookie: &str) -> Result<(), CoreError> {
    reserve_keychain_attempt(&KEYCHAIN_SAVE_ATTEMPTED, "persistence")?;
    let guard = begin_keychain_operation()?;
    let cookie = cookie.to_string();
    let task = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        keyring_entry()?.set_password(&cookie).map_err(|error| {
            CoreError::SecureStorage(format!("Failed to save the session securely: {error}"))
        })
    });
    await_credential_task(task).await
}

async fn delete_credential() -> Result<(), CoreError> {
    reserve_keychain_attempt(&KEYCHAIN_DELETE_ATTEMPTED, "removal")?;
    let guard = begin_keychain_operation()?;
    let task = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        match keyring_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(CoreError::SecureStorage(format!(
                "Failed to remove the saved session: {error}"
            ))),
        }
    });
    await_credential_task(task).await
}

async fn await_credential_task<T>(
    task: tokio::task::JoinHandle<Result<T, CoreError>>,
) -> Result<T, CoreError> {
    // A user-facing Keychain decision is not a network timeout. Await the
    // platform result rather than dropping this JoinHandle after an arbitrary
    // delay; dropping it would leave the OS prompt alive while making later
    // retries start more prompts. The TUI can still cancel its outer session
    // task and switch to QR, while the cross-process lock prevents any second
    // credential call until this one has actually finished.
    task.await
        .map_err(|error| CoreError::SecureStorage(format!("Credential task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use super::{
        api_request_with_timeout, await_credential_task, begin_keychain_operation,
        reserve_keychain_attempt, MusicCore,
    };
    use crate::{CoreError, PlaylistScope, RequestCancellation};
    use serde_json::{json, Value};
    use tiny_http::{Header, Response, Server};
    use zeroize::Zeroizing;

    #[tokio::test(flavor = "current_thread")]
    async fn pre_cancelled_network_request_short_circuits_before_io() {
        let core = MusicCore::new();
        let cancellation = RequestCancellation::new();
        cancellation.cancel();

        let result = core.lyrics_cancellable(1, &cancellation).await;
        assert_eq!(result, Err(CoreError::Cancelled));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires live access to the Netease API"]
    async fn live_core_qr_login_key_contract() {
        let login = MusicCore::new()
            .begin_qr_login()
            .await
            .expect("live QR key response");

        assert!(!login.key.is_empty());
        assert!(
            login
                .login_url
                .starts_with("https://music.163.com/login?codekey="),
            "QR login URL must retain the service key parameter"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires live access to the Netease API"]
    async fn live_core_public_lyrics_contract() {
        let lyrics = MusicCore::new()
            .lyrics(186_016)
            .await
            .expect("live lyrics response");

        assert!(
            !lyrics.lines.is_empty() || lyrics.instrumental,
            "the live lyric response must provide timed lines or identify instrumental audio"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn api_auth_expiry_is_preserved_for_tui_reauthentication() {
        let (domain, requests, server) = spawn_api_fixture(vec![json!({
            "code": 301,
            "msg": "登录状态已失效"
        })]);
        let core = MusicCore::with_api_domain(domain).expect("fixture domain");
        *core.session_cookie.write().await = Some(Zeroizing::new("MUSIC_U=expired".to_string()));

        let result = core.daily_songs().await;
        assert!(matches!(
            result,
            Err(CoreError::AuthRequired(message)) if message.contains("登录状态已失效")
        ));
        assert_eq!(requests.lock().expect("request log").len(), 1);
        server.join().expect("fixture server");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn slow_api_request_becomes_a_network_timeout() {
        let cancellation = RequestCancellation::new();
        let result = api_request_with_timeout(&cancellation, Duration::from_millis(1), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok::<_, ncm_api_rs::NcmError>(())
        })
        .await;
        assert!(
            matches!(result, Err(CoreError::Network(message)) if message.contains("timed out"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn credential_task_waits_for_the_platform_result() {
        let task = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<_, CoreError>(Some("cookie".to_string()))
        });
        let result = await_credential_task(task).await;
        assert_eq!(result, Ok(Some("cookie".to_string())));
    }

    #[test]
    fn automatic_keychain_attempt_is_reserved_once() {
        let attempted = std::sync::atomic::AtomicBool::new(false);
        assert!(reserve_keychain_attempt(&attempted, "restore").is_ok());
        assert!(matches!(
            reserve_keychain_attempt(&attempted, "restore"),
            Err(CoreError::SecureStorage(message)) if message.contains("already attempted")
        ));
    }

    #[test]
    fn keychain_gate_rejects_a_second_inflight_operation_without_touching_keychain() {
        let guard = begin_keychain_operation().expect("first gate admission");
        assert!(matches!(
            begin_keychain_operation(),
            Err(CoreError::SecureStorage(message)) if message.contains("already waiting")
        ));
        drop(guard);
    }

    #[test]
    fn api_domain_override_requires_an_http_url_with_a_host() {
        assert!(MusicCore::with_api_domain("not a url").is_err());
        assert!(MusicCore::with_api_domain("file:///tmp/mock").is_err());
        assert!(MusicCore::with_api_domain("http://127.0.0.1:1234/").is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn core_vertical_slice_uses_real_api_request_and_parser_boundaries() {
        let responses = vec![
            json!({
                "code": 200,
                "data": {
                    "dailySongs": [track_json(101), track_json(102)],
                    "privileges": [
                        { "id": 101, "pl": 320000, "st": 0 },
                        { "id": 102, "pl": 0, "fee": 1, "st": 0 }
                    ]
                }
            }),
            playlist_overview_json(),
            playlist_overview_json(),
            playlist_overview_json(),
            playlist_detail_json(901),
            playlist_detail_json(900),
            json!({
                "code": 200,
                "songs": [track_json(102), track_json(101)]
            }),
            json!({
                "code": 200,
                "lrc": { "lyric": "[00:00.10]第一行\n[00:01.20]第二行" }
            }),
            json!({
                "code": 200,
                "data": [{
                    "url": "https://audio.example.test/101.mp3",
                    "type": "mp3",
                    "br": 320000,
                    "size": 1234,
                    "time": 1200,
                    "level": "exhigh"
                }]
            }),
        ];
        let (domain, requests, server) = spawn_api_fixture(responses);
        let core = MusicCore::with_api_domain(domain).expect("fixture domain");
        *core.session_cookie.write().await = Some(Zeroizing::new("MUSIC_U=fixture".to_string()));
        *core.session_user_id.write().await = Some(7);

        let daily = core.daily_songs().await.expect("daily songs");
        assert_eq!(
            daily
                .tracks
                .iter()
                .map(|track| track.id)
                .collect::<Vec<_>>(),
            [101, 102]
        );
        assert!(!daily.tracks[1].playable);

        let saved = core
            .playlist_page_for(7, PlaylistScope::Subscribed, 0)
            .await
            .expect("saved playlists");
        assert_eq!(saved.items[0].id, 900);
        assert!(saved.items[0].subscribed);

        let created = core
            .playlist_page_for(7, PlaylistScope::Owned, 0)
            .await
            .expect("created playlists");
        assert_eq!(created.items[0].id, 902);
        assert!(created.items[0].owned);

        let liked = core.liked_songs(7).await.expect("liked playlist");
        assert_eq!(liked.id, 901);
        assert!(liked.owned);

        let detail = core.playlist_detail(900).await.expect("playlist detail");
        assert_eq!(detail.track_ids, [101, 102]);
        assert_eq!(detail.tracks[0].id, 101);

        let page = core
            .playlist_track_page(&[101, 102])
            .await
            .expect("playlist track page");
        assert_eq!(
            page.tracks.iter().map(|track| track.id).collect::<Vec<_>>(),
            [101, 102]
        );

        let lyrics = core.lyrics(101).await.expect("lyrics");
        assert_eq!(lyrics.lines[1].time_ms, 1_200);

        let source = core
            .resolve_stream_url(101, "320000")
            .await
            .expect("stream source");
        assert_eq!(source.level, "exhigh");

        let paths = requests.lock().expect("request log").clone();
        server.join().expect("fixture server");
        assert_eq!(paths.len(), 9);
        assert!(paths[0].contains("recommend/songs"));
        assert!(paths[1].contains("user/playlist"));
        assert!(paths[2].contains("user/playlist"));
        assert!(paths[3].contains("user/playlist"));
        assert!(paths[4].contains("playlist/detail"));
        assert!(paths[5].contains("playlist/detail"));
        assert!(paths[6].contains("song/detail"));
        assert!(paths[7].contains("lyric"));
        assert!(paths[8].contains("song/enhance/player/url/v1"));
    }

    fn track_json(id: i64) -> Value {
        json!({
            "id": id,
            "name": format!("Track {id}"),
            "dt": 1_200,
            "ar": [{ "id": id + 1000, "name": "Artist" }],
            "al": { "id": id + 2000, "name": "Album", "picUrl": "https://img.test/a.jpg" }
        })
    }

    fn playlist_detail_json(id: i64) -> Value {
        json!({
            "code": 200,
            "playlist": {
                "id": id,
                "name": format!("Playlist {id}"),
                "trackCount": 2,
                "trackIds": [{ "id": 101 }, { "id": 102 }],
                "tracks": [track_json(101), track_json(102)],
                "creator": { "userId": 7, "nickname": "listener" }
            }
        })
    }

    fn playlist_overview_json() -> Value {
        json!({
            "code": 200,
            "playlist": [
                {
                    "id": 901,
                    "name": "我喜欢的音乐",
                    "trackCount": 2,
                    "specialType": 5,
                    "subscribed": false,
                    "creator": { "userId": 7, "nickname": "listener" }
                },
                {
                    "id": 902,
                    "name": "Created list",
                    "trackCount": 1,
                    "specialType": 0,
                    "subscribed": false,
                    "creator": { "userId": 7, "nickname": "listener" }
                },
                {
                    "id": 900,
                    "name": "Saved list",
                    "trackCount": 2,
                    "specialType": 0,
                    "subscribed": true,
                    "creator": { "userId": 9, "nickname": "other" }
                }
            ],
            "more": false
        })
    }

    fn spawn_api_fixture(
        responses: Vec<Value>,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let server = Server::http("127.0.0.1:0").expect("bind fixture server");
        let address = server.server_addr().to_string();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let request_log = Arc::clone(&requests);
        let server = thread::spawn(move || {
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("fixture content type");
            for body in responses {
                let request = server
                    .recv_timeout(Duration::from_secs(5))
                    .expect("receive fixture request")
                    .expect("fixture request within timeout");
                request_log
                    .lock()
                    .expect("request log lock")
                    .push(request.url().to_string());
                request
                    .respond(
                        Response::from_string(body.to_string()).with_header(content_type.clone()),
                    )
                    .expect("respond to fixture request");
            }
        });
        (format!("http://{address}"), requests, server)
    }
}
