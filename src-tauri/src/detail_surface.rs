use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, MutexGuard,
};

use serde::Deserialize;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};

const DETAIL_LABEL_PREFIX: &str = "clarus-detail-";

#[derive(Default)]
pub struct DetailSurfaceState {
    sequence: AtomicU64,
    active_label: Mutex<Option<String>>,
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

fn detail_initialization_script(
    route: &str,
    auth_session: &serde_json::Value,
) -> Result<String, String> {
    let route = serde_json::to_string(route).map_err(|error| error.to_string())?;
    Ok(format!(
        "window.__CLARUS_SURFACE__='detail';window.__CLARUS_DETAIL_ROUTE__={route};window.__CLARUS_AUTH_SESSION__={auth_session};"
    ))
}

fn close_detail_webviews(app: &AppHandle, except: Option<&str>) {
    for (label, webview) in app.webviews() {
        if label.starts_with(DETAIL_LABEL_PREFIX) && except != Some(label.as_str()) {
            let _ = webview.close();
        }
    }
}

#[tauri::command]
pub async fn present_detail_surface(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    route: String,
    bounds: DetailSurfaceBounds,
    auth_session: serde_json::Value,
) -> Result<String, String> {
    validate_detail_route(&route)?;
    let bounds = bounds.validated()?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let sequence = state.sequence.fetch_add(1, Ordering::AcqRel) + 1;
    let label = format!("{DETAIL_LABEL_PREFIX}{sequence}");
    let previous_label = {
        let mut active_label = lock_unpoisoned(&state.active_label);
        active_label.replace(label.clone())
    };
    let app_for_load = app.clone();
    let label_for_load = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::App("index.html".into()))
        .incognito(true)
        .initialization_script(detail_initialization_script(&route, &auth_session)?)
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished || webview.label() != label_for_load {
                return;
            }
            let state = app_for_load.state::<DetailSurfaceState>();
            let active_label = lock_unpoisoned(&state.active_label);
            if active_label.as_deref() != Some(label_for_load.as_str()) {
                drop(active_label);
                let _ = webview.close();
                return;
            }
            let _ = webview.set_bounds(tauri::Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(bounds.width, bounds.height).into(),
            });
            let _ = webview.show();
            close_detail_webviews(&app_for_load, Some(&label_for_load));
        });

    if let Err(error) = window.add_child(
        builder,
        LogicalPosition::new(-10_000.0, -10_000.0),
        LogicalSize::new(1.0, 1.0),
    ) {
        let mut active_label = lock_unpoisoned(&state.active_label);
        if active_label.as_deref() == Some(label.as_str()) {
            *active_label = previous_label;
        }
        return Err(format!("failed to create detail surface: {error}"));
    }
    Ok(label)
}

#[tauri::command]
pub fn resize_detail_surface(
    app: AppHandle,
    state: State<'_, DetailSurfaceState>,
    bounds: DetailSurfaceBounds,
) -> Result<bool, String> {
    let bounds = bounds.validated()?;
    let Some(label) = lock_unpoisoned(&state.active_label).clone() else {
        return Ok(false);
    };
    let Some(webview) = app.get_webview(&label) else {
        return Ok(false);
    };
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| format!("failed to resize detail surface: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub fn dismiss_detail_surface(app: AppHandle, state: State<'_, DetailSurfaceState>) -> bool {
    state.sequence.fetch_add(1, Ordering::AcqRel);
    *lock_unpoisoned(&state.active_label) = None;
    close_detail_webviews(&app, None);
    true
}
