use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use fs2::FileExt;
use keyring::{Entry, Error as KeyringError};
use md5::{Digest, Md5};
use ncm_api_rs::{create_client, ApiClient, ApiResponse, Query};
use rand::{rngs::OsRng, RngCore};
use reqwest::{
    header::{ACCEPT, CONTENT_TYPE, COOKIE, REFERER, USER_AGENT},
    Client as HttpClient,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;
use url::Url;
use zeroize::Zeroizing;

use crate::{
    cache::{AudioCache, CachedAudio},
    cancellation::{cancelable, RequestCancellation},
    error::CoreError,
    models::{
        AuthSession, DailySongs, PlaylistDetail, PlaylistPage, PlaylistScope, PlaylistTrackPage,
        QrLogin, QrLoginCheck, QrLoginStatus, SmsLogin, StreamSource, TrackLyrics,
    },
    parse,
};

// The desktop app owns `com.ovo3ovo3ovo.clarusmusic`. macOS records the
// creating application's access control on legacy Keychain items, so sharing
// that item makes an unsigned/development TUI prompt for the user's password
// even though both applications are Clarus. Keep a dedicated, stable TUI item
// instead; it remains encrypted in the login Keychain but has no cross-app ACL
// handoff.
const KEYRING_SERVICE: &str = "com.ovo3ovo3ovo.clarusmusic.tui";
const KEYRING_ACCOUNT: &str = "netease-session";
const MAX_OFFSET: u64 = 100_000;
const MAX_FILTERED_PAGE_PROBES: usize = 8;
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// SMS authentication is a short control-plane request, but carrier/API
// latency can be higher than a normal status poll. Keep it bounded so the TUI
// never waits for the full data-request timeout before it can retry.
const AUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const KEYCHAIN_LOCK_FILE: &str = "clarus-music-keychain-access.lock";
const ANONYMOUS_DEVICE_XOR_KEY: &str = "3go8&$8*3*3h0k(2)2";
const NETEASE_WEB_ORIGIN: &str = "https://music.163.com";
const NETEASE_EAPI_ORIGIN: &str = "https://interface.music.163.com";
const YESPLAY_WEAPI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const ANONYMOUS_IDENTITY_FILE: &str = "anonymous-device-v1.json";

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

// Several deterministic tests exercise the process-wide Keychain admission
// flags. Rust runs tests in parallel, so serialize only those tests rather
// than allowing one test's simulated persistence state to leak into another.
#[cfg(test)]
static KEYCHAIN_TEST_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct KeychainOperationGuard {
    lock_file: File,
}

/// This is deliberately separate from the account Keychain session: it only
/// represents the anonymous browser/device context NetEase expects before an
/// SMS request. Persisting it avoids registering a brand-new anonymous device
/// for every TUI launch, which quickly trips the service's risk controls.
#[derive(Deserialize, Serialize)]
struct AnonymousDeviceIdentity {
    device_id: String,
    music_a: String,
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
    web_client: HttpClient,
    session_cookie: Arc<RwLock<Option<Zeroizing<String>>>>,
    session_user_id: Arc<RwLock<Option<i64>>>,
    anonymous_cookie: Arc<RwLock<Option<Zeroizing<String>>>>,
    device_id: String,
    web_wnmcid: String,
    anonymous_identity_path: Option<std::path::PathBuf>,
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
        // Keep the anonymous device stable in production. Test/proxy cores do
        // not read a real machine identity, keeping fixtures hermetic.
        let anonymous_identity_path = api_domain.is_none().then(anonymous_identity_store_path);
        let persisted_identity = anonymous_identity_path
            .as_deref()
            .and_then(load_anonymous_identity);
        let device_id = persisted_identity
            .as_ref()
            .map(|identity| identity.device_id.clone())
            .unwrap_or_else(ncm_api_rs::util::device::generate_device_id);
        let mut client = create_client(None);
        client.set_device_id(device_id.clone());
        let web_client = HttpClient::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("the authentication HTTP client configuration must be valid");
        Self {
            client,
            web_client,
            session_cookie: Arc::new(RwLock::new(None)),
            session_user_id: Arc::new(RwLock::new(None)),
            anonymous_cookie: Arc::new(RwLock::new(persisted_identity.map(|identity| {
                Zeroizing::new(format!(
                    "MUSIC_A={}; deviceId={}",
                    identity.music_a, identity.device_id
                ))
            }))),
            device_id,
            web_wnmcid: yesplay_wnmcid(),
            anonymous_identity_path,
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
        // A just-authorized QR or SMS login already has a validated cookie in the
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
            // startup. A later successful login overwrites it, and the
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
        // The QR key and every following poll must describe the same
        // anonymous device.  Current NetEase endpoints reject the otherwise
        // valid EAPI request with code 400 when MUSIC_A is omitted.
        let cookie = self.qr_request_cookie_cancellable(cancellation).await?;
        let response = api_request(
            cancellation,
            self.client
                .login_qr_key(&self.request_query(Query::new(), &cookie)),
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
        let cookie = self.qr_request_cookie_cancellable(cancellation).await?;
        let response = api_request(
            cancellation,
            self.client
                .login_qr_check(&self.request_query(Query::new().param("key", key), &cookie)),
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
                    *self.session_cookie.write().await = None;
                    *self.session_user_id.write().await = None;
                    return Err(error);
                }
            }
        }
        Ok(QrLoginCheck { status, message })
    }

    pub async fn send_sms_captcha(&self, phone: &str, country_code: &str) -> Result<(), CoreError> {
        self.send_sms_captcha_cancellable(phone, country_code, &RequestCancellation::new())
            .await
    }

    pub async fn send_sms_captcha_cancellable(
        &self,
        phone: &str,
        country_code: &str,
        cancellation: &RequestCancellation,
    ) -> Result<(), CoreError> {
        validate_phone_login_input(phone, country_code, None)?;
        let anonymous_cookie = self.anonymous_cookie_cancellable(cancellation).await?;
        let music_a = anonymous_music_a(&anonymous_cookie)?;
        let response = self
            .yesplay_weapi_request_cancellable(
                cancellation,
                "/api/sms/captcha/sent",
                json!({
                    "ctcode": country_code.trim(),
                    "secrete": "music_middleuser_pclogin",
                    "cellphone": phone.trim(),
                }),
                self.yesplay_web_cookie(Some(&music_a), true),
            )
            .await?;
        ensure_api_success(&response.body, "短信验证码发送失败")
    }

    pub async fn login_with_sms(
        &self,
        phone: &str,
        captcha: &str,
        country_code: &str,
    ) -> Result<SmsLogin, CoreError> {
        self.login_with_sms_cancellable(phone, captcha, country_code, &RequestCancellation::new())
            .await
    }

    pub async fn login_with_sms_cancellable(
        &self,
        phone: &str,
        captcha: &str,
        country_code: &str,
        cancellation: &RequestCancellation,
    ) -> Result<SmsLogin, CoreError> {
        validate_phone_login_input(phone, country_code, Some(captcha))?;
        let phone = phone.trim();
        let captcha = captcha.trim();
        let country_code = country_code.trim();
        let anonymous_cookie = self.anonymous_cookie_cancellable(cancellation).await?;
        let music_a = anonymous_music_a(&anonymous_cookie)?;

        // The generic SDK's EAPI builder creates a semantically similar
        // payload, but this endpoint is sensitive to its exact header/body
        // contract. Send the known-good YesPlayMusic shape directly.
        let response = self
            .yesplay_eapi_request_cancellable(
                cancellation,
                "/api/w/login/cellphone",
                sms_login_payload(phone, captcha, country_code),
                &music_a,
            )
            .await?;
        ensure_api_success(&response.body, "手机号登录失败")?;
        let user = parse::parse_auth_user(&response.body).ok_or_else(|| {
            CoreError::Unavailable("手机号登录响应缺少用户信息，请稍后重试".to_string())
        })?;
        let cookie = parse::authenticated_cookie(&response)?;
        if cancellation.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        // Keep the newly authorized account usable in this process even when
        // the platform credential store is unavailable. The UI can surface
        // that persistence warning without exposing the cookie or captcha.
        *self.session_cookie.write().await = Some(Zeroizing::new(cookie.clone()));
        *self.session_user_id.write().await = Some(user.user_id);
        let saved_to_keychain = match cancelable(cancellation, save_credential(&cookie)).await {
            Ok(()) => true,
            Err(CoreError::SecureStorage(_)) => false,
            Err(CoreError::Cancelled) => {
                *self.session_cookie.write().await = None;
                *self.session_user_id.write().await = None;
                return Err(CoreError::Cancelled);
            }
            Err(error) => {
                *self.session_cookie.write().await = None;
                *self.session_user_id.write().await = None;
                return Err(error);
            }
        };
        Ok(SmsLogin {
            user,
            saved_to_keychain,
        })
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

    /// Mirrors YesPlayMusic's startup bootstrap: register the current device
    /// once, retain only its anonymous `MUSIC_A` token in memory, and present
    /// that token to the SMS endpoints. NetEase rejects some direct SMS
    /// requests without this device context as an invalid parameter.
    async fn anonymous_cookie_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<String, CoreError> {
        if let Some(cookie) = self
            .anonymous_cookie
            .read()
            .await
            .as_ref()
            .map(|cookie| cookie.to_string())
        {
            return Ok(cookie);
        }

        // This call is intentionally sent through the same ordered WebAPI
        // request shape as YesPlayMusic. The generic SDK stores cookies in a
        // hash map, which changes the client fingerprint and is intermittently
        // rejected by this particular endpoint.
        let response = self
            .yesplay_weapi_request_cancellable(
                cancellation,
                "/api/register/anonimous",
                anonymous_registration_payload(&self.device_id),
                self.yesplay_web_cookie(None, true),
            )
            .await?;
        ensure_api_success(&response.body, "匿名设备初始化失败")?;
        let token = parse::response_cookie_value(&response, "MUSIC_A").ok_or_else(|| {
            CoreError::Unavailable("匿名设备初始化未返回 MUSIC_A token".to_string())
        })?;
        if cancellation.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        // Keep the device identity with the token. It is memory-only and is
        // intentionally not written to Keychain because it is not an account
        // session.
        let cookie = format!("MUSIC_A={token}; deviceId={}", self.device_id);
        let mut stored = self.anonymous_cookie.write().await;
        if let Some(existing) = stored.as_ref() {
            return Ok(existing.to_string());
        }
        *stored = Some(Zeroizing::new(cookie.clone()));
        if let Some(path) = self.anonymous_identity_path.as_deref() {
            persist_anonymous_identity(
                path,
                &AnonymousDeviceIdentity {
                    device_id: self.device_id.clone(),
                    music_a: token,
                },
            );
        }
        Ok(cookie)
    }

    /// Returns the stable anonymous context used for a QR key and its polls.
    /// Test/proxy cores intentionally keep their two-request fixture contract
    /// and do not make a live anonymous-device bootstrap call.
    async fn qr_request_cookie_cancellable(
        &self,
        cancellation: &RequestCancellation,
    ) -> Result<Option<String>, CoreError> {
        if self.api_domain.is_some() {
            return Ok(None);
        }
        self.anonymous_cookie_cancellable(cancellation)
            .await
            .map(Some)
    }

    /// Builds the WebAPI cookie sequence used by the upstream NetEase client
    /// module. Its ordering is intentional: this login-adjacent endpoint is
    /// more sensitive than ordinary catalog APIs, and the Rust SDK's HashMap
    /// serialization does not preserve a browser-like ordering.
    fn yesplay_web_cookie(&self, music_a: Option<&str>, include_nmtid: bool) -> String {
        let nuid = secure_cookie_hex(32);
        let timestamp_ms = unix_timestamp_ms();
        let mut pairs = vec![
            ("__remember_me", "true".to_string()),
            ("ntes_kaola_ad", "1".to_string()),
            ("_ntes_nuid", nuid.clone()),
            ("_ntes_nnid", format!("{nuid},{timestamp_ms}")),
            ("WNMCID", self.web_wnmcid.clone()),
            ("WEVNSM", "1.0.0".to_string()),
            ("osver", "16.2".to_string()),
            ("deviceId", self.device_id.clone()),
            ("os", "iPhone OS".to_string()),
            ("channel", "distribution".to_string()),
            ("appver", "9.0.90".to_string()),
        ];
        if include_nmtid {
            pairs.push(("NMTID", secure_cookie_hex(16)));
        }
        // YesPlayMusic includes this key even when its persisted anonymous
        // token is empty. The empty first-registration value is meaningful to
        // the service, so always emit it last.
        pairs.push(("MUSIC_A", music_a.unwrap_or_default().to_string()));

        pairs
            .into_iter()
            .map(|(name, value)| {
                format!(
                    "{}={}",
                    urlencoding::encode(name),
                    urlencoding::encode(&value)
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    async fn yesplay_weapi_request_cancellable(
        &self,
        cancellation: &RequestCancellation,
        endpoint: &str,
        data: serde_json::Value,
        cookie: String,
    ) -> Result<ApiResponse, CoreError> {
        // The WebAPI branch mutates every request with this field before
        // encrypting, including a first anonymous registration where it is an
        // empty string. Omitting it changes the encrypted payload shape.
        let mut data = data;
        data["csrf_token"] = serde_json::Value::String(String::new());
        let encrypted = ncm_api_rs::crypto::weapi(&data);
        // Preserve YesPlayMusic's form-field order as well: `params` first,
        // then `encSecKey`.
        let params = encrypted.get("params").ok_or_else(|| {
            CoreError::Unavailable("WebAPI encryption did not produce params".to_string())
        })?;
        let enc_sec_key = encrypted.get("encSecKey").ok_or_else(|| {
            CoreError::Unavailable("WebAPI encryption did not produce encSecKey".to_string())
        })?;
        let body = format!(
            "params={}&encSecKey={}",
            urlencoding::encode(params),
            urlencoding::encode(enc_sec_key)
        );
        let origin = self.api_domain.as_deref().unwrap_or(NETEASE_WEB_ORIGIN);
        let endpoint = endpoint.strip_prefix("/api/").ok_or_else(|| {
            CoreError::Invalid("WebAPI endpoint must start with /api/".to_string())
        })?;
        let url = format!("{}/weapi/{endpoint}", origin.trim_end_matches('/'));
        let client = self.web_client.clone();
        let referer = origin.to_string();
        let request = async move {
            let response = client
                .post(url)
                .header(ACCEPT, "application/json, text/plain, */*")
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(COOKIE, cookie)
                .header(REFERER, referer)
                .header(USER_AGENT, YESPLAY_WEAPI_USER_AGENT)
                .body(body)
                .send()
                .await
                .map_err(|error| {
                    CoreError::Network(format!("WebAPI authentication request failed: {error}"))
                })?;
            let status = i64::from(response.status().as_u16());
            let cookies = response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|value| value.to_str().ok().map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            let text = response.text().await.map_err(|error| {
                CoreError::Network(format!(
                    "failed to read WebAPI authentication response: {error}"
                ))
            })?;
            let body = serde_json::from_str(&text).map_err(|error| {
                CoreError::Network(format!(
                    "WebAPI authentication response was not JSON: {error}"
                ))
            })?;
            Ok(ApiResponse {
                status,
                body,
                cookie: cookies,
            })
        };
        auth_http_request(cancellation, request).await
    }

    async fn yesplay_eapi_request_cancellable(
        &self,
        cancellation: &RequestCancellation,
        endpoint: &str,
        data: serde_json::Value,
        music_a: &str,
    ) -> Result<ApiResponse, CoreError> {
        let now_ms = unix_timestamp_ms();
        let buildver = now_ms.to_string().chars().take(10).collect::<String>();
        let mut random_bytes = [0_u8; 2];
        let mut random = OsRng;
        random.fill_bytes(&mut random_bytes);
        let request_id = format!("{now_ms}_{:04}", u16::from_be_bytes(random_bytes) % 1_000);
        let header = json!({
            "osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
            "deviceId": self.device_id,
            "os": "pc",
            "appver": "3.1.17.204416",
            "versioncode": "140",
            "mobilename": "",
            "buildver": buildver,
            "resolution": "1920x1080",
            "__csrf": "",
            "channel": "netease",
            "requestId": request_id,
            "MUSIC_A": music_a,
        });
        let cookie = [
            (
                "osver",
                "Microsoft-Windows-10-Professional-build-19045-64bit",
            ),
            ("deviceId", self.device_id.as_str()),
            ("os", "pc"),
            ("appver", "3.1.17.204416"),
            ("versioncode", "140"),
            ("mobilename", ""),
            ("buildver", buildver.as_str()),
            ("resolution", "1920x1080"),
            ("__csrf", ""),
            ("channel", "netease"),
            ("requestId", request_id.as_str()),
            ("MUSIC_A", music_a),
        ]
        .into_iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
        let mut data = data;
        data["header"] = header;
        data["e_r"] = serde_json::Value::Bool(false);
        let encrypted = ncm_api_rs::crypto::eapi(endpoint, &data);
        let params = encrypted.get("params").ok_or_else(|| {
            CoreError::Unavailable("EAPI encryption did not produce params".to_string())
        })?;
        let origin = self.api_domain.as_deref().unwrap_or(NETEASE_EAPI_ORIGIN);
        let endpoint = endpoint
            .strip_prefix("/api/")
            .ok_or_else(|| CoreError::Invalid("EAPI endpoint must start with /api/".to_string()))?;
        let url = format!("{}/eapi/{endpoint}", origin.trim_end_matches('/'));
        let client = self.web_client.clone();
        let request = async move {
            let response = client
                .post(url)
                .header(ACCEPT, "application/json, text/plain, */*")
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header(COOKIE, cookie)
                .header(
                    USER_AGENT,
                    "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)",
                )
                .body(format!("params={}", urlencoding::encode(params)))
                .send()
                .await
                .map_err(|error| {
                    CoreError::Network(format!("EAPI authentication request failed: {error}"))
                })?;
            let status = i64::from(response.status().as_u16());
            let cookies = response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|value| value.to_str().ok().map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            let text = response.text().await.map_err(|error| {
                CoreError::Network(format!(
                    "failed to read EAPI authentication response: {error}"
                ))
            })?;
            let body = serde_json::from_str(&text).map_err(|error| {
                CoreError::Network(format!(
                    "EAPI authentication response was not JSON: {error}"
                ))
            })?;
            Ok(ApiResponse {
                status,
                body,
                cookie: cookies,
            })
        };
        auth_http_request(cancellation, request).await
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

async fn auth_http_request<T, F>(
    cancellation: &RequestCancellation,
    future: F,
) -> Result<T, CoreError>
where
    F: std::future::Future<Output = Result<T, CoreError>>,
{
    cancelable(cancellation, async move {
        match tokio::time::timeout(AUTH_REQUEST_TIMEOUT, future).await {
            Ok(result) => result,
            Err(_) => Err(CoreError::Network(format!(
                "authentication request timed out after {} seconds",
                AUTH_REQUEST_TIMEOUT.as_secs_f32()
            ))),
        }
    })
    .await
}

fn validate_phone_login_input(
    phone: &str,
    country_code: &str,
    captcha: Option<&str>,
) -> Result<(), CoreError> {
    let phone = phone.trim();
    if !(7..=15).contains(&phone.len()) || !phone.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CoreError::Invalid(
            "手机号应为 7–15 位数字，不要输入区号或空格".to_string(),
        ));
    }
    let country_code = country_code.trim();
    if !(1..=4).contains(&country_code.len())
        || !country_code.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(CoreError::Invalid("国家/地区区号格式不正确".to_string()));
    }
    if let Some(captcha) = captcha {
        let captcha = captcha.trim();
        if !(4..=8).contains(&captcha.len()) || !captcha.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CoreError::Invalid("短信验证码应为 4–8 位数字".to_string()));
        }
    }
    Ok(())
}

fn sms_login_payload(phone: &str, captcha: &str, country_code: &str) -> serde_json::Value {
    // Mirrors YesPlayMusic's `module/login_cellphone.js` in captcha mode.
    // `captcha` is intentionally the only credential field here: adding a
    // `password` field changes the server's request interpretation.
    json!({
        "type": "1",
        "https": "true",
        "phone": phone,
        "countrycode": country_code,
        "captcha": captcha,
        "remember": "true",
    })
}

/// Reproduces YesPlayMusic's anonymous-device registration payload. The
/// device ID is already installed on our `ApiClient`, so the request body and
/// subsequent cookie headers describe the same device.
fn anonymous_registration_payload(device_id: &str) -> serde_json::Value {
    // YesPlayMusic constructs a JavaScript string from each XOR result, then
    // passes that string through CryptoJS' UTF-8 encoder before hashing.
    // Hashing raw XOR bytes differs for values above ASCII and produces an
    // invalid anonymous-registration username.
    let xored = device_id
        .bytes()
        .enumerate()
        .map(|(index, byte)| {
            char::from(
                byte ^ ANONYMOUS_DEVICE_XOR_KEY.as_bytes()[index % ANONYMOUS_DEVICE_XOR_KEY.len()],
            )
        })
        .collect::<String>();
    let encoded_id = BASE64_STANDARD.encode(Md5::digest(xored.as_bytes()));
    let username = BASE64_STANDARD.encode(format!("{device_id} {encoded_id}"));
    json!({ "username": username })
}

/// Supplies the browser identity cookies that YesPlayMusic's API client
/// creates internally. `ncm-api-rs` supplies compatible names, but uses half
/// the random-byte lengths for `_ntes_nuid` and `NMTID`. The music service can
/// reject that malformed device fingerprint before an SMS request is reached.
///
/// `NMTID` is deliberately absent for login endpoints: the upstream client
/// only adds it to non-login requests.
#[cfg(test)]
fn web_identity_cookie(base: &str, include_nmtid: bool) -> String {
    let nuid = secure_cookie_hex(32);
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let mut cookie = base.trim().trim_end_matches(';').trim_end().to_string();
    if !cookie.is_empty() {
        cookie.push_str("; ");
    }
    cookie.push_str("_ntes_nuid=");
    cookie.push_str(&nuid);
    cookie.push_str("; _ntes_nnid=");
    cookie.push_str(&nuid);
    cookie.push(',');
    cookie.push_str(&timestamp_ms.to_string());
    if include_nmtid {
        cookie.push_str("; NMTID=");
        cookie.push_str(&secure_cookie_hex(16));
    }
    cookie
}

fn secure_cookie_hex(byte_len: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut bytes = vec![0_u8; byte_len];
    let mut random = OsRng;
    random.fill_bytes(&mut bytes);

    let mut hex = String::with_capacity(byte_len * 2);
    for byte in bytes {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

fn anonymous_music_a(cookie: &str) -> Result<String, CoreError> {
    cookie
        .split(';')
        .filter_map(|entry| entry.trim().split_once('='))
        .find(|(name, value)| *name == "MUSIC_A" && !value.is_empty())
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| {
            CoreError::Unavailable("匿名设备状态缺少 MUSIC_A token，请重新启动后再试".to_string())
        })
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn yesplay_wnmcid() -> String {
    let mut bytes = [0_u8; 6];
    let mut random = OsRng;
    random.fill_bytes(&mut bytes);
    let prefix = bytes
        .into_iter()
        .map(|byte| char::from(b'a' + byte % 26))
        .collect::<String>();
    format!("{prefix}.{}.01.0", unix_timestamp_ms())
}

fn anonymous_identity_store_path() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library").join("Caches"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("com.ovo3ovo3ovo.clarusmusic")
        .join(ANONYMOUS_IDENTITY_FILE)
}

fn load_anonymous_identity(path: &Path) -> Option<AnonymousDeviceIdentity> {
    let identity =
        serde_json::from_str::<AnonymousDeviceIdentity>(&std::fs::read_to_string(path).ok()?)
            .ok()?;
    valid_anonymous_identity(&identity).then_some(identity)
}

fn persist_anonymous_identity(path: &Path, identity: &AnonymousDeviceIdentity) {
    if !valid_anonymous_identity(identity) {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(serialized) = serde_json::to_vec(identity) else {
        return;
    };
    if std::fs::write(path, serialized).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn valid_anonymous_identity(identity: &AnonymousDeviceIdentity) -> bool {
    identity.device_id.len() == 52
        && identity
            .device_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
        && !identity.music_a.is_empty()
        && identity.music_a.len() <= 4_096
        && identity
            .music_a
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_api_success(body: &serde_json::Value, fallback: &str) -> Result<(), CoreError> {
    let code = parse::response_code(body);
    if code == 200 {
        return Ok(());
    }
    let message = parse::response_message(body, fallback);
    Err(CoreError::Api(if message == fallback {
        format!("{fallback}（服务返回 code {code}）")
    } else {
        message
    }))
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
    // task and switch to QR login, while the cross-process lock prevents any second
    // credential call until this one has actually finished.
    task.await
        .map_err(|error| CoreError::SecureStorage(format!("Credential task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{atomic::Ordering, Arc, Mutex},
        thread,
        time::Duration,
    };

    use super::{
        api_request_with_timeout, await_credential_task, begin_keychain_operation,
        reserve_keychain_attempt, MusicCore, KEYCHAIN_SAVE_ATTEMPTED, KEYCHAIN_TEST_SERIAL,
        KEYRING_SERVICE,
    };
    use crate::{CoreError, PlaylistScope, QrLoginStatus, RequestCancellation};
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

    #[test]
    fn tui_keychain_item_is_not_shared_with_the_desktop_client() {
        assert_eq!(KEYRING_SERVICE, "com.ovo3ovo3ovo.clarusmusic.tui");
        assert_ne!(KEYRING_SERVICE, "com.ovo3ovo3ovo.clarusmusic");
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
    #[ignore = "requires live access to the Netease API"]
    async fn live_qr_poll_accepts_the_fresh_anonymous_device_context() {
        let core = MusicCore::new();
        let qr = core.begin_qr_login().await.expect("QR key response");
        let check = core
            .check_qr_login(&qr.key)
            .await
            .expect("fresh QR key should be pollable before scanning");
        assert_eq!(check.status, QrLoginStatus::Waiting);
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires live access to the Netease API"]
    async fn live_anonymous_device_bootstrap_contract() {
        // Use an explicit production origin so this test always exercises a
        // first-ever bootstrap rather than reusing a developer's persisted
        // anonymous token.
        let core =
            MusicCore::with_api_domain(super::NETEASE_WEB_ORIGIN).expect("production origin");
        let cookie = core
            .anonymous_cookie_cancellable(&RequestCancellation::new())
            .await
            .expect("anonymous device bootstrap");
        assert!(cookie.starts_with("MUSIC_A="));
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
    async fn qr_login_key_and_poll_use_the_public_core_contract() {
        let (domain, requests, server) = spawn_api_fixture(vec![
            json!({ "code": 200, "data": { "unikey": "fixture-qr-key" } }),
            json!({ "code": 802, "message": "等待确认" }),
        ]);
        let core = MusicCore::with_api_domain(domain).expect("fixture domain");

        let qr = core.begin_qr_login().await.expect("QR key response");
        assert_eq!(qr.key, "fixture-qr-key");
        assert_eq!(
            qr.login_url,
            "https://music.163.com/login?codekey=fixture-qr-key"
        );
        let check = core
            .check_qr_login(&qr.key)
            .await
            .expect("QR status response");
        assert_eq!(check.status, crate::QrLoginStatus::Scanned);
        assert_eq!(check.message, "等待确认");

        let paths = requests.lock().expect("request log").clone();
        server.join().expect("fixture server");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].contains("login/qrcode/unikey"), "{paths:?}");
        assert!(paths[1].contains("login/qrcode/client/login"), "{paths:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sms_captcha_uses_the_phone_endpoint_and_accepts_a_success_response() {
        let (domain, requests, server) = spawn_api_fixture(vec![
            json!({ "code": 200, "cookie": "MUSIC_A=fixture-anonymous" }),
            json!({ "code": 200 }),
        ]);
        let core = MusicCore::with_api_domain(domain).expect("fixture domain");

        core.send_sms_captcha("13800138000", "86")
            .await
            .expect("captcha request");

        let paths = requests.lock().expect("request log").clone();
        server.join().expect("fixture server");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].contains("register/anonimous"));
        assert!(paths[1].contains("sms/captcha/sent"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn anonymous_bootstrap_includes_yesplay_empty_music_a_cookie() {
        let server = Server::http("127.0.0.1:0").expect("bind fixture server");
        let address = server.server_addr().to_string();
        let cookie_header = Arc::new(Mutex::new(None));
        let recorded_cookie = Arc::clone(&cookie_header);
        let server = thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .expect("receive fixture request")
                .expect("fixture request within timeout");
            let cookie = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Cookie"))
                .map(|header| header.value.as_str().to_string());
            *recorded_cookie.lock().expect("cookie log lock") = cookie;
            request
                .respond(
                    Response::from_string(
                        json!({ "code": 200, "cookie": "MUSIC_A=fixture-anonymous" }).to_string(),
                    )
                    .with_header(
                        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                            .expect("fixture content type"),
                    ),
                )
                .expect("respond to fixture request");
        });
        let core = MusicCore::with_api_domain(format!("http://{address}")).expect("fixture domain");

        core.anonymous_cookie_cancellable(&RequestCancellation::new())
            .await
            .expect("anonymous bootstrap");

        server.join().expect("fixture server");
        assert!(
            cookie_header
                .lock()
                .expect("cookie log lock")
                .as_deref()
                .is_some_and(|cookie| cookie.contains("MUSIC_A=")),
            "the first anonymous bootstrap must include an empty MUSIC_A key"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sms_login_uses_yesplay_eapi_contract_and_keeps_the_authorized_session() {
        let _keychain_test_serial = KEYCHAIN_TEST_SERIAL.lock().await;
        let (domain, requests, server) = spawn_api_fixture(vec![
            json!({ "code": 200, "cookie": "MUSIC_A=fixture-anonymous" }),
            json!({
                "code": 200,
                "cookie": "MUSIC_U=fixture-session; __csrf=fixture-csrf",
                "profile": { "userId": 7, "nickname": "listener", "vipType": 0 }
            }),
        ]);
        let core = MusicCore::with_api_domain(domain).expect("fixture domain");
        // Do not call the host Keychain from a deterministic fixture. A
        // reserved save attempt follows the same recoverable path as an OS
        // credential-store failure, so this also verifies the in-memory
        // session invariant.
        let previous = KEYCHAIN_SAVE_ATTEMPTED.swap(true, Ordering::AcqRel);
        let login = core
            .login_with_sms("13800138000", "123456", "86")
            .await
            .expect("SMS login response");
        KEYCHAIN_SAVE_ATTEMPTED.store(previous, Ordering::Release);

        assert_eq!(login.user.user_id, 7);
        assert_eq!(login.user.nickname, "listener");
        assert!(!login.saved_to_keychain);
        assert_eq!(
            core.session_cookie().await.as_deref(),
            Some("MUSIC_U=fixture-session; __csrf=fixture-csrf")
        );
        assert_eq!(*core.session_user_id.read().await, Some(7));
        let paths = requests.lock().expect("request log").clone();
        server.join().expect("fixture server");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].contains("register/anonimous"));
        assert!(paths[1].contains("/eapi/w/login/cellphone"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sms_login_eapi_request_matches_yesplay_header_and_captcha_contract() {
        let server = Server::http("127.0.0.1:0").expect("bind fixture server");
        let address = server.server_addr().to_string();
        let captured = Arc::new(Mutex::new(None));
        let captured_request = Arc::clone(&captured);
        let server = thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .expect("receive fixture request")
                .expect("fixture request within timeout");
            let path = request.url().to_string();
            let cookie = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Cookie"))
                .map(|header| header.value.as_str().to_string())
                .unwrap_or_default();
            let mut body = String::new();
            request
                .as_reader()
                .read_to_string(&mut body)
                .expect("read fixture request body");
            *captured_request.lock().expect("request log lock") = Some((path, cookie, body));
            request
                .respond(
                    Response::from_string(json!({ "code": 200 }).to_string()).with_header(
                        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                            .expect("fixture content type"),
                    ),
                )
                .expect("respond to fixture request");
        });
        let core = MusicCore::with_api_domain(format!("http://{address}")).expect("fixture domain");

        core.yesplay_eapi_request_cancellable(
            &RequestCancellation::new(),
            "/api/w/login/cellphone",
            super::sms_login_payload("13800138000", "123456", "86"),
            "fixture-anonymous",
        )
        .await
        .expect("EAPI login request");

        server.join().expect("fixture server");
        let (path, cookie, body) = captured
            .lock()
            .expect("request log lock")
            .take()
            .expect("captured request");
        assert_eq!(path, "/eapi/w/login/cellphone");
        assert!(cookie.starts_with("osver="));
        assert!(cookie.contains("MUSIC_A=fixture-anonymous"));
        let params = body.strip_prefix("params=").expect("EAPI form params");
        let (endpoint, payload) =
            ncm_api_rs::crypto::eapi_req_decrypt(params).expect("decrypt EAPI fixture payload");
        assert_eq!(endpoint, "/api/w/login/cellphone");
        assert_eq!(payload["phone"], "13800138000");
        assert_eq!(payload["countrycode"], "86");
        assert_eq!(payload["captcha"], "123456");
        assert!(payload.get("password").is_none());
        assert_eq!(payload["e_r"], false);
        assert_eq!(payload["header"]["MUSIC_A"], "fixture-anonymous");
        assert_eq!(payload["header"]["os"], "pc");
    }

    #[test]
    fn sms_login_payload_matches_yesplay_captcha_mode() {
        let payload = super::sms_login_payload("13800138000", "123456", "86");
        assert_eq!(payload["phone"], "13800138000");
        assert_eq!(payload["countrycode"], "86");
        assert_eq!(payload["captcha"], "123456");
        assert_eq!(payload["remember"], "true");
        assert!(payload.get("password").is_none());
    }

    #[test]
    fn anonymous_registration_payload_has_a_username_for_the_current_device() {
        let payload = super::anonymous_registration_payload(
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123",
        );
        // Golden value generated by YesPlayMusic's JavaScript implementation.
        assert_eq!(
            payload["username"],
            "MDEyMzQ1Njc4OUFCQ0RFRjAxMjM0NTY3ODlBQkNERUYwMTIzNDU2Nzg5QUJDREVGMDEyMyBYa2pIc2o5dnlXcTVRNDdCdXYyVWNnPT0="
        );
    }

    #[test]
    fn web_identity_cookie_matches_yesplay_browser_identity_shape() {
        let cookie = super::web_identity_cookie("MUSIC_A=anonymous; deviceId=device", true);
        let pairs = cookie
            .split("; ")
            .filter_map(|entry| entry.split_once('='))
            .collect::<std::collections::HashMap<_, _>>();

        let nuid = *pairs.get("_ntes_nuid").expect("nuid cookie");
        assert_eq!(nuid.len(), 64, "32 random bytes encoded as hex");
        assert!(nuid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let (nnid_nuid, timestamp) = pairs["_ntes_nnid"].split_once(',').expect("nnid timestamp");
        assert_eq!(nnid_nuid, nuid);
        assert!(timestamp.bytes().all(|byte| byte.is_ascii_digit()));
        assert_eq!(pairs["NMTID"].len(), 32, "16 random bytes encoded as hex");
        assert_eq!(pairs["MUSIC_A"], "anonymous");
        assert_eq!(pairs["deviceId"], "device");

        let login_cookie = super::web_identity_cookie("MUSIC_A=anonymous", false);
        assert!(!login_cookie.contains("NMTID="));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sms_login_rejects_invalid_input_before_network_io() {
        let core = MusicCore::new();
        let result = core.login_with_sms("138 0013", "12ab", "86").await;
        assert!(matches!(result, Err(CoreError::Invalid(message)) if message.contains("手机号")));
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

    #[tokio::test(flavor = "current_thread")]
    async fn keychain_gate_rejects_a_second_inflight_operation_without_touching_keychain() {
        let _keychain_test_serial = KEYCHAIN_TEST_SERIAL.lock().await;
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
