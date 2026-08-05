use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use atomic_write_file::AtomicWriteFile;
use futures_util::{Stream, StreamExt};
use reqwest::{header::CONTENT_LENGTH, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Response, AppHandle, Manager, State};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{Mutex, Semaphore},
};

use crate::music_api::{ApiFailure, MusicApiState};

const CACHE_DIRECTORY_NAME: &str = "audio-v1";
const INDEX_FILE_NAME: &str = "index.json";
const INDEX_SCHEMA_VERSION: u16 = 1;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const MAX_DIRECTORY_ENTRIES: usize = 100_000;
const MAX_LEASES: usize = 4_096;
const MAX_TRACK_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TEMPORARY_BYTES: u64 = 1024 * 1024 * 1024;
const MIN_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_SOURCE_URL_BYTES: usize = 4_096;
const DEFAULT_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS: usize = 3;
const ACCESS_FLUSH_HITS: usize = 32;
const ACCESS_FLUSH_INTERVAL_MS: u64 = 30_000;

#[derive(Clone)]
pub struct AudioCacheState {
    inner: Arc<AudioCacheInner>,
}

struct AudioCacheInner {
    operation_lock: Mutex<()>,
    leases: Mutex<HashMap<String, Lease>>,
    download_slots: Arc<Semaphore>,
    in_flight: std::sync::Mutex<HashSet<String>>,
    temporary_bytes: AtomicU64,
    cache_limit_bytes: AtomicU64,
    automatic_caching_enabled: AtomicBool,
    generation: AtomicU64,
    resident_index: Mutex<Option<ResidentIndex>>,
    next_nonce: AtomicU64,
    http: Client,
}

#[derive(Clone)]
struct Lease {
    key: String,
    file_name: String,
}

impl Default for AudioCacheState {
    fn default() -> Self {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("ClarusMusic/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the static audio cache HTTP client configuration must be valid");
        Self {
            inner: Arc::new(AudioCacheInner {
                operation_lock: Mutex::new(()),
                leases: Mutex::new(HashMap::new()),
                download_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
                in_flight: std::sync::Mutex::new(HashSet::new()),
                temporary_bytes: AtomicU64::new(0),
                cache_limit_bytes: AtomicU64::new(DEFAULT_TOTAL_BYTES),
                automatic_caching_enabled: AtomicBool::new(true),
                generation: AtomicU64::new(1),
                resident_index: Mutex::new(None),
                next_nonce: AtomicU64::new(1),
                http,
            }),
        }
    }
}

impl AudioCacheState {
    pub(crate) fn apply_settings(&self, enabled: bool, cache_limit_mb: Option<u32>) {
        let limit = cache_limit_mb
            .map(|megabytes| u64::from(megabytes).saturating_mul(1024 * 1024))
            .unwrap_or(MAX_TOTAL_BYTES)
            .clamp(MIN_TOTAL_BYTES, MAX_TOTAL_BYTES);
        let previous_enabled = self
            .inner
            .automatic_caching_enabled
            .swap(enabled, Ordering::AcqRel);
        let previous_limit = self.inner.cache_limit_bytes.swap(limit, Ordering::AcqRel);
        if previous_enabled != enabled || previous_limit != limit {
            self.inner.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFailure {
    kind: &'static str,
    message: String,
}

impl CacheFailure {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid-parameter",
            message: message.into(),
        }
    }

    fn io(action: &str, error: std::io::Error) -> Self {
        Self {
            kind: "io",
            message: format!("Failed to {action} the audio cache: {error}"),
        }
    }

    fn network(message: impl Into<String>) -> Self {
        Self {
            kind: "network",
            message: message.into(),
        }
    }

    fn capacity(message: impl Into<String>) -> Self {
        Self {
            kind: "capacity",
            message: message.into(),
        }
    }

    fn corruption(message: impl Into<String>) -> Self {
        Self {
            kind: "corruption",
            message: message.into(),
        }
    }

    fn task_failed(message: impl Into<String>) -> Self {
        Self {
            kind: "task-failed",
            message: message.into(),
        }
    }
}

impl From<CacheFailure> for ApiFailure {
    fn from(failure: CacheFailure) -> Self {
        ApiFailure::cache(failure.message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    track_id: i64,
    quality: String,
    file_name: String,
    mime_type: String,
    size_bytes: u64,
    checksum_sha256: String,
    last_accessed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CacheIndex {
    schema_version: u16,
    entries: BTreeMap<String, CacheEntry>,
}

impl Default for CacheIndex {
    fn default() -> Self {
        Self {
            schema_version: INDEX_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAudioSource {
    file_path: String,
    mime_type: String,
    size_bytes: u64,
    lease_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStoreResult {
    stored: bool,
    size_bytes: u64,
    evicted_entries: u64,
    evicted_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    entry_count: u64,
    total_bytes: u64,
    leased_entries: u64,
    maximum_track_bytes: u64,
    limit_bytes: u64,
    temporary_bytes: u64,
    in_flight_downloads: u64,
    automatic_caching_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    removed_entries: u64,
    removed_bytes: u64,
    retained_leased_entries: u64,
    retained_bytes: u64,
}

struct LoadedIndex {
    index: CacheIndex,
    dirty: bool,
}

struct ResidentIndex {
    root: PathBuf,
    index: CacheIndex,
    access_updates: usize,
    access_flush_ms: u64,
}

#[derive(Debug)]
struct DownloadedFile {
    temporary: TemporaryFile,
    _reservation: TemporaryReservation,
    size_bytes: u64,
    checksum_sha256: String,
}

struct InFlightGuard {
    inner: Arc<AudioCacheInner>,
    key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.inner
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

struct TemporaryReservation {
    inner: Arc<AudioCacheInner>,
    bytes: u64,
}

impl std::fmt::Debug for TemporaryReservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TemporaryReservation")
            .field("bytes", &self.bytes)
            .finish()
    }
}

impl TemporaryReservation {
    fn new(inner: Arc<AudioCacheInner>) -> Self {
        Self { inner, bytes: 0 }
    }

    fn reserve(&mut self, additional: u64) -> Result<(), CacheFailure> {
        let maximum = self
            .inner
            .cache_limit_bytes
            .load(Ordering::Acquire)
            .min(MAX_TEMPORARY_BYTES);
        let mut current = self.inner.temporary_bytes.load(Ordering::Acquire);
        loop {
            let next = current
                .checked_add(additional)
                .ok_or_else(|| CacheFailure::capacity("Temporary cache size overflowed"))?;
            if next > maximum {
                return Err(CacheFailure::capacity(format!(
                    "Concurrent audio downloads exceed the {maximum}-byte temporary-file bound",
                )));
            }
            match self.inner.temporary_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.bytes = self.bytes.saturating_add(additional);
                    return Ok(());
                }
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for TemporaryReservation {
    fn drop(&mut self) {
        self.inner
            .temporary_bytes
            .fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

struct CacheStoreSpec {
    track_id: i64,
    quality: String,
    mime_type: String,
    extension: &'static str,
    cache_limit_bytes: u64,
}

#[derive(Debug)]
struct TemporaryFile {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, CacheFailure> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join(CACHE_DIRECTORY_NAME))
        .map_err(|error| CacheFailure {
            kind: "path",
            message: format!("Failed to resolve the audio cache directory: {error}"),
        })
}

fn validate_track(track_id: i64) -> Result<(), CacheFailure> {
    if track_id <= 0 {
        return Err(CacheFailure::invalid("trackId must be a positive integer"));
    }
    Ok(())
}

fn validate_quality(quality: &str) -> Result<&str, CacheFailure> {
    match quality {
        "128000" | "192000" | "320000" | "flac" | "999000" => Ok(quality),
        _ => Err(CacheFailure::invalid(
            "quality is not a supported music quality",
        )),
    }
}

fn validate_source_url(source_url: &str) -> Result<(), CacheFailure> {
    if source_url.is_empty()
        || source_url.len() > MAX_SOURCE_URL_BYTES
        || !(source_url.starts_with("https://") || source_url.starts_with("http://"))
    {
        return Err(CacheFailure::invalid(
            "sourceUrl must be a bounded HTTP or HTTPS URL",
        ));
    }
    Ok(())
}

fn normalize_mime_type(mime_type: &str) -> Result<(&'static str, &'static str), CacheFailure> {
    let mime_type = mime_type.trim().to_ascii_lowercase();
    match mime_type.as_str() {
        "audio/flac" | "audio/x-flac" => Ok(("audio/flac", "flac")),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => Ok(("audio/mp4", "m4a")),
        "audio/ogg" | "application/ogg" => Ok(("audio/ogg", "ogg")),
        "audio/webm" => Ok(("audio/webm", "webm")),
        "audio/mpeg" | "audio/mp3" | "application/octet-stream" => Ok(("audio/mpeg", "mp3")),
        _ => Err(CacheFailure::invalid(
            "mimeType is not a supported audio media type",
        )),
    }
}

fn cache_key(track_id: i64, quality: &str) -> String {
    format!("{track_id}:{quality}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn safe_entry_file_name(entry: &CacheEntry) -> bool {
    let path = Path::new(&entry.file_name);
    let mut components = path.components();
    let one_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !one_normal_component
        || entry.file_name.len() > 192
        || !entry
            .file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return false;
    }
    let Ok((_, extension)) = normalize_mime_type(&entry.mime_type) else {
        return false;
    };
    entry.file_name
        == format!(
            "{}-{}-{}.{}",
            entry.track_id, entry.quality, entry.checksum_sha256, extension
        )
}

fn valid_checksum(checksum: &str) -> bool {
    checksum.len() == 64
        && checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

async fn read_index(root: &Path) -> Result<LoadedIndex, CacheFailure> {
    let path = root.join(INDEX_FILE_NAME);
    let metadata = match fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(LoadedIndex {
                index: CacheIndex::default(),
                dirty: false,
            });
        }
        Err(error) => return Err(CacheFailure::io("inspect", error)),
    };
    if metadata.len() > MAX_INDEX_BYTES {
        return Ok(LoadedIndex {
            index: CacheIndex::default(),
            dirty: true,
        });
    }
    let bytes = fs::read(&path)
        .await
        .map_err(|error| CacheFailure::io("read", error))?;
    let mut index = match serde_json::from_slice::<CacheIndex>(&bytes) {
        Ok(index)
            if index.schema_version == INDEX_SCHEMA_VERSION
                && index.entries.len() <= MAX_ENTRIES =>
        {
            index
        }
        _ => {
            return Ok(LoadedIndex {
                index: CacheIndex::default(),
                dirty: true,
            });
        }
    };

    let mut dirty = false;
    let entries = std::mem::take(&mut index.entries);
    for (key, entry) in entries {
        let structurally_valid = validate_track(entry.track_id).is_ok()
            && validate_quality(&entry.quality).is_ok()
            && cache_key(entry.track_id, &entry.quality) == key
            && safe_entry_file_name(&entry)
            && valid_checksum(&entry.checksum_sha256)
            && normalize_mime_type(&entry.mime_type).is_ok()
            && (1..=MAX_TRACK_BYTES).contains(&entry.size_bytes);
        if !structurally_valid {
            dirty = true;
            continue;
        }
        let file_path = root.join(&entry.file_name);
        match fs::metadata(&file_path).await {
            Ok(metadata) if metadata.is_file() && metadata.len() == entry.size_bytes => {
                index.entries.insert(key, entry);
            }
            Ok(_) => {
                dirty = true;
                let _ = fs::remove_file(file_path).await;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => dirty = true,
            Err(error) => return Err(CacheFailure::io("inspect", error)),
        }
    }
    Ok(LoadedIndex { index, dirty })
}

async fn write_index(root: &Path, index: &CacheIndex) -> Result<(), CacheFailure> {
    let bytes = serde_json::to_vec(index).map_err(|error| CacheFailure {
        kind: "serialization",
        message: format!("Failed to serialize the audio cache index: {error}"),
    })?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(CacheFailure::capacity(
            "The audio cache index reached its bounded size",
        ));
    }
    let path = root.join(INDEX_FILE_NAME);
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&root).map_err(|error| CacheFailure::io("create", error))?;
        let mut file = AtomicWriteFile::open(&path)
            .map_err(|error| CacheFailure::io("open the atomic index for", error))?;
        file.write_all(&bytes)
            .map_err(|error| CacheFailure::io("write", error))?;
        file.commit()
            .map_err(|error| CacheFailure::io("atomically replace", error))
    })
    .await
    .map_err(|error| CacheFailure::task_failed(format!("Index writer failed: {error}")))?
}

async fn record_entry_access(
    root: &Path,
    resident: &mut ResidentIndex,
    key: &str,
    accessed_ms: u64,
) -> Result<(), CacheFailure> {
    let entry = resident
        .index
        .entries
        .get_mut(key)
        .ok_or_else(|| CacheFailure::corruption("The cached audio entry disappeared"))?;
    entry.last_accessed_ms = accessed_ms;
    resident.access_updates = resident.access_updates.saturating_add(1);
    if resident.access_updates < ACCESS_FLUSH_HITS
        && accessed_ms.saturating_sub(resident.access_flush_ms) < ACCESS_FLUSH_INTERVAL_MS
    {
        return Ok(());
    }
    write_index(root, &resident.index).await?;
    resident.access_updates = 0;
    resident.access_flush_ms = accessed_ms;
    Ok(())
}

async fn leased_keys(inner: &AudioCacheInner) -> HashSet<String> {
    inner
        .leases
        .lock()
        .await
        .values()
        .map(|lease| lease.key.clone())
        .collect()
}

async fn leased_file_names(inner: &AudioCacheInner) -> HashSet<String> {
    inner
        .leases
        .lock()
        .await
        .values()
        .map(|lease| lease.file_name.clone())
        .collect()
}

fn begin_in_flight(
    inner: Arc<AudioCacheInner>,
    key: String,
) -> Result<InFlightGuard, CacheFailure> {
    let inserted = inner
        .in_flight
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(key.clone());
    if !inserted {
        return Err(CacheFailure {
            kind: "in-flight",
            message: "This track and quality are already being cached".to_string(),
        });
    }
    Ok(InFlightGuard { inner, key })
}

fn managed_audio_file_name(file_name: &str) -> bool {
    let Some((stem, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    if !["mp3", "flac", "m4a", "ogg", "webm"].contains(&extension) {
        return false;
    }
    let parts = stem.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0].parse::<i64>().is_ok_and(|track_id| track_id > 0)
        && validate_quality(parts[1]).is_ok()
        && valid_checksum(parts[2])
}

async fn cleanup_orphaned_files(
    root: &Path,
    index: &CacheIndex,
    inner: &AudioCacheInner,
) -> Result<(), CacheFailure> {
    let mut directory = match fs::read_dir(root).await {
        Ok(directory) => directory,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(CacheFailure::io("scan", error)),
    };
    let referenced = index
        .entries
        .values()
        .map(|entry| entry.file_name.as_str())
        .collect::<HashSet<_>>();
    let leased = leased_file_names(inner).await;
    let mut scanned = 0_usize;
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| CacheFailure::io("scan", error))?
    {
        scanned += 1;
        if scanned > MAX_DIRECTORY_ENTRIES {
            return Err(CacheFailure::capacity(
                "The audio cache directory contains too many entries to scan safely",
            ));
        }
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !managed_audio_file_name(file_name)
            || referenced.contains(file_name)
            || leased.contains(file_name)
        {
            continue;
        }
        match fs::remove_file(entry.path()).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(CacheFailure::io("remove an orphan from", error)),
        }
    }
    Ok(())
}

async fn ensure_resident_index(
    root: &Path,
    inner: &AudioCacheInner,
    resident: &mut Option<ResidentIndex>,
) -> Result<(), CacheFailure> {
    if resident.as_ref().is_some_and(|loaded| loaded.root == root) {
        return Ok(());
    }
    if let Some(previous) = resident.as_ref().filter(|loaded| loaded.access_updates > 0) {
        write_index(&previous.root, &previous.index).await?;
    }
    let loaded = read_index(root).await?;
    cleanup_orphaned_files(root, &loaded.index, inner).await?;
    if loaded.dirty {
        write_index(root, &loaded.index).await?;
    }
    *resident = Some(ResidentIndex {
        root: root.to_path_buf(),
        index: loaded.index,
        access_updates: 0,
        access_flush_ms: now_ms(),
    });
    Ok(())
}

async fn trim_resident_index(
    root: &Path,
    inner: &AudioCacheInner,
    index: &mut CacheIndex,
    limit_bytes: u64,
) -> Result<(u64, u64), CacheFailure> {
    let mut total_bytes = index
        .entries
        .values()
        .map(|entry| entry.size_bytes)
        .sum::<u64>();
    if total_bytes <= limit_bytes {
        return Ok((0, 0));
    }
    let pinned = leased_keys(inner).await;
    let mut candidates = index
        .entries
        .iter()
        .filter(|(key, _)| !pinned.contains(*key))
        .map(|(key, entry)| (key.clone(), entry.last_accessed_ms))
        .collect::<Vec<_>>();
    candidates.sort_unstable_by_key(|(_, accessed)| *accessed);
    let mut next = index.clone();
    let mut victims = Vec::new();
    for (key, _) in candidates {
        if total_bytes <= limit_bytes {
            break;
        }
        if let Some(entry) = next.entries.remove(&key) {
            total_bytes = total_bytes.saturating_sub(entry.size_bytes);
            victims.push(entry);
        }
    }
    if victims.is_empty() {
        return Ok((0, 0));
    }

    write_index(root, &next).await?;
    *index = next;
    let removed_entries = victims.len() as u64;
    let removed_bytes = victims.iter().map(|entry| entry.size_bytes).sum();
    for victim in victims {
        // The index is already authoritative. A failed unlink is a safe orphan
        // that the next bounded startup cleanup will remove.
        let _ = remove_entry_file(root, &victim).await;
    }
    Ok((removed_entries, removed_bytes))
}

async fn register_lease(
    inner: &AudioCacheInner,
    key: String,
    file_name: String,
) -> Result<String, CacheFailure> {
    let mut leases = inner.leases.lock().await;
    if leases.len() >= MAX_LEASES {
        return Err(CacheFailure::capacity(
            "Too many audio cache files are currently leased",
        ));
    }
    for _ in 0..16 {
        let nonce = inner.next_nonce.fetch_add(1, Ordering::Relaxed);
        let lease_id = format!("audio-cache-{nonce}");
        if let std::collections::hash_map::Entry::Vacant(entry) = leases.entry(lease_id.clone()) {
            entry.insert(Lease {
                key: key.clone(),
                file_name: file_name.clone(),
            });
            return Ok(lease_id);
        }
    }
    Err(CacheFailure::capacity(
        "Could not allocate a unique audio cache lease",
    ))
}

async fn release_lease(inner: &AudioCacheInner, lease_id: &str) -> bool {
    inner.leases.lock().await.remove(lease_id).is_some()
}

async fn create_temporary_file(
    root: &Path,
    inner: &AudioCacheInner,
) -> Result<(TemporaryFile, fs::File), CacheFailure> {
    fs::create_dir_all(root)
        .await
        .map_err(|error| CacheFailure::io("create", error))?;
    for _ in 0..16 {
        let nonce = inner.next_nonce.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!(".partial-{nonce}"));
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((TemporaryFile::new(path), file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(CacheFailure::io("create a temporary file in", error)),
        }
    }
    Err(CacheFailure::io(
        "create a unique temporary file in",
        std::io::Error::new(ErrorKind::AlreadyExists, "temporary file name collisions"),
    ))
}

async fn download_stream<S, E>(
    root: &Path,
    inner: &Arc<AudioCacheInner>,
    mut stream: S,
    maximum_bytes: u64,
) -> Result<DownloadedFile, CacheFailure>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let (temporary, mut file) = create_temporary_file(root, inner).await?;
    let mut reservation = TemporaryReservation::new(Arc::clone(inner));
    let mut size_bytes = 0_u64;
    let mut checksum = Sha256::new();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|error| {
            CacheFailure::network(format!("Failed while downloading audio: {error}"))
        })?;
        size_bytes = size_bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| CacheFailure::capacity("The audio download size overflowed"))?;
        if size_bytes > maximum_bytes {
            return Err(CacheFailure::capacity(format!(
                "The audio download exceeds the {maximum_bytes}-byte per-track bound",
            )));
        }
        reservation.reserve(chunk.len() as u64)?;
        file.write_all(&chunk)
            .await
            .map_err(|error| CacheFailure::io("write a temporary file in", error))?;
        checksum.update(&chunk);
    }
    if size_bytes == 0 {
        return Err(CacheFailure::corruption(
            "The audio response contained no bytes",
        ));
    }
    file.flush()
        .await
        .map_err(|error| CacheFailure::io("flush a temporary file in", error))?;
    file.sync_all()
        .await
        .map_err(|error| CacheFailure::io("sync a temporary file in", error))?;
    drop(file);
    Ok(DownloadedFile {
        temporary,
        _reservation: reservation,
        size_bytes,
        checksum_sha256: format!("{:x}", checksum.finalize()),
    })
}

async fn remove_entry_file(root: &Path, entry: &CacheEntry) -> Result<(), CacheFailure> {
    debug_assert!(safe_entry_file_name(entry));
    match fs::remove_file(root.join(&entry.file_name)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CacheFailure::io("remove an entry from", error)),
    }
}

async fn commit_download(
    root: &Path,
    inner: &AudioCacheInner,
    expected_generation: u64,
    spec: CacheStoreSpec,
    mut download: DownloadedFile,
) -> Result<CacheStoreResult, CacheFailure> {
    let _operation = inner.operation_lock.lock().await;
    if inner.generation.load(Ordering::Acquire) != expected_generation {
        return Ok(CacheStoreResult {
            stored: false,
            size_bytes: 0,
            evicted_entries: 0,
            evicted_bytes: 0,
        });
    }
    let mut resident = inner.resident_index.lock().await;
    ensure_resident_index(root, inner, &mut resident).await?;
    let resident_index = resident.as_mut().expect("resident index is initialized");
    let index = &mut resident_index.index;
    let trimmed = trim_resident_index(root, inner, index, spec.cache_limit_bytes).await?;
    if trimmed.0 > 0 {
        resident_index.access_updates = 0;
        resident_index.access_flush_ms = now_ms();
    }
    let key = cache_key(spec.track_id, &spec.quality);
    let pinned = leased_keys(inner).await;
    if pinned.contains(&key) {
        return Err(CacheFailure::capacity(
            "The existing cache entry is currently leased for playback",
        ));
    }

    let old_entry = index.entries.get(&key).cloned();
    let mut next_index = index.clone();
    next_index.entries.remove(&key);
    let mut total_bytes = next_index
        .entries
        .values()
        .map(|entry| entry.size_bytes)
        .sum::<u64>();
    let mut candidates = next_index
        .entries
        .iter()
        .filter(|(candidate_key, _)| !pinned.contains(*candidate_key))
        .map(|(candidate_key, entry)| {
            (
                candidate_key.clone(),
                entry.last_accessed_ms,
                entry.size_bytes,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_unstable_by_key(|(_, last_accessed, _)| *last_accessed);

    let mut evicted_entries = 0_u64;
    let mut evicted_bytes = 0_u64;
    let mut victims = Vec::new();
    let mut candidate_index = 0_usize;
    while total_bytes.saturating_add(download.size_bytes) > spec.cache_limit_bytes
        || next_index.entries.len() >= MAX_ENTRIES
    {
        let Some((victim_key, _, victim_size)) = candidates.get(candidate_index) else {
            return Err(CacheFailure::capacity(
                "The cache limit cannot fit this track while active entries are leased",
            ));
        };
        candidate_index += 1;
        if let Some(victim) = next_index.entries.remove(victim_key) {
            total_bytes = total_bytes.saturating_sub(*victim_size);
            evicted_entries += 1;
            evicted_bytes = evicted_bytes.saturating_add(*victim_size);
            victims.push(victim);
        }
    }

    let final_name = format!(
        "{}-{}-{}.{}",
        spec.track_id, spec.quality, download.checksum_sha256, spec.extension
    );
    let final_path = root.join(&final_name);
    let final_exists = match fs::metadata(&final_path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() == download.size_bytes => true,
        Ok(_) => {
            fs::remove_file(&final_path)
                .await
                .map_err(|error| CacheFailure::io("remove a corrupt file from", error))?;
            false
        }
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(CacheFailure::io("inspect", error)),
    };
    let created_final = if final_exists {
        false
    } else {
        fs::rename(&download.temporary.path, &final_path)
            .await
            .map_err(|error| CacheFailure::io("atomically publish a file in", error))?;
        download.temporary.disarm();
        true
    };

    next_index.entries.insert(
        key,
        CacheEntry {
            track_id: spec.track_id,
            quality: spec.quality,
            file_name: final_name.clone(),
            mime_type: spec.mime_type,
            size_bytes: download.size_bytes,
            checksum_sha256: download.checksum_sha256,
            last_accessed_ms: now_ms(),
        },
    );
    if let Err(error) = write_index(root, &next_index).await {
        if created_final {
            let _ = fs::remove_file(&final_path).await;
        }
        return Err(error);
    }
    *index = next_index;
    resident_index.access_updates = 0;
    resident_index.access_flush_ms = now_ms();
    for victim in victims {
        let _ = remove_entry_file(root, &victim).await;
    }
    if let Some(old_entry) = old_entry {
        if old_entry.file_name != final_name {
            let _ = remove_entry_file(root, &old_entry).await;
        }
    }

    Ok(CacheStoreResult {
        stored: true,
        size_bytes: download.size_bytes,
        evicted_entries,
        evicted_bytes,
    })
}

#[tauri::command]
pub async fn lookup_audio_cache(
    app: AppHandle,
    state: State<'_, AudioCacheState>,
    track_id: i64,
    quality: String,
) -> Result<Option<CachedAudioSource>, CacheFailure> {
    validate_track(track_id)?;
    let quality = validate_quality(&quality)?.to_string();
    let root = cache_root(&app)?;
    let inner = Arc::clone(&state.inner);
    let _operation = inner.operation_lock.lock().await;
    let mut resident = inner.resident_index.lock().await;
    ensure_resident_index(&root, &inner, &mut resident).await?;
    let resident_index = resident.as_mut().expect("resident index is initialized");
    let trimmed = trim_resident_index(
        &root,
        &inner,
        &mut resident_index.index,
        inner.cache_limit_bytes.load(Ordering::Acquire),
    )
    .await?;
    if trimmed.0 > 0 {
        resident_index.access_updates = 0;
        resident_index.access_flush_ms = now_ms();
        resident_index.access_flush_ms = now_ms();
    }
    let key = cache_key(track_id, &quality);
    let Some(entry) = resident_index.index.entries.get(&key) else {
        return Ok(None);
    };
    let file_name = entry.file_name.clone();
    let mime_type = entry.mime_type.clone();
    let size_bytes = entry.size_bytes;
    let file_path = root.join(&file_name);
    let valid_file = match fs::metadata(&file_path).await {
        Ok(metadata) => metadata.is_file() && metadata.len() == size_bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(CacheFailure::io("inspect", error)),
    };
    if !valid_file {
        let mut next = resident_index.index.clone();
        next.entries.remove(&key);
        write_index(&root, &next).await?;
        resident_index.index = next;
        resident_index.access_updates = 0;
        resident_index.access_flush_ms = now_ms();
        let _ = fs::remove_file(&file_path).await;
        return Ok(None);
    }
    let file_path = file_path
        .to_str()
        .ok_or_else(|| CacheFailure::corruption("The cached audio path is not valid UTF-8"))?
        .to_string();
    record_entry_access(&root, resident_index, &key, now_ms()).await?;
    let lease_id = register_lease(&inner, key, file_name).await?;
    Ok(Some(CachedAudioSource {
        file_path,
        mime_type,
        size_bytes,
        lease_id,
    }))
}

#[tauri::command]
pub async fn read_audio_cache_bytes(
    app: AppHandle,
    state: State<'_, AudioCacheState>,
    lease_id: String,
) -> Result<Response, CacheFailure> {
    if lease_id.is_empty() || lease_id.len() > 128 || !lease_id.is_ascii() {
        return Err(CacheFailure::invalid(
            "leaseId must contain between 1 and 128 ASCII bytes",
        ));
    }
    let lease = state
        .inner
        .leases
        .lock()
        .await
        .get(&lease_id)
        .cloned()
        .ok_or_else(|| CacheFailure::invalid("The audio cache lease is no longer active"))?;
    let file_path = cache_root(&app)?.join(lease.file_name);
    let metadata = fs::metadata(&file_path)
        .await
        .map_err(|error| CacheFailure::io("inspect", error))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TRACK_BYTES {
        return Err(CacheFailure::corruption(
            "The leased audio cache file has an invalid size",
        ));
    }
    let bytes = fs::read(&file_path)
        .await
        .map_err(|error| CacheFailure::io("read", error))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(CacheFailure::corruption(
            "The leased audio cache file changed while it was being read",
        ));
    }
    Ok(Response::new(bytes))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn store_audio_cache(
    app: AppHandle,
    cache_state: State<'_, AudioCacheState>,
    music_state: State<'_, MusicApiState>,
    request_id: String,
    track_id: i64,
    quality: String,
    source_url: String,
    mime_type: String,
    expected_size_bytes: u64,
) -> Result<CacheStoreResult, ApiFailure> {
    validate_track(track_id)?;
    let quality = validate_quality(&quality)?.to_string();
    validate_source_url(&source_url)?;
    let (mime_type, extension) = normalize_mime_type(&mime_type)?;
    let mime_type = mime_type.to_string();
    if !cache_state
        .inner
        .automatic_caching_enabled
        .load(Ordering::Acquire)
    {
        return Ok(CacheStoreResult {
            stored: false,
            size_bytes: 0,
            evicted_entries: 0,
            evicted_bytes: 0,
        });
    }
    let cache_limit_bytes = cache_state.inner.cache_limit_bytes.load(Ordering::Acquire);
    if expected_size_bytes > MAX_TRACK_BYTES || expected_size_bytes > cache_limit_bytes {
        return Err(CacheFailure::capacity(
            "The advertised track size exceeds the configured cache bound",
        )
        .into());
    }
    let root = cache_root(&app)?;
    let inner = Arc::clone(&cache_state.inner);
    music_state
        .run_cancellable(request_id, async move {
            let in_flight = begin_in_flight(Arc::clone(&inner), cache_key(track_id, &quality))?;
            let generation = inner.generation.load(Ordering::Acquire);
            let download_slot = Arc::clone(&inner.download_slots)
                .acquire_owned()
                .await
                .map_err(|_| CacheFailure::task_failed("Audio download limiter was closed"))?;
            let response = inner
                .http
                .get(source_url)
                .send()
                .await
                .map_err(|error| CacheFailure::network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(CacheFailure::network(format!(
                    "The audio source returned HTTP {}",
                    response.status()
                ))
                .into());
            }
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length > MAX_TRACK_BYTES || length > cache_limit_bytes)
            {
                return Err(CacheFailure::capacity(
                    "The audio response exceeds the configured cache bound",
                )
                .into());
            }
            let maximum_bytes = MAX_TRACK_BYTES.min(cache_limit_bytes);
            let download =
                download_stream(&root, &inner, response.bytes_stream(), maximum_bytes).await?;
            drop(download_slot);
            let commit_limit_bytes = inner.cache_limit_bytes.load(Ordering::Acquire);
            let commit = tokio::spawn(async move {
                let _in_flight = in_flight;
                commit_download(
                    &root,
                    &inner,
                    generation,
                    CacheStoreSpec {
                        track_id,
                        quality,
                        mime_type,
                        extension,
                        cache_limit_bytes: commit_limit_bytes,
                    },
                    download,
                )
                .await
            });
            commit
                .await
                .map_err(|error| {
                    CacheFailure::task_failed(format!("Cache commit task failed: {error}"))
                })?
                .map_err(Into::into)
        })
        .await
}

#[tauri::command]
pub async fn release_audio_cache_lease(
    state: State<'_, AudioCacheState>,
    lease_id: String,
) -> Result<bool, CacheFailure> {
    if lease_id.is_empty() || lease_id.len() > 128 || !lease_id.is_ascii() {
        return Err(CacheFailure::invalid(
            "leaseId must contain between 1 and 128 ASCII bytes",
        ));
    }
    Ok(release_lease(&state.inner, &lease_id).await)
}

#[tauri::command]
pub async fn audio_cache_stats(
    app: AppHandle,
    state: State<'_, AudioCacheState>,
) -> Result<CacheStats, CacheFailure> {
    let root = cache_root(&app)?;
    let inner = Arc::clone(&state.inner);
    let _operation = inner.operation_lock.lock().await;
    let mut resident = inner.resident_index.lock().await;
    ensure_resident_index(&root, &inner, &mut resident).await?;
    let resident_index = resident.as_mut().expect("resident index is initialized");
    let index = &mut resident_index.index;
    let limit_bytes = inner.cache_limit_bytes.load(Ordering::Acquire);
    let trimmed = trim_resident_index(&root, &inner, index, limit_bytes).await?;
    if trimmed.0 > 0 {
        resident_index.access_updates = 0;
    }
    let leased_entries = leased_keys(&inner).await.len() as u64;
    let in_flight_downloads = inner
        .in_flight
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .len() as u64;
    Ok(CacheStats {
        entry_count: index.entries.len() as u64,
        total_bytes: index.entries.values().map(|entry| entry.size_bytes).sum(),
        leased_entries,
        maximum_track_bytes: MAX_TRACK_BYTES,
        limit_bytes,
        temporary_bytes: inner.temporary_bytes.load(Ordering::Acquire),
        in_flight_downloads,
        automatic_caching_enabled: inner.automatic_caching_enabled.load(Ordering::Acquire),
    })
}

#[tauri::command]
pub async fn clear_audio_cache(
    app: AppHandle,
    state: State<'_, AudioCacheState>,
) -> Result<CacheClearResult, CacheFailure> {
    let root = cache_root(&app)?;
    let inner = Arc::clone(&state.inner);
    inner.generation.fetch_add(1, Ordering::AcqRel);
    let _operation = inner.operation_lock.lock().await;
    let mut resident = inner.resident_index.lock().await;
    ensure_resident_index(&root, &inner, &mut resident).await?;
    let resident_index = resident.as_mut().expect("resident index is initialized");
    let index = &mut resident_index.index;
    let pinned = leased_keys(&inner).await;
    let mut next = index.clone();
    let entries = std::mem::take(&mut next.entries);
    let mut victims = Vec::new();
    let mut removed_entries = 0_u64;
    let mut removed_bytes = 0_u64;
    for (key, entry) in entries {
        if pinned.contains(&key) {
            next.entries.insert(key, entry);
            continue;
        }
        removed_entries += 1;
        removed_bytes = removed_bytes.saturating_add(entry.size_bytes);
        victims.push(entry);
    }
    write_index(&root, &next).await?;
    *index = next;
    resident_index.access_updates = 0;
    resident_index.access_flush_ms = now_ms();
    for victim in victims {
        let _ = remove_entry_file(&root, &victim).await;
    }
    Ok(CacheClearResult {
        removed_entries,
        removed_bytes,
        retained_leased_entries: index.entries.len() as u64,
        retained_bytes: index.entries.values().map(|entry| entry.size_bytes).sum(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::Ordering, Arc};

    use bytes::Bytes;
    use futures_util::{stream, StreamExt};
    use tempfile::tempdir;

    use super::{
        begin_in_flight, cache_key, cleanup_orphaned_files, commit_download, download_stream,
        managed_audio_file_name, normalize_mime_type, read_index, record_entry_access,
        register_lease, release_lease, safe_entry_file_name, trim_resident_index, validate_quality,
        write_index, AudioCacheState, CacheEntry, CacheIndex, ResidentIndex, TemporaryReservation,
        ACCESS_FLUSH_HITS, MAX_CONCURRENT_DOWNLOADS, MAX_LEASES, MAX_TOTAL_BYTES, MAX_TRACK_BYTES,
    };

    fn entry(track_id: i64, quality: &str, file_name: &str, size_bytes: u64) -> CacheEntry {
        CacheEntry {
            track_id,
            quality: quality.to_string(),
            file_name: file_name.to_string(),
            mime_type: "audio/mpeg".to_string(),
            size_bytes,
            checksum_sha256: "a".repeat(64),
            last_accessed_ms: 1,
        }
    }

    #[test]
    fn validates_quality_mime_and_entry_paths() {
        assert_eq!(validate_quality("320000").expect("quality"), "320000");
        assert!(validate_quality("source").is_err());
        assert_eq!(
            normalize_mime_type("audio/x-flac").expect("mime"),
            ("audio/flac", "flac")
        );
        assert_eq!(
            normalize_mime_type("audio/webm").expect("mime"),
            ("audio/webm", "webm")
        );
        assert!(managed_audio_file_name(&format!(
            "42-320000-{}.webm",
            "a".repeat(64)
        )));
        assert!(normalize_mime_type("text/html").is_err());

        assert!(safe_entry_file_name(&entry(
            42,
            "320000",
            &format!("42-320000-{}.mp3", "a".repeat(64)),
            3
        )));
        assert!(!safe_entry_file_name(&entry(
            42,
            "320000",
            "../outside.mp3",
            3
        )));
    }

    #[tokio::test]
    async fn bounded_stream_removes_partial_file_on_failure() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let chunks = stream::iter(vec![
            Ok::<_, &'static str>(Bytes::from_static(b"1234")),
            Ok(Bytes::from_static(b"5678")),
        ]);
        let error = download_stream(directory.path(), &state.inner, chunks, 6)
            .await
            .expect_err("bound must reject the stream");
        assert_eq!(error.kind, "capacity");
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("directory")
                .count(),
            0
        );
    }

    #[test]
    fn settings_drive_a_hard_bounded_native_cache_policy() {
        let state = AudioCacheState::default();
        state.apply_settings(false, None);
        assert!(!state
            .inner
            .automatic_caching_enabled
            .load(Ordering::Acquire));
        assert_eq!(
            state.inner.cache_limit_bytes.load(Ordering::Acquire),
            MAX_TOTAL_BYTES
        );

        state.apply_settings(true, Some(128));
        assert!(state
            .inner
            .automatic_caching_enabled
            .load(Ordering::Acquire));
        assert_eq!(
            state.inner.cache_limit_bytes.load(Ordering::Acquire),
            128 * 1024 * 1024
        );
    }

    #[test]
    fn temporary_reservations_enforce_an_aggregate_bound_and_release() {
        let state = AudioCacheState::default();
        state.inner.cache_limit_bytes.store(6, Ordering::Release);
        let mut first = TemporaryReservation::new(Arc::clone(&state.inner));
        let mut second = TemporaryReservation::new(Arc::clone(&state.inner));
        first.reserve(4).expect("first reservation");
        assert!(second.reserve(3).is_err());
        assert_eq!(state.inner.temporary_bytes.load(Ordering::Acquire), 4);
        drop(first);
        second.reserve(3).expect("released capacity");
        assert_eq!(state.inner.temporary_bytes.load(Ordering::Acquire), 3);
        drop(second);
        assert_eq!(state.inner.temporary_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn same_key_is_single_flight_until_the_owner_drops() {
        let state = AudioCacheState::default();
        let key = cache_key(42, "320000");
        let owner = begin_in_flight(Arc::clone(&state.inner), key.clone()).expect("owner");
        assert!(begin_in_flight(Arc::clone(&state.inner), key.clone()).is_err());
        drop(owner);
        assert!(begin_in_flight(Arc::clone(&state.inner), key).is_ok());
    }

    #[tokio::test]
    async fn cancellation_drops_partial_file_and_all_temporary_bytes() {
        let directory = tempdir().expect("tempdir");
        let root = directory.path().to_path_buf();
        let state = AudioCacheState::default();
        let inner = Arc::clone(&state.inner);
        let chunks = stream::iter([Ok::<_, &'static str>(Bytes::from_static(b"1234"))])
            .chain(stream::pending());
        let task =
            tokio::spawn(
                async move { download_stream(&root, &inner, chunks, MAX_TRACK_BYTES).await },
            );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.inner.temporary_bytes.load(Ordering::Acquire) == 4 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("download reached the pending stream");
        assert_eq!(state.inner.temporary_bytes.load(Ordering::Acquire), 4);
        task.abort();
        assert!(task.await.expect_err("cancelled task").is_cancelled());
        assert_eq!(state.inner.temporary_bytes.load(Ordering::Acquire), 0);
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("directory")
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn lease_registry_is_strictly_bounded() {
        let state = AudioCacheState::default();
        let mut leases = state.inner.leases.lock().await;
        for index in 0..MAX_LEASES {
            leases.insert(
                format!("lease-{index}"),
                super::Lease {
                    key: format!("key-{index}"),
                    file_name: format!("file-{index}"),
                },
            );
        }
        drop(leases);
        assert!(
            register_lease(&state.inner, "key".to_string(), "file".to_string())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn lease_release_is_owned_and_idempotent() {
        let state = AudioCacheState::default();
        let lease_id = register_lease(
            &state.inner,
            cache_key(42, "320000"),
            "file.mp3".to_string(),
        )
        .await
        .expect("lease");
        assert!(release_lease(&state.inner, &lease_id).await);
        assert!(!release_lease(&state.inner, &lease_id).await);
        assert!(state.inner.leases.lock().await.is_empty());
    }

    #[tokio::test]
    async fn download_semaphore_has_a_strict_global_limit() {
        let state = AudioCacheState::default();
        let mut permits = Vec::new();
        for _ in 0..MAX_CONCURRENT_DOWNLOADS {
            permits.push(
                Arc::clone(&state.inner.download_slots)
                    .try_acquire_owned()
                    .expect("bounded permit"),
            );
        }
        assert!(Arc::clone(&state.inner.download_slots)
            .try_acquire_owned()
            .is_err());
        drop(permits.pop());
        assert!(Arc::clone(&state.inner.download_slots)
            .try_acquire_owned()
            .is_ok());
    }

    #[tokio::test]
    async fn generation_change_discards_a_download_waiting_to_commit() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let generation = state.inner.generation.load(Ordering::Acquire);
        let chunks = stream::iter([Ok::<_, &'static str>(Bytes::from_static(b"audio"))]);
        let download = download_stream(directory.path(), &state.inner, chunks, MAX_TRACK_BYTES)
            .await
            .expect("download");
        state.inner.generation.fetch_add(1, Ordering::AcqRel);

        let result = commit_download(
            directory.path(),
            &state.inner,
            generation,
            super::CacheStoreSpec {
                track_id: 42,
                quality: "320000".to_string(),
                mime_type: "audio/mpeg".to_string(),
                extension: "mp3",
                cache_limit_bytes: MAX_TOTAL_BYTES,
            },
            download,
        )
        .await
        .expect("discarded commit");

        assert!(!result.stored);
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("directory")
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn lowered_limit_trims_the_least_recent_entry() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let first_name = format!("1-320000-{}.mp3", "a".repeat(64));
        let second_name = format!("2-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&first_name), b"old").expect("first");
        std::fs::write(directory.path().join(&second_name), b"new").expect("second");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(cache_key(1, "320000"), entry(1, "320000", &first_name, 3));
        let mut newest = entry(2, "320000", &second_name, 3);
        newest.last_accessed_ms = 2;
        index.entries.insert(cache_key(2, "320000"), newest);

        let removed = trim_resident_index(directory.path(), &state.inner, &mut index, 3)
            .await
            .expect("trim");
        assert_eq!(removed, (1, 3));
        assert!(!directory.path().join(first_name).exists());
        assert!(directory.path().join(second_name).exists());
        assert_eq!(index.entries.len(), 1);
    }

    #[tokio::test]
    async fn access_time_survives_index_reload() {
        let directory = tempdir().expect("tempdir");
        let key = cache_key(42, "320000");
        let file_name = format!("42-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&file_name), b"abc").expect("audio file");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(key.clone(), entry(42, "320000", &file_name, 3));
        write_index(directory.path(), &index)
            .await
            .expect("initial index");

        let mut resident = ResidentIndex {
            root: directory.path().to_path_buf(),
            index,
            access_updates: 0,
            access_flush_ms: super::now_ms(),
        };
        record_entry_access(directory.path(), &mut resident, &key, 99)
            .await
            .expect("record access");
        assert_eq!(
            read_index(directory.path())
                .await
                .expect("read deferred index")
                .index
                .entries[&key]
                .last_accessed_ms,
            1,
            "a single cache hit should not rewrite the full index"
        );
        for access in 0..(ACCESS_FLUSH_HITS - 1) {
            record_entry_access(directory.path(), &mut resident, &key, 100 + access as u64)
                .await
                .expect("flush access batch");
        }

        let reloaded = read_index(directory.path()).await.expect("reload index");
        assert_eq!(
            reloaded.index.entries[&key].last_accessed_ms,
            100 + (ACCESS_FLUSH_HITS - 2) as u64,
            "LRU order must survive an application restart"
        );
    }

    #[tokio::test]
    async fn malformed_index_is_reset_without_following_untrusted_paths() {
        let directory = tempdir().expect("tempdir");
        std::fs::write(directory.path().join("index.json"), b"not-json").expect("write index");
        let loaded = read_index(directory.path()).await.expect("read index");
        assert!(loaded.dirty);
        assert!(loaded.index.entries.is_empty());
    }

    #[tokio::test]
    async fn orphan_cleanup_removes_only_owned_unleased_audio_files() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let orphan_name = format!("42-320000-{}.mp3", "b".repeat(64));
        let unrelated_name = "user-file.mp3";
        std::fs::write(directory.path().join(&orphan_name), b"orphan").expect("orphan");
        std::fs::write(directory.path().join(unrelated_name), b"user").expect("unrelated");

        cleanup_orphaned_files(directory.path(), &CacheIndex::default(), &state.inner)
            .await
            .expect("cleanup");

        assert!(!directory.path().join(orphan_name).exists());
        assert!(directory.path().join(unrelated_name).exists());
    }

    #[tokio::test]
    async fn metadata_size_mismatch_drops_corrupt_entry() {
        let directory = tempdir().expect("tempdir");
        let file_name = format!("42-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&file_name), b"bad").expect("write audio");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(cache_key(42, "320000"), entry(42, "320000", &file_name, 99));
        write_index(directory.path(), &index)
            .await
            .expect("write index");

        let loaded = read_index(directory.path()).await.expect("read index");
        assert!(loaded.dirty);
        assert!(loaded.index.entries.is_empty());
        assert!(!directory.path().join(file_name).exists());
    }

    #[tokio::test]
    async fn commit_is_atomic_and_evicts_least_recent_entry() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let old_name = format!("1-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&old_name), b"old").expect("old audio");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(cache_key(1, "320000"), entry(1, "320000", &old_name, 3));
        write_index(directory.path(), &index)
            .await
            .expect("write index");
        let chunks = stream::iter(vec![Ok::<_, &'static str>(Bytes::from_static(b"new!"))]);
        let download = download_stream(directory.path(), &state.inner, chunks, MAX_TRACK_BYTES)
            .await
            .expect("download");

        let result = commit_download(
            directory.path(),
            &state.inner,
            state.inner.generation.load(Ordering::Acquire),
            super::CacheStoreSpec {
                track_id: 2,
                quality: "320000".to_string(),
                mime_type: "audio/mpeg".to_string(),
                extension: "mp3",
                cache_limit_bytes: 4,
            },
            download,
        )
        .await
        .expect("commit");
        assert_eq!(result.evicted_entries, 1);
        assert_eq!(result.evicted_bytes, 3);
        assert!(!directory.path().join(old_name).exists());
        let loaded = read_index(directory.path()).await.expect("read index");
        assert_eq!(loaded.index.entries.len(), 1);
        assert!(loaded.index.entries.contains_key(&cache_key(2, "320000")));
        assert!(std::fs::read_dir(directory.path())
            .expect("directory")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".partial-")));
    }

    #[tokio::test]
    async fn failed_index_publish_keeps_previous_entry_and_removes_new_file() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let old_name = format!("1-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&old_name), b"old").expect("old audio");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(cache_key(1, "320000"), entry(1, "320000", &old_name, 3));
        *state.inner.resident_index.lock().await = Some(ResidentIndex {
            root: directory.path().to_path_buf(),
            index,
            access_updates: 0,
            access_flush_ms: super::now_ms(),
        });
        std::fs::create_dir(directory.path().join("index.json")).expect("blocking index path");
        let chunks = stream::iter([Ok::<_, &'static str>(Bytes::from_static(b"new!"))]);
        let download = download_stream(directory.path(), &state.inner, chunks, MAX_TRACK_BYTES)
            .await
            .expect("download");

        assert!(commit_download(
            directory.path(),
            &state.inner,
            state.inner.generation.load(Ordering::Acquire),
            super::CacheStoreSpec {
                track_id: 2,
                quality: "320000".to_string(),
                mime_type: "audio/mpeg".to_string(),
                extension: "mp3",
                cache_limit_bytes: 4,
            },
            download,
        )
        .await
        .is_err());
        assert!(directory.path().join(&old_name).exists());
        assert_eq!(
            state
                .inner
                .resident_index
                .lock()
                .await
                .as_ref()
                .expect("resident")
                .index
                .entries
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![cache_key(1, "320000")]
        );
        assert!(std::fs::read_dir(directory.path())
            .expect("directory")
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .all(|name| !name.starts_with("2-320000-")));
    }

    #[tokio::test]
    async fn leased_entry_is_never_evicted() {
        let directory = tempdir().expect("tempdir");
        let state = AudioCacheState::default();
        let old_name = format!("1-320000-{}.mp3", "a".repeat(64));
        std::fs::write(directory.path().join(&old_name), b"old").expect("old audio");
        let mut index = CacheIndex::default();
        index
            .entries
            .insert(cache_key(1, "320000"), entry(1, "320000", &old_name, 3));
        write_index(directory.path(), &index)
            .await
            .expect("write index");
        state.inner.leases.lock().await.insert(
            "lease".to_string(),
            super::Lease {
                key: cache_key(1, "320000"),
                file_name: old_name.clone(),
            },
        );
        let chunks = stream::iter(vec![Ok::<_, &'static str>(Bytes::from_static(b"new!"))]);
        let download = download_stream(directory.path(), &state.inner, chunks, MAX_TRACK_BYTES)
            .await
            .expect("download");

        let error = commit_download(
            directory.path(),
            &state.inner,
            state.inner.generation.load(Ordering::Acquire),
            super::CacheStoreSpec {
                track_id: 2,
                quality: "320000".to_string(),
                mime_type: "audio/mpeg".to_string(),
                extension: "mp3",
                cache_limit_bytes: 4,
            },
            download,
        )
        .await
        .expect_err("leased entry must remain");
        assert_eq!(error.kind, "capacity");
        assert!(directory.path().join(old_name).exists());
        let loaded = read_index(directory.path()).await.expect("read index");
        assert!(loaded.index.entries.contains_key(&cache_key(1, "320000")));
    }
}
