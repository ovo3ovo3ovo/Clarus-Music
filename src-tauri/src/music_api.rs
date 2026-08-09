use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use ncm_api_rs::{create_client, ApiClient, NcmError, Query};
use serde::Serialize;
use tauri::State;
use tokio::{
    sync::{Mutex, RwLock},
    task::AbortHandle,
};
use zeroize::Zeroizing;

struct ActiveRequest {
    token: u64,
    abort_handle: AbortHandle,
}

#[derive(Default)]
struct RequestRegistry {
    active: HashMap<String, ActiveRequest>,
    /// A cancellation can cross the IPC boundary before the command it is
    /// cancelling has registered its task. Keep a short-lived tombstone so
    /// that ordering cannot resurrect work the renderer has already dropped.
    cancelled_before_start: HashMap<String, Instant>,
}

const CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_CANCELLATION_TOMBSTONES: usize = 1_024;

struct NetworkContext {
    client: ApiClient,
    real_ip: Option<String>,
}

pub struct MusicApiState {
    network: RwLock<NetworkContext>,
    session_cookie: Arc<RwLock<Option<Zeroizing<String>>>>,
    requests: Mutex<RequestRegistry>,
    next_request_token: AtomicU64,
}

impl Default for MusicApiState {
    fn default() -> Self {
        Self {
            network: RwLock::new(NetworkContext {
                client: create_client(None),
                real_ip: None,
            }),
            session_cookie: Arc::new(RwLock::new(None)),
            requests: Mutex::new(RequestRegistry::default()),
            next_request_token: AtomicU64::new(1),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFailure {
    kind: &'static str,
    message: String,
}

impl ApiFailure {
    pub(crate) fn from_ncm(error: NcmError) -> Self {
        let kind = match &error {
            NcmError::Http(_) => "network",
            NcmError::Api { .. } => "api",
            NcmError::AuthRequired(_) => "auth-required",
            NcmError::InvalidParam(_) => "invalid-parameter",
            NcmError::Crypto(_) => "crypto",
            NcmError::Json(_) => "invalid-response",
            NcmError::Timeout(_) => "timeout",
            NcmError::RateLimited(_) => "rate-limited",
            NcmError::Unknown(_) => "unknown",
        };
        Self {
            kind,
            message: error.to_string(),
        }
    }

    fn cancelled() -> Self {
        Self {
            kind: "cancelled",
            message: "Music API request was cancelled".to_string(),
        }
    }

    fn task_failed(message: String) -> Self {
        Self {
            kind: "task-failed",
            message,
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid-parameter",
            message: message.into(),
        }
    }

    pub(crate) fn secure_storage(message: impl Into<String>) -> Self {
        Self {
            kind: "secure-storage",
            message: message.into(),
        }
    }

    pub(crate) fn into_message(self) -> String {
        self.message
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            kind: "unavailable",
            message: message.into(),
        }
    }

    pub(crate) fn cache(message: impl Into<String>) -> Self {
        Self {
            kind: "cache",
            message: message.into(),
        }
    }

    pub(crate) fn auth_required(message: impl Into<String>) -> Self {
        Self {
            kind: "auth-required",
            message: message.into(),
        }
    }
}

impl MusicApiState {
    fn prune_cancellation_tombstones(registry: &mut RequestRegistry, now: Instant) {
        registry
            .cancelled_before_start
            .retain(|_, created| now.duration_since(*created) <= CANCELLATION_TOMBSTONE_TTL);
        while registry.cancelled_before_start.len() >= MAX_CANCELLATION_TOMBSTONES {
            let Some(oldest) = registry
                .cancelled_before_start
                .iter()
                .min_by_key(|(_, created)| **created)
                .map(|(request_id, _)| request_id.clone())
            else {
                break;
            };
            registry.cancelled_before_start.remove(&oldest);
        }
    }

    pub(crate) fn build_client(proxy_url: Option<&str>) -> Result<ApiClient, ApiFailure> {
        match proxy_url {
            Some(proxy_url) => ApiClient::with_proxy(None, proxy_url).map_err(ApiFailure::from_ncm),
            None => Ok(create_client(None)),
        }
    }

    pub(crate) async fn replace_network_client(&self, client: ApiClient, real_ip: Option<String>) {
        *self.network.write().await = NetworkContext { client, real_ip };
    }

    pub(crate) async fn request_context(&self) -> (ApiClient, Option<String>, Option<String>) {
        let (client, real_ip) = {
            let network = self.network.read().await;
            (network.client.clone(), network.real_ip.clone())
        };
        let cookie = self.session_cookie().await;
        (client, cookie, real_ip)
    }

    pub(crate) async fn session_cookie(&self) -> Option<String> {
        self.session_cookie
            .read()
            .await
            .as_ref()
            .map(|cookie| cookie.to_string())
    }

    pub(crate) fn session_handle(&self) -> Arc<RwLock<Option<Zeroizing<String>>>> {
        Arc::clone(&self.session_cookie)
    }

    pub(crate) async fn run_cancellable<T, F>(
        &self,
        request_id: String,
        operation: F,
    ) -> Result<T, ApiFailure>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, ApiFailure>> + Send + 'static,
    {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(ApiFailure::invalid(
                "requestId must contain between 1 and 128 bytes",
            ));
        }

        let token = self.next_request_token.fetch_add(1, Ordering::Relaxed);
        // Registration and early-cancellation observation share one lock. The
        // task is deliberately spawned only while that lock is held: either a
        // prior cancel leaves a tombstone and no work starts, or a later cancel
        // sees the registered abort handle. There is no unobservable gap.
        let task = {
            let mut requests = self.requests.lock().await;
            Self::prune_cancellation_tombstones(&mut requests, Instant::now());
            if requests
                .cancelled_before_start
                .remove(&request_id)
                .is_some()
            {
                return Err(ApiFailure::cancelled());
            }
            let task = tokio::spawn(operation);
            let active = ActiveRequest {
                token,
                abort_handle: task.abort_handle(),
            };
            if let Some(previous) = requests.active.insert(request_id.clone(), active) {
                previous.abort_handle.abort();
            }
            task
        };

        let result = task.await;
        let mut requests = self.requests.lock().await;
        if requests
            .active
            .get(&request_id)
            .is_some_and(|active| active.token == token)
        {
            requests.active.remove(&request_id);
        }
        drop(requests);

        match result {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Err(ApiFailure::cancelled()),
            Err(error) => Err(ApiFailure::task_failed(error.to_string())),
        }
    }

    pub(crate) async fn cancel_request(&self, request_id: String) -> Result<bool, ApiFailure> {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(ApiFailure::invalid(
                "requestId must contain between 1 and 128 bytes",
            ));
        }
        let mut requests = self.requests.lock().await;
        let now = Instant::now();
        Self::prune_cancellation_tombstones(&mut requests, now);
        if let Some(active) = requests.active.remove(&request_id) {
            active.abort_handle.abort();
            Ok(true)
        } else {
            requests.cancelled_before_start.insert(request_id, now);
            Ok(false)
        }
    }
}

pub(crate) fn with_request_context(
    mut query: Query,
    cookie: &Option<String>,
    real_ip: &Option<String>,
) -> Query {
    if let Some(cookie) = cookie {
        query = query.cookie(cookie);
    }
    query.real_ip.clone_from(real_ip);
    query
}

#[tauri::command]
pub async fn cancel_music_request(
    request_id: String,
    state: State<'_, MusicApiState>,
) -> Result<bool, ApiFailure> {
    state.cancel_request(request_id).await
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    use tokio::{sync::Notify, time::timeout};

    use super::{ApiFailure, MusicApiState};

    #[tokio::test]
    async fn cancellation_tombstone_prevents_late_request_from_starting() {
        let state = MusicApiState::default();
        let ran = Arc::new(AtomicBool::new(false));
        assert!(!state
            .cancel_request("cancel-before-register".to_string())
            .await
            .expect("record cancellation"));

        let operation_ran = Arc::clone(&ran);
        let result = state
            .run_cancellable("cancel-before-register".to_string(), async move {
                operation_ran.store(true, Ordering::SeqCst);
                Ok::<_, ApiFailure>(())
            })
            .await;

        assert!(result.is_err());
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancellation_aborts_an_already_registered_request() {
        let state = Arc::new(MusicApiState::default());
        let started = Arc::new(Notify::new());
        let never_finish = Arc::new(Notify::new());
        let request_state = Arc::clone(&state);
        let request_started = Arc::clone(&started);
        let request_never_finish = Arc::clone(&never_finish);
        let request = tokio::spawn(async move {
            request_state
                .run_cancellable("cancel-active".to_string(), async move {
                    request_started.notify_one();
                    request_never_finish.notified().await;
                    Ok::<_, ApiFailure>(())
                })
                .await
        });

        timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("request started");
        assert!(state
            .cancel_request("cancel-active".to_string())
            .await
            .expect("cancel active request"));
        let result = timeout(Duration::from_secs(1), request)
            .await
            .expect("request stopped")
            .expect("join request");
        assert!(result.is_err());
    }
}
