use serde::Serialize;

#[cfg(desktop)]
use tauri::{Emitter, Manager, RunEvent};

mod album;
mod artist;
mod audio_cache;
mod auth;
mod catalog;
mod daily;
mod external;
mod library;
mod lyrics;
mod music_api;
mod music_video;
mod playlist;
mod settings;
#[cfg(target_os = "macos")]
mod touch_bar;
mod track;
mod unblock;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_name: &'static str,
    app_version: &'static str,
    architecture: &'static str,
    operating_system: &'static str,
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_name: "Clarus Music",
        app_version: env!("CARGO_PKG_VERSION"),
        architecture: std::env::consts::ARCH,
        operating_system: std::env::consts::OS,
    }
}

/// Exits the application after the frontend has flushed any pending settings.
/// This is intentionally explicit instead of relying on the close-requested
/// event's automatic destroy path, which is asynchronous on macOS.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_cache_state = audio_cache::AudioCacheState::default();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    // WKWebView otherwise schedules visual updates near 60fps even on a
    // ProMotion display. This is a macOS-only no-op elsewhere.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_fps::init());
    builder
        .manage(audio_cache_state.clone())
        .manage(music_api::MusicApiState::default())
        .manage(settings::SettingsState::default())
        .manage(unblock::UnblockMusicState::default())
        .setup(move |app| {
            audio_cache_state
                .start_stream_server(app.handle())
                .map_err(|error| anyhow::anyhow!("failed to start audio streaming: {error:?}"))?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

                #[cfg(target_os = "macos")]
                use tauri::menu::PredefinedMenuItem;

                #[cfg(target_os = "macos")]
                let clarus_music = {
                    // Keep AppKit-owned window commands native so Command-H and Command-Q
                    // retain their standard behavior and accessibility semantics.
                    let services = PredefinedMenuItem::services(app, None)?;
                    let hide = PredefinedMenuItem::hide(app, None)?;
                    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
                    let show_all = PredefinedMenuItem::show_all(app, None)?;
                    let quit = PredefinedMenuItem::quit(app, None)?;

                    SubmenuBuilder::with_id(app, "menu.clarus-music", "Clarus Music")
                        .item(
                            &MenuItemBuilder::with_id("menu.about", "About Clarus Music")
                                .build(app)?,
                        )
                        .item(&MenuItemBuilder::with_id("menu.settings", "Settings").build(app)?)
                        .separator()
                        .item(&services)
                        .separator()
                        .item(&hide)
                        .item(&hide_others)
                        .item(&show_all)
                        .separator()
                        .item(&quit)
                        .build()?
                };
                #[cfg(not(target_os = "macos"))]
                let clarus_music =
                    SubmenuBuilder::with_id(app, "menu.clarus-music", "Clarus Music")
                        .item(
                            &MenuItemBuilder::with_id("menu.about", "About Clarus Music")
                                .build(app)?,
                        )
                        .item(&MenuItemBuilder::with_id("menu.settings", "Settings").build(app)?)
                        .separator()
                        .item(
                            &MenuItemBuilder::with_id("menu.quit", "Quit Clarus Music")
                                .accelerator("CmdOrCtrl+Q")
                                .build(app)?,
                        )
                        .build()?;

                #[cfg(target_os = "macos")]
                let file = {
                    // Keep Command-W on the same path as Command-H. A native
                    // close-window item would enter the close-confirmation
                    // flow, which makes the shortcut behave differently on
                    // pages such as the lyrics overlay.
                    let hide_window = MenuItemBuilder::with_id("menu.hide-window", "Close Window")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?;
                    SubmenuBuilder::with_id(app, "menu.file", "File")
                        .item(&hide_window)
                        .build()?
                };

                #[cfg(target_os = "macos")]
                let window = {
                    let minimize = PredefinedMenuItem::minimize(app, None)?;
                    SubmenuBuilder::with_id(app, "menu.window", "Window")
                        .item(&minimize)
                        .build()?
                };
                let playback = SubmenuBuilder::with_id(app, "menu.playback", "Playback")
                    .item(
                        &MenuItemBuilder::with_id("menu.play", "Play/Pause")
                            .accelerator("CmdOrCtrl+P")
                            .build(app)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("menu.previous", "Previous")
                            .accelerator("CmdOrCtrl+Left")
                            .build(app)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("menu.next", "Next")
                            .accelerator("CmdOrCtrl+Right")
                            .build(app)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("menu.increase-volume", "Increase Volume")
                            .accelerator("CmdOrCtrl+Up")
                            .build(app)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("menu.decrease-volume", "Decrease Volume")
                            .accelerator("CmdOrCtrl+Down")
                            .build(app)?,
                    )
                    .build()?;
                let menu = MenuBuilder::new(app).item(&clarus_music);
                #[cfg(target_os = "macos")]
                let menu = menu.item(&file);
                let menu = menu.item(&playback);
                #[cfg(target_os = "macos")]
                let menu = menu.item(&window);
                let menu = menu.build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    match event.id().0.as_str() {
                        "menu.quit" => app.exit(0),
                        "menu.hide-window" => {
                            // AppHandle::hide() is the same application-level
                            // operation used by the native Command-H menu.
                            let _ = app.hide();
                        }
                        id => {
                            let _ = app.emit("application-menu-action", id);
                        }
                    }
                });

                #[cfg(target_os = "macos")]
                touch_bar::install(app.handle())?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            exit_app,
            external::open_netease_song,
            external::open_netease_album,
            external::open_netease_artist,
            external::open_netease_music_video,
            settings::load_settings,
            settings::save_settings,
            track::check_song_like,
            track::set_song_like,
            auth::begin_qr_login,
            auth::check_qr_login,
            auth::restore_session,
            auth::logout,
            album::album_detail,
            album::set_album_subscription,
            artist::artist_detail,
            artist::artist_header,
            artist::artist_video_page,
            artist::set_artist_subscription,
            music_video::music_video_detail,
            music_video::set_music_video_subscription,
            catalog::search_overview,
            catalog::search_catalog_page,
            catalog::resolve_stream_url,
            audio_cache::lookup_audio_cache,
            audio_cache::store_audio_cache,
            audio_cache::release_audio_cache_lease,
            audio_cache::audio_cache_stats,
            audio_cache::clear_audio_cache,
            daily::daily_songs,
            library::library_overview,
            library::library_playlist_page,
            library::library_catalog_page,
            library::library_history,
            library::create_library_playlist,
            lyrics::track_lyrics,
            playlist::liked_songs_detail,
            playlist::playlist_detail,
            playlist::playlist_track_page,
            playlist::set_playlist_subscription,
            playlist::update_playlist_name,
            playlist::update_playlist_description,
            playlist::delete_playlist,
            playlist::add_playlist_tracks,
            playlist::remove_playlist_tracks,
            music_api::cancel_music_request
        ])
        // Keep the embedded frontend on the build-script path. Unlike
        // `generate_context!`, this makes Cargo rebuild the executable when
        // Vite changes `frontendDist`, rather than allowing stale renderer
        // assets to be repackaged into a fresh-looking app bundle.
        .build(tauri::tauri_build_context!())
        .expect("error while building Tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
