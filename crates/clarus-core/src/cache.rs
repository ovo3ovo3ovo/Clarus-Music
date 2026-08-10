use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime},
};

use reqwest::Client;
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};

use crate::{
    cancellation::{cancelable, RequestCancellation},
    CoreError, StreamSource,
};

/// A conservative on-disk cache limit. Audio bytes are deliberately never kept
/// in the application state or in memory after a download finishes.
pub const DEFAULT_AUDIO_CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TRACK_BYTES: u64 = 1024 * 1024 * 1024;
const CACHE_DIRECTORY: &str = "audio-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedAudio {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub cache_hit: bool,
}

#[derive(Clone)]
pub struct AudioCache {
    inner: Arc<AudioCacheInner>,
}

struct AudioCacheInner {
    root: PathBuf,
    limit_bytes: u64,
    client: Client,
    download_lock: Mutex<()>,
    nonce: AtomicU64,
    initial_trim_done: AtomicBool,
}

/// Ensures cancellation never publishes or permanently leaves a partial file.
/// A failed best-effort removal on Windows is handled by the stale-partial sweep
/// on the next cache request.
struct PartialFile {
    path: PathBuf,
    published: bool,
}

impl PartialFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    fn publish(&mut self) {
        self.published = true;
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Default for AudioCache {
    fn default() -> Self {
        Self::new(DEFAULT_AUDIO_CACHE_LIMIT_BYTES)
    }
}

impl AudioCache {
    pub fn new(limit_bytes: u64) -> Self {
        Self::at(default_cache_root(), limit_bytes)
    }

    pub fn at(root: PathBuf, limit_bytes: u64) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("ClarusMusic/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the audio cache HTTP client configuration must be valid");
        Self {
            inner: Arc::new(AudioCacheInner {
                root,
                limit_bytes: limit_bytes.clamp(16 * 1024 * 1024, MAX_TRACK_BYTES),
                client,
                download_lock: Mutex::new(()),
                nonce: AtomicU64::new(1),
                initial_trim_done: AtomicBool::new(false),
            }),
        }
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub async fn fetch(
        &self,
        track_id: i64,
        source: &StreamSource,
    ) -> Result<CachedAudio, CoreError> {
        self.fetch_cancellable(track_id, source, &RequestCancellation::new())
            .await
    }

    pub async fn fetch_cancellable(
        &self,
        track_id: i64,
        source: &StreamSource,
        cancellation: &RequestCancellation,
    ) -> Result<CachedAudio, CoreError> {
        cancelable(cancellation, self.fetch_uncancellable(track_id, source)).await
    }

    async fn fetch_uncancellable(
        &self,
        track_id: i64,
        source: &StreamSource,
    ) -> Result<CachedAudio, CoreError> {
        if track_id <= 0 || source.url.is_empty() {
            return Err(CoreError::Invalid(
                "audio cache requires a positive track id and a stream URL".into(),
            ));
        }
        if source.size_bytes > MAX_TRACK_BYTES || source.size_bytes > self.inner.limit_bytes {
            return Err(CoreError::Cache(
                "the audio source exceeds the configured cache limit".into(),
            ));
        }

        let _download = self.inner.download_lock.lock().await;
        fs::create_dir_all(&self.inner.root)
            .await
            .map_err(|error| cache_io("create the cache directory", error))?;
        cleanup_stale_partials(&self.inner.root).await;
        let destination = self.destination_path(track_id, &source.level);
        if self
            .inner
            .initial_trim_done
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            // A previous process may have been interrupted after publishing a
            // file but before its post-download trim. Do this scan once per
            // process, then keep the hot cache-hit path free of directory I/O.
            self.trim(&destination).await;
        }
        if let Some(hit) = cached_file(&destination).await? {
            touch_file(&destination).await;
            return Ok(hit);
        }

        let response = self
            .inner
            .client
            .get(&source.url)
            .send()
            .await
            .map_err(|error| CoreError::Network(format!("failed to download audio: {error}")))?
            .error_for_status()
            .map_err(|error| CoreError::Network(format!("audio download was rejected: {error}")))?;
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_TRACK_BYTES || bytes > self.inner.limit_bytes)
        {
            return Err(CoreError::Cache(
                "the audio response exceeds the per-track cache limit".into(),
            ));
        }

        let temporary = temporary_path(
            &destination,
            self.inner.nonce.fetch_add(1, Ordering::Relaxed),
        );
        let mut partial = PartialFile::new(temporary.clone());
        let download = async {
            let mut file = fs::File::create(&temporary)
                .await
                .map_err(|error| cache_io("create a temporary audio file", error))?;
            let mut response = response;
            let mut written = 0_u64;
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                CoreError::Network(format!("audio download interrupted: {error}"))
            })? {
                written = written.saturating_add(chunk.len() as u64);
                if written > MAX_TRACK_BYTES || written > self.inner.limit_bytes {
                    return Err(CoreError::Cache(
                        "the audio download exceeds the configured cache limit".into(),
                    ));
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| cache_io("write an audio cache entry", error))?;
            }
            file.flush()
                .await
                .map_err(|error| cache_io("flush an audio cache entry", error))?;
            if written == 0 {
                return Err(CoreError::Network(
                    "the audio source returned no data".into(),
                ));
            }
            Ok(written)
        }
        .await;

        let written = match download {
            Ok(written) => written,
            Err(error) => return Err(error),
        };
        fs::rename(&temporary, &destination)
            .await
            .map_err(|error| cache_io("publish an audio cache entry", error))?;
        partial.publish();
        self.trim(&destination).await;
        Ok(CachedAudio {
            path: destination,
            size_bytes: written,
            cache_hit: false,
        })
    }

    fn destination_path(&self, track_id: i64, level: &str) -> PathBuf {
        let level = level
            .chars()
            .filter(|character| {
                character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
            })
            .take(32)
            .collect::<String>();
        self.inner.root.join(format!(
            "{track_id}-{}.audio",
            if level.is_empty() { "default" } else { &level }
        ))
    }

    async fn trim(&self, retained: &Path) {
        let root = self.inner.root.clone();
        let retained = retained.to_path_buf();
        let limit = self.inner.limit_bytes;
        let _ = tokio::task::spawn_blocking(move || trim_blocking(&root, &retained, limit)).await;
    }
}

async fn cached_file(path: &Path) -> Result<Option<CachedAudio>, CoreError> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Ok(Some(CachedAudio {
            path: path.to_path_buf(),
            size_bytes: metadata.len(),
            cache_hit: true,
        })),
        Ok(_) => {
            let _ = fs::remove_file(path).await;
            Ok(None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(cache_io("inspect an audio cache entry", error)),
    }
}

async fn touch_file(path: &Path) {
    let path = path.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))
    })
    .await;
}

async fn cleanup_stale_partials(root: &Path) {
    let Ok(mut entries) = fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if !name.to_string_lossy().contains(".part-") {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(15 * 60));
        if stale {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
}

fn temporary_path(destination: &Path, nonce: u64) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".part-{}-{nonce}", std::process::id()));
    destination.with_file_name(name)
}

fn default_cache_root() -> PathBuf {
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
        .join(CACHE_DIRECTORY)
}

fn trim_blocking(root: &Path, retained: &Path, limit: u64) -> std::io::Result<()> {
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("audio") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        total = total.saturating_add(metadata.len());
        entries.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            path,
            metadata.len(),
        ));
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, bytes) in entries {
        if total <= limit {
            break;
        }
        if path == retained {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
    Ok(())
}

fn cache_io(action: &str, error: std::io::Error) -> CoreError {
    CoreError::Cache(format!("failed to {action}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        path::Path,
        thread,
    };

    use crate::{CoreError, RequestCancellation, StreamSource};

    use super::{temporary_path, trim_blocking, AudioCache};

    #[test]
    fn cache_paths_do_not_include_untrusted_quality_characters() {
        let cache = AudioCache::at(
            std::env::temp_dir().join("clarus-cache-path-test"),
            64 * 1024 * 1024,
        );
        let path = cache.destination_path(42, "lossless/../../bad");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("42-losslessbad.audio")
        );
    }

    #[test]
    fn temporary_paths_stay_next_to_the_destination() {
        let destination = Path::new("/tmp/track.audio");
        let temporary = temporary_path(destination, 1);
        assert_eq!(temporary.parent(), destination.parent());
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".part-"));
    }

    #[test]
    fn cache_trim_keeps_total_audio_bytes_under_the_limit() {
        let root = std::env::temp_dir().join(format!(
            "clarus-core-cache-trim-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let retained = root.join("retained.audio");
        for name in ["old-a.audio", "old-b.audio", "retained.audio"] {
            let path = root.join(name);
            std::fs::File::create(path)
                .unwrap()
                .set_len(8 * 1024 * 1024)
                .unwrap();
        }

        trim_blocking(&root, &retained, 16 * 1024 * 1024).unwrap();

        let total = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        assert!(total <= 16 * 1024 * 1024);
        assert!(retained.is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn completed_downloads_are_reused_from_disk() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nRIFF")
                .unwrap();
        });
        let root = std::env::temp_dir().join(format!(
            "clarus-core-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = AudioCache::at(root.clone(), 16 * 1024 * 1024);
        let source = StreamSource {
            url: format!("http://{address}/track"),
            mime_type: "audio/wav".to_string(),
            bitrate: 0,
            size_bytes: 4,
            duration_ms: 0,
            level: "standard".to_string(),
        };
        let first = cache.fetch(1, &source).await.unwrap();
        assert!(!first.cache_hit);
        assert_eq!(first.size_bytes, 4);
        server.join().unwrap();
        let second = cache.fetch(1, &source).await.unwrap();
        assert!(second.cache_hit);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_fetch_does_not_create_cache_state() {
        let root = std::env::temp_dir().join(format!(
            "clarus-core-cancelled-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = AudioCache::at(root.clone(), 16 * 1024 * 1024);
        let source = StreamSource {
            url: "http://127.0.0.1:1/never-requested".to_string(),
            mime_type: "audio/mpeg".to_string(),
            bitrate: 0,
            size_bytes: 0,
            duration_ms: 0,
            level: "standard".to_string(),
        };
        let cancellation = RequestCancellation::new();
        cancellation.cancel();

        let result = cache.fetch_cancellable(1, &source, &cancellation).await;
        assert_eq!(result, Err(CoreError::Cancelled));
        assert!(!root.exists());
    }
}
