use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};

const DETAIL_LABEL_PREFIX: &str = "clarus-detail-";
const DETAIL_READY_TIMEOUT: Duration = Duration::from_secs(5);
const DETAIL_CLOSE_DISPATCH_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct DetailSurfaceEntry {
    label: String,
    bounds: DetailSurfaceBounds,
}

#[derive(Default)]
struct DetailSurfaceLifecycle {
    visible: Option<DetailSurfaceEntry>,
    pending: Option<DetailSurfaceEntry>,
    occluded: bool,
}

#[derive(Default)]
pub struct DetailSurfaceState {
    sequence: AtomicU64,
    lifecycle: Mutex<DetailSurfaceLifecycle>,
    closing_labels: Mutex<HashSet<String>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl DetailSurfaceBounds {
    fn validated(self) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 320.0
            || self.height < 320.0
            || self.width > 16_384.0
            || self.height > 16_384.0
        {
            return Err("invalid detail surface bounds".to_owned());
        }
        Ok(self)
    }

    fn rect(self) -> tauri::Rect {
        tauri::Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn validate_detail_route(route: &str) -> Result<(), String> {
    let valid_prefix = ["/artist/", "/album/", "/playlist/", "/mv/"]
        .iter()
        .any(|prefix| route.starts_with(prefix));
    if !valid_prefix
        || route.len() > 256
        || route.contains(['\0', '\n', '\r'])
        || route.contains("..")
    {
        return Err("invalid isolated detail route".to_owned());
    }
    Ok(())
}

fn validate_detail_label(label: &str) -> Result<(), String> {
    let sequence = label.strip_prefix(DETAIL_LABEL_PREFIX).unwrap_or_default();
    if sequence.is_empty()
        || sequence.len() > 20
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid detail surface label".to_owned());
    }
    Ok(())
}

fn validate_theme(theme: &str) -> Result<(), String> {
    if matches!(theme, "light" | "oled") {
        Ok(())
    } else {
        Err("invalid detail surface theme".to_owned())
    }
}

fn detail_initialization_script(
    label: &str,
    route: &str,
    theme: &str,
    auth_session: &serde_json::Value,
) -> Result<String, String> {
    let label = serde_json::to_string(label).map_err(|error| error.to_string())?;
    let route = serde_json::to_string(route).map_err(|error| error.to_string())?;
    let theme = serde_json::to_string(theme).map_err(|error| error.to_string())?;
    Ok(format!(
        "window.__CLARUS_SURFACE__='detail';window.__CLARUS_DETAIL_LABEL__={label};window.__CLARUS_DETAIL_ROUTE__={route};window.__CLARUS_AUTH_SESSION__={auth_session};document.documentElement?.setAttribute('data-theme',{theme});"
    ))
}

#[cfg(target_os = "macos")]
fn close_detail_webview(app: AppHandle, label: String, webview: tauri::Webview) {
    use block2::RcBlock;
    use objc2_foundation::{NSDate, NSSet};
    use objc2_web_kit::{WKWebView, WKWebsiteDataTypeMemoryCache};

    let (native_callback_finished, wait_for_native_callback) = tokio::sync::oneshot::channel();
    let _ = webview.with_webview(move |platform| {
        // The detail surface owns a non-persistent data store. Remove only its
        // in-memory website cache before releasing the WKWebView; cookies,
        // local storage, and the main surface's data store remain untouched.
        unsafe {
            let native: &WKWebView = &*platform.inner().cast();
            let store = native.configuration().websiteDataStore();
            let data_types = NSSet::setWithObject(WKWebsiteDataTypeMemoryCache);
            let since = NSDate::dateWithTimeIntervalSince1970(0.0);
            let completion = RcBlock::new(|| {});
            store.removeDataOfTypes_modifiedSince_completionHandler(
                &data_types,
                &since,
                &completion,
            );
        }
        let _ = native_callback_finished.send(());
    });

    tauri::async_runtime::spawn(async move {
        // `with_webview` executes on the native UI thread. Closing the same
        // WKWebView from inside that callback re-enters Wry's dispatcher while
        // it is still handling the first message and can deadlock WebKit. Wait
        // until the callback has returned (or failed to run), then enqueue the
        // close from the async runtime so every close happens on a fresh event
        // loop turn.
        let _ = tokio::time::timeout(DETAIL_CLOSE_DISPATCH_TIMEOUT, wait_for_native_callback).await;
        tokio::task::yield_now().await;
        let _ = webview.close();
        lock_unpoisoned(&app.state::<DetailSurfaceState>().closing_labels).remove(&label);
    });
}

#[cfg(not(target_os = "macos"))]
fn close_detail_webview(app: AppHandle, label: String, webview: tauri::Webview) {
    tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        let _ = webview.close();
        lock_unpoisoned(&app.state::<DetailSurfaceState>().closing_labels).remove(&label);
    });
}

fn close_detail_label(app: &AppHandle, label: &str) {
    let first_close_request = {
        let state = app.state::<DetailSurfaceState>();
        let inserted = lock_unpoisoned(&state.closing_labels).insert(label.to_owned());
        inserted
    };
    if !first_close_request {
        return;
    }

    if let Some(webview) = app.get_webview(label) {
        close_detail_webview(app.clone(), label.to_owned(), webview);
    } else {
        lock_unpoisoned(&app.state::<DetailSurfaceState>().closing_labels).remove(label);
    }
}

fn close_all_detail_webviews(app: &AppHandle) {
    for label in app.webviews().into_keys() {
        if label.starts_with(DETAIL_LABEL_PREFIX) {
            close_detail_label(app, &label);
        }
    }
}

#[tauri::command]
pub async fn present_detail_surface(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    route: String,
    theme: String,
    bounds: DetailSurfaceBounds,
    auth_session: serde_json::Value,
) -> Result<String, String> {
    validate_detail_route(&route)?;
    validate_theme(&theme)?;
    let bounds = bounds.validated()?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let sequence = state.sequence.fetch_add(1, Ordering::AcqRel) + 1;
    let label = format!("{DETAIL_LABEL_PREFIX}{sequence}");
    let entry = DetailSurfaceEntry {
        label: label.clone(),
        bounds,
    };
    let stale_pending = {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle.occluded {
            return Err("detail surface is occluded".to_owned());
        }
        lifecycle.pending.replace(entry)
    };
    if let Some(stale) = stale_pending {
        close_detail_label(&app, &stale.label);
    }

    let app_for_load = app.clone();
    let label_for_load = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::App("index.html".into()))
        .incognito(true)
        .initialization_script(detail_initialization_script(
            &label,
            &route,
            &theme,
            &auth_session,
        )?)
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished || webview.label() != label_for_load {
                return;
            }
            let retained = {
                let state = app_for_load.state::<DetailSurfaceState>();
                let lifecycle = lock_unpoisoned(&state.lifecycle);
                lifecycle
                    .pending
                    .as_ref()
                    .is_some_and(|entry| entry.label == label_for_load)
                    || lifecycle
                        .visible
                        .as_ref()
                        .is_some_and(|entry| entry.label == label_for_load)
            };
            if !retained {
                close_detail_label(&app_for_load, &label_for_load);
            }
        });

    if let Err(error) = window.add_child(
        builder,
        LogicalPosition::new(-10_000.0, -10_000.0),
        LogicalSize::new(bounds.width, bounds.height),
    ) {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle
            .pending
            .as_ref()
            .is_some_and(|entry| entry.label == label)
        {
            lifecycle.pending = None;
        }
        return Err(format!("failed to create detail surface: {error}"));
    }

    let app_for_timeout = app.clone();
    let label_for_timeout = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DETAIL_READY_TIMEOUT).await;
        let expired = {
            let state = app_for_timeout.state::<DetailSurfaceState>();
            let mut lifecycle = lock_unpoisoned(&state.lifecycle);
            if lifecycle
                .pending
                .as_ref()
                .is_some_and(|entry| entry.label == label_for_timeout)
            {
                lifecycle.pending.take()
            } else {
                None
            }
        };
        if let Some(expired) = expired {
            close_detail_label(&app_for_timeout, &expired.label);
        }
    });

    Ok(label)
}

#[tauri::command]
pub fn detail_surface_ready(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    label: String,
) -> Result<bool, String> {
    validate_detail_label(&label)?;
    let Some(webview) = app.get_webview(&label) else {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle
            .pending
            .as_ref()
            .is_some_and(|entry| entry.label == label)
        {
            lifecycle.pending = None;
        }
        return Ok(false);
    };

    let (candidate, previous_visible) = {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle.occluded
            || !lifecycle
                .pending
                .as_ref()
                .is_some_and(|entry| entry.label == label)
        {
            return Ok(false);
        }
        let candidate = lifecycle
            .pending
            .take()
            .expect("pending label was checked above");
        let previous_visible = lifecycle.visible.replace(candidate.clone());
        (candidate, previous_visible)
    };

    if let Err(error) = webview
        .set_bounds(candidate.bounds.rect())
        .and_then(|()| webview.show())
    {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle
            .visible
            .as_ref()
            .is_some_and(|entry| entry.label == label)
        {
            lifecycle.visible = previous_visible;
        }
        drop(lifecycle);
        close_detail_label(&app, &label);
        return Err(format!("failed to reveal detail surface: {error}"));
    }

    if let Some(previous) = previous_visible {
        close_detail_label(&app, &previous.label);
    }

    #[derive(Clone, Copy)]
    enum ReadyDisposition {
        Keep,
        Hide,
        Close,
    }
    let disposition = {
        let lifecycle = lock_unpoisoned(&state.lifecycle);
        if !lifecycle
            .visible
            .as_ref()
            .is_some_and(|entry| entry.label == label)
        {
            ReadyDisposition::Close
        } else if lifecycle.occluded {
            ReadyDisposition::Hide
        } else {
            ReadyDisposition::Keep
        }
    };
    match disposition {
        ReadyDisposition::Keep => {}
        ReadyDisposition::Hide => {
            let _ = webview.hide();
        }
        ReadyDisposition::Close => close_detail_label(&app, &label),
    }
    Ok(matches!(disposition, ReadyDisposition::Keep))
}

#[tauri::command]
pub fn resize_detail_surface(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    bounds: DetailSurfaceBounds,
) -> Result<bool, String> {
    let bounds = bounds.validated()?;
    let (visible_label, pending_label) = {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        let visible_label = lifecycle.visible.as_mut().map(|entry| {
            entry.bounds = bounds;
            entry.label.clone()
        });
        let pending_label = lifecycle.pending.as_mut().map(|entry| {
            entry.bounds = bounds;
            entry.label.clone()
        });
        (visible_label, pending_label)
    };

    if let Some(label) = visible_label.as_deref() {
        if let Some(webview) = app.get_webview(label) {
            webview
                .set_bounds(bounds.rect())
                .map_err(|error| format!("failed to resize detail surface: {error}"))?;
        }
    }
    if let Some(label) = pending_label.as_deref() {
        if let Some(webview) = app.get_webview(label) {
            webview
                .set_size(LogicalSize::new(bounds.width, bounds.height))
                .map_err(|error| format!("failed to resize pending detail surface: {error}"))?;
        }
    }
    Ok(visible_label.is_some() || pending_label.is_some())
}

#[tauri::command]
pub fn hide_detail_surface(app: AppHandle, state: State<'_, DetailSurfaceState>) -> bool {
    let (visible_label, stale_pending) = {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        lifecycle.occluded = true;
        (
            lifecycle.visible.as_ref().map(|entry| entry.label.clone()),
            lifecycle.pending.take(),
        )
    };
    if let Some(stale) = stale_pending {
        close_detail_label(&app, &stale.label);
    }
    let Some(label) = visible_label else {
        return false;
    };
    app.get_webview(&label)
        .is_some_and(|webview| webview.hide().is_ok())
}

#[tauri::command]
pub fn show_detail_surface(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    bounds: DetailSurfaceBounds,
) -> Result<bool, String> {
    let bounds = bounds.validated()?;
    let visible_label = {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        lifecycle.occluded = false;
        lifecycle.visible.as_mut().map(|entry| {
            entry.bounds = bounds;
            entry.label.clone()
        })
    };
    let Some(label) = visible_label else {
        return Ok(false);
    };
    let Some(webview) = app.get_webview(&label) else {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        if lifecycle
            .visible
            .as_ref()
            .is_some_and(|entry| entry.label == label)
        {
            lifecycle.visible = None;
        }
        return Ok(false);
    };
    webview
        .set_bounds(bounds.rect())
        .and_then(|()| webview.show())
        .map_err(|error| format!("failed to restore detail surface: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub fn dismiss_detail_surface(app: AppHandle, state: State<'_, DetailSurfaceState>) -> bool {
    state.sequence.fetch_add(1, Ordering::AcqRel);
    {
        let mut lifecycle = lock_unpoisoned(&state.lifecycle);
        lifecycle.visible = None;
        lifecycle.pending = None;
    }
    close_all_detail_webviews(&app);
    true
}
