use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use atomic_write_file::AtomicWriteFile;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

const SCENARIO_NAME: &str = "artist-dfs-v1";
const MAX_REPORT_BYTES: usize = 512 * 1024;
const START_SIGNAL_CONTENTS: &[u8] = b"start\n";
const START_SIGNAL_TIMEOUT: Duration = Duration::from_secs(180);
const START_SIGNAL_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MIN_RECOVERY_SECONDS: u16 = 600;
const MAX_RECOVERY_SECONDS: u16 = 900;

#[derive(Clone)]
struct ActivePerformanceConfig {
    iterations: u16,
    recovery_seconds: u16,
    audio_url: String,
    audio_mime_type: String,
    audio_size_bytes: u64,
    report_path: PathBuf,
    start_signal_path: PathBuf,
}

pub struct PerformanceState {
    active: Option<ActivePerformanceConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceConfig {
    enabled: bool,
    scenario: Option<&'static str>,
    iterations: u16,
    recovery_seconds: u16,
    audio_url: Option<String>,
    audio_mime_type: Option<String>,
    audio_size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceFailure {
    kind: &'static str,
    message: String,
}

impl PerformanceFailure {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid-performance-config",
            message: message.into(),
        }
    }

    fn io(action: &str, error: std::io::Error) -> Self {
        Self {
            kind: "io",
            message: format!("Failed to {action} the performance report: {error}"),
        }
    }

    fn signal_io(action: &str, error: std::io::Error) -> Self {
        Self {
            kind: "io",
            message: format!("Failed to {action} the performance start signal: {error}"),
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self {
            kind: "timeout",
            message: message.into(),
        }
    }
}

fn bounded_environment_u16(
    name: &str,
    default: u16,
    minimum: u16,
    maximum: u16,
) -> Result<u16, PerformanceFailure> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u16>()
            .ok()
            .filter(|value| (*value >= minimum) && (*value <= maximum))
            .ok_or_else(|| {
                PerformanceFailure::invalid(format!("{name} is outside its supported range"))
            }),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(PerformanceFailure::invalid(format!(
            "{name} is invalid: {error}"
        ))),
    }
}

fn validate_audio_url(value: String) -> Result<String, PerformanceFailure> {
    let url = url::Url::parse(&value)
        .map_err(|_| PerformanceFailure::invalid("CLARUS_PERF_AUDIO_URL is not a URL"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_AUDIO_URL must use an explicit 127.0.0.1 HTTP port",
        ));
    }
    Ok(value)
}

fn validate_audio_mime_type(value: String) -> Result<String, PerformanceFailure> {
    if value != "audio/mpeg" {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_AUDIO_MIME must be audio/mpeg",
        ));
    }
    Ok(value)
}

fn validate_report_path(value: String) -> Result<PathBuf, PerformanceFailure> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_REPORT must be an absolute JSON path",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| PerformanceFailure::invalid("CLARUS_PERF_REPORT has no parent"))?;
    let metadata = std::fs::symlink_metadata(parent)
        .map_err(|error| PerformanceFailure::io("inspect the parent of", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_REPORT parent must be a real directory",
        ));
    }
    Ok(path)
}

fn validate_start_signal_path(value: String) -> Result<PathBuf, PerformanceFailure> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("signal") {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_START_SIGNAL must be an absolute .signal path",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| PerformanceFailure::invalid("CLARUS_PERF_START_SIGNAL has no parent"))?;
    let metadata = std::fs::symlink_metadata(parent)
        .map_err(|error| PerformanceFailure::signal_io("inspect the parent of", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PerformanceFailure::invalid(
            "CLARUS_PERF_START_SIGNAL parent must be a real directory",
        ));
    }
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(PerformanceFailure::signal_io("inspect", error)),
        Ok(_) => Err(PerformanceFailure::invalid(
            "CLARUS_PERF_START_SIGNAL must not exist at launch",
        )),
    }
}

impl PerformanceState {
    pub fn from_environment() -> Result<Self, PerformanceFailure> {
        let scenario = match std::env::var("CLARUS_PERF_SCENARIO") {
            Err(std::env::VarError::NotPresent) => return Ok(Self { active: None }),
            Ok(value) if value == SCENARIO_NAME => value,
            Ok(_) => {
                return Err(PerformanceFailure::invalid(
                    "CLARUS_PERF_SCENARIO is unsupported",
                ))
            }
            Err(error) => {
                return Err(PerformanceFailure::invalid(format!(
                    "CLARUS_PERF_SCENARIO is invalid: {error}"
                )))
            }
        };
        debug_assert_eq!(scenario, SCENARIO_NAME);
        let iterations = bounded_environment_u16("CLARUS_PERF_ITERATIONS", 50, 50, 100)?;
        let recovery_seconds = bounded_environment_u16(
            "CLARUS_PERF_RECOVERY_SECONDS",
            MIN_RECOVERY_SECONDS,
            MIN_RECOVERY_SECONDS,
            MAX_RECOVERY_SECONDS,
        )?;
        let audio_url = validate_audio_url(
            std::env::var("CLARUS_PERF_AUDIO_URL")
                .map_err(|_| PerformanceFailure::invalid("CLARUS_PERF_AUDIO_URL is required"))?,
        )?;
        let audio_mime_type = validate_audio_mime_type(
            std::env::var("CLARUS_PERF_AUDIO_MIME").unwrap_or_else(|_| "audio/mpeg".to_string()),
        )?;
        let audio_size_bytes = match std::env::var("CLARUS_PERF_AUDIO_SIZE_BYTES") {
            Ok(value) => value
                .parse::<u64>()
                .ok()
                .filter(|size| *size > 0)
                .ok_or_else(|| {
                    PerformanceFailure::invalid(
                        "CLARUS_PERF_AUDIO_SIZE_BYTES must be a positive integer",
                    )
                })?,
            Err(std::env::VarError::NotPresent) => 1,
            Err(error) => {
                return Err(PerformanceFailure::invalid(format!(
                    "CLARUS_PERF_AUDIO_SIZE_BYTES is invalid: {error}"
                )))
            }
        };
        let report_path = validate_report_path(
            std::env::var("CLARUS_PERF_REPORT")
                .map_err(|_| PerformanceFailure::invalid("CLARUS_PERF_REPORT is required"))?,
        )?;
        let start_signal_path = validate_start_signal_path(
            std::env::var("CLARUS_PERF_START_SIGNAL")
                .map_err(|_| PerformanceFailure::invalid("CLARUS_PERF_START_SIGNAL is required"))?,
        )?;
        if report_path.parent() != start_signal_path.parent() {
            return Err(PerformanceFailure::invalid(
                "performance report and start signal must share one directory",
            ));
        }
        Ok(Self {
            active: Some(ActivePerformanceConfig {
                iterations,
                recovery_seconds,
                audio_url,
                audio_mime_type,
                audio_size_bytes,
                report_path,
                start_signal_path,
            }),
        })
    }

    pub(crate) fn artist_fixtures_enabled(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn audio_fixture(&self) -> Option<(String, String, u64)> {
        self.active.as_ref().map(|active| {
            (
                active.audio_url.clone(),
                active.audio_mime_type.clone(),
                active.audio_size_bytes,
            )
        })
    }

    pub(crate) fn image_fixture_url(&self, path: &str) -> Option<String> {
        let active = self.active.as_ref()?;
        let mut url = url::Url::parse(&active.audio_url).ok()?;
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        Some(url.to_string())
    }

    fn public_config(&self) -> PerformanceConfig {
        match &self.active {
            Some(active) => PerformanceConfig {
                enabled: true,
                scenario: Some(SCENARIO_NAME),
                iterations: active.iterations,
                recovery_seconds: active.recovery_seconds,
                audio_url: Some(active.audio_url.clone()),
                audio_mime_type: Some(active.audio_mime_type.clone()),
                audio_size_bytes: Some(active.audio_size_bytes),
            },
            None => PerformanceConfig {
                enabled: false,
                scenario: None,
                iterations: 0,
                recovery_seconds: 0,
                audio_url: None,
                audio_mime_type: None,
                audio_size_bytes: None,
            },
        }
    }

    fn report_path(&self) -> Result<&Path, PerformanceFailure> {
        self.active
            .as_ref()
            .map(|active| active.report_path.as_path())
            .ok_or_else(|| PerformanceFailure::invalid("performance mode is disabled"))
    }

    fn start_signal_path(&self) -> Result<&Path, PerformanceFailure> {
        self.active
            .as_ref()
            .map(|active| active.start_signal_path.as_path())
            .ok_or_else(|| PerformanceFailure::invalid("performance mode is disabled"))
    }
}

#[tauri::command]
pub fn performance_config(state: State<'_, PerformanceState>) -> PerformanceConfig {
    state.public_config()
}

#[tauri::command]
pub async fn performance_wait_for_start(
    state: State<'_, PerformanceState>,
) -> Result<(), PerformanceFailure> {
    let path = state.start_signal_path()?.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + START_SIGNAL_TIMEOUT;
        loop {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(PerformanceFailure::invalid(
                            "performance start signal must be a regular non-symlink file",
                        ));
                    }
                    if metadata.len() > START_SIGNAL_CONTENTS.len() as u64 {
                        return Err(PerformanceFailure::invalid(
                            "performance start signal has invalid contents",
                        ));
                    }
                    let contents = std::fs::read(&path)
                        .map_err(|error| PerformanceFailure::signal_io("read", error))?;
                    if contents != START_SIGNAL_CONTENTS {
                        return Err(PerformanceFailure::invalid(
                            "performance start signal has invalid contents",
                        ));
                    }
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if Instant::now() >= deadline {
                        return Err(PerformanceFailure::timeout(
                            "Timed out waiting for the performance start signal",
                        ));
                    }
                    std::thread::sleep(START_SIGNAL_POLL_INTERVAL);
                }
                Err(error) => {
                    return Err(PerformanceFailure::signal_io("inspect", error));
                }
            }
        }
    })
    .await
    .map_err(|error| PerformanceFailure {
        kind: "task-failed",
        message: format!("Performance start waiter failed: {error}"),
    })?
}

#[tauri::command]
pub async fn performance_checkpoint(
    report: Value,
    state: State<'_, PerformanceState>,
) -> Result<(), PerformanceFailure> {
    if !report.is_object() {
        return Err(PerformanceFailure::invalid(
            "performance checkpoint must be an object",
        ));
    }
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| PerformanceFailure {
        kind: "serialization",
        message: format!("Failed to serialize the performance report: {error}"),
    })?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(PerformanceFailure::invalid(
            "performance checkpoint exceeded its size limit",
        ));
    }
    let path = state.report_path()?.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut file =
            AtomicWriteFile::open(&path).map_err(|error| PerformanceFailure::io("open", error))?;
        file.write_all(&bytes)
            .map_err(|error| PerformanceFailure::io("write", error))?;
        file.commit()
            .map_err(|error| PerformanceFailure::io("atomically replace", error))
    })
    .await
    .map_err(|error| PerformanceFailure {
        kind: "task-failed",
        message: format!("Performance report writer failed: {error}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::{validate_audio_url, validate_start_signal_path};

    #[test]
    fn performance_audio_is_strictly_loopback() {
        assert!(validate_audio_url("http://127.0.0.1:43123/tone.mp3".to_string()).is_ok());
        assert!(validate_audio_url("https://127.0.0.1:43123/tone.mp3".to_string()).is_err());
        assert!(validate_audio_url("http://localhost:43123/tone.mp3".to_string()).is_err());
        assert!(validate_audio_url("http://127.0.0.1/tone.mp3".to_string()).is_err());
    }

    #[test]
    fn performance_start_signal_must_be_new_and_scoped_to_a_real_parent() {
        let directory = tempfile::tempdir().expect("temporary performance directory");
        let signal = directory.path().join("start.signal");
        assert!(validate_start_signal_path(signal.to_string_lossy().into_owned()).is_ok());

        std::fs::write(&signal, b"start\n").expect("create start signal");
        assert!(validate_start_signal_path(signal.to_string_lossy().into_owned()).is_err());
        assert!(validate_start_signal_path(
            directory
                .path()
                .join("start.txt")
                .to_string_lossy()
                .into_owned()
        )
        .is_err());
    }
}
