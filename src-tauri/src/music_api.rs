use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
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

struct NetworkContext {
    client: ApiClient,
    real_ip: Option<String>,
}

pub struct MusicApiState {
    network: RwLock<NetworkContext>,
    session_cookie: Arc<RwLock<Option<Zeroizing<String>>>>,
    active_requests: Mutex<HashMap<String, ActiveRequest>>,
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
            active_requests: Mutex::new(HashMap::new()),
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
        let task = tokio::spawn(operation);
        let active = ActiveRequest {
            token,
            abort_handle: task.abort_handle(),
        };
        if let Some(previous) = self
            .active_requests
            .lock()
            .await
            .insert(request_id.clone(), active)
        {
            previous.abort_handle.abort();
        }

        let result = task.await;
        let mut requests = self.active_requests.lock().await;
        if requests
            .get(&request_id)
            .is_some_and(|active| active.token == token)
        {
            requests.remove(&request_id);
        }
        drop(requests);

        match result {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Err(ApiFailure::cancelled()),
            Err(error) => Err(ApiFailure::task_failed(error.to_string())),
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
    let active = state.active_requests.lock().await.remove(&request_id);
    if let Some(active) = active {
        active.abort_handle.abort();
        Ok(true)
    } else {
        Ok(false)
    }
}
