use tauri::{AppHandle, Manager, State};

/// One process-wide cleanup operation is shared by all overlapping invokes.
/// Keeping this state native prevents a rapid route burst from queuing many
/// WKWebsiteDataStore operations at the same time.
#[derive(Default)]
pub struct WebKitMemoryCacheState {
    #[cfg(target_os = "macos")]
    in_flight: std::sync::Arc<std::sync::Mutex<Option<std::sync::Arc<CleanupTask>>>>,
}

/// Clears only `WKWebsiteDataTypeMemoryCache` for the active WKWebView's
/// website data store. This never modifies DOM nodes, persistent website data,
/// cookies, or the disk cache.
#[tauri::command]
pub async fn clear_webkit_memory_cache(
    app: AppHandle,
    state: State<'_, WebKitMemoryCacheState>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(clear_macos_webkit_memory_cache(app, state).await);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDate, NSSet};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKWebView, WKWebsiteDataTypeMemoryCache};

#[cfg(target_os = "macos")]
const MEMORY_CACHE_CLEAR_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
struct CleanupTask {
    result: Mutex<Option<bool>>,
    completed: tokio::sync::Notify,
}

#[cfg(target_os = "macos")]
impl CleanupTask {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            completed: tokio::sync::Notify::new(),
        }
    }

    fn finish(&self, result: bool) {
        let mut stored = lock_unpoisoned(&self.result);
        if stored.is_some() {
            return;
        }
        *stored = Some(result);
        drop(stored);
        self.completed.notify_waiters();
    }

    async fn wait(&self) -> bool {
        loop {
            // Register before inspecting the result so a completion between
            // these two operations cannot leave this caller waiting forever.
            let notified = self.completed.notified();
            if let Some(result) = *lock_unpoisoned(&self.result) {
                return result;
            }
            notified.await;
        }
    }
}

#[cfg(target_os = "macos")]
fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "macos")]
async fn clear_macos_webkit_memory_cache(
    app: AppHandle,
    state: State<'_, WebKitMemoryCacheState>,
) -> bool {
    let (task, should_start) = {
        let mut in_flight = lock_unpoisoned(&state.in_flight);
        if let Some(task) = in_flight.as_ref() {
            (Arc::clone(task), false)
        } else {
            let task = Arc::new(CleanupTask::new());
            *in_flight = Some(Arc::clone(&task));
            (task, true)
        }
    };

    if should_start {
        let in_flight = Arc::clone(&state.in_flight);
        let task_for_operation = Arc::clone(&task);
        tauri::async_runtime::spawn(async move {
            let result = clear_active_webview_memory_cache(app).await;
            task_for_operation.finish(result);

            let mut current = lock_unpoisoned(&in_flight);
            if current
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &task_for_operation))
            {
                *current = None;
            }
        });
    }

    task.wait().await
}

#[cfg(target_os = "macos")]
async fn clear_active_webview_memory_cache(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
    let completion_sender = Arc::new(Mutex::new(Some(sender)));

    let scheduled = window.with_webview(move |webview| {
        let completion_sender = Arc::clone(&completion_sender);
        let raw_webview = webview.inner();
        if raw_webview.is_null() {
            send_completion(&completion_sender, false);
            return;
        }

        // SAFETY: Tauri documents PlatformWebview::inner() as a WKWebView
        // pointer on macOS. `with_webview` executes on the app main thread,
        // which is WebKit's required thread for this API.
        unsafe {
            let webview = &*raw_webview.cast::<WKWebView>();
            let store = webview.configuration().websiteDataStore();
            let data_types = NSSet::from_slice(&[WKWebsiteDataTypeMemoryCache]);
            let modified_since = NSDate::dateWithTimeIntervalSince1970(0.0);
            let completion = RcBlock::new(move || {
                send_completion(&completion_sender, true);
            });
            store.removeDataOfTypes_modifiedSince_completionHandler(
                &data_types,
                &modified_since,
                &completion,
            );
        }
    });

    if scheduled.is_err() {
        return false;
    }

    matches!(
        tokio::time::timeout(MEMORY_CACHE_CLEAR_TIMEOUT, receiver).await,
        Ok(Ok(true))
    )
}

#[cfg(target_os = "macos")]
fn send_completion(sender: &Arc<Mutex<Option<tokio::sync::oneshot::Sender<bool>>>>, value: bool) {
    let Some(sender) = lock_unpoisoned(sender).take() else {
        return;
    };
    let _ = sender.send(value);
}
