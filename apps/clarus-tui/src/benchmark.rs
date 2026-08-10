//! Small, explicit playback benchmark harness.
//!
//! The production player stays native by default for the first vertical slice,
//! but this command keeps the final backend decision evidence based. In
//! particular, the external-player measurement samples both the TUI process and
//! the child process so a low parent RSS cannot hide mpv's real cost.

use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};

use crate::audio::NativePlayer;

const MIN_BENCHMARK_SECONDS: u64 = 3;
const MAX_BENCHMARK_SECONDS: u64 = 30 * 60;

#[derive(Debug)]
struct Measurement {
    name: &'static str,
    startup: Duration,
    average_cpu_percent: f64,
    peak_rss_kib: u64,
    initial_rss_kib: u64,
    final_rss_kib: u64,
    initial_thread_count: Option<u64>,
    final_thread_count: Option<u64>,
    samples: u32,
    note: String,
}

pub fn run(arguments: &[String]) -> Result<()> {
    let Some(path) = arguments.first().map(Path::new) else {
        return Err(anyhow!(
            "用法：clarus-tui --benchmark-audio <本地音频文件> [秒数]"
        ));
    };
    if !path.is_file() {
        return Err(anyhow!("音频文件不存在：{}", path.display()));
    }
    let duration = arguments
        .get(1)
        .map(|value| value.parse::<u64>().context("秒数必须是正整数"))
        .transpose()?
        .unwrap_or(20)
        .clamp(MIN_BENCHMARK_SECONDS, MAX_BENCHMARK_SECONDS);
    let duration = Duration::from_secs(duration);

    println!("Clarus Music 音频后端基准");
    println!("文件：{}", path.display());
    println!("采样窗口：{} 秒\n", duration.as_secs());

    match benchmark_native(path, duration) {
        Ok(measurement) => print_measurement(&measurement),
        Err(error) => println!("native rodio：不可用（{error}）"),
    }
    match benchmark_mpv(path, duration) {
        Ok(Some(measurement)) => print_measurement(&measurement),
        Ok(None) => println!("mpv：未安装，未纳入本次比较"),
        Err(error) => println!("mpv：不可用（{error}）"),
    }
    println!(
        "\n说明：CPU 为采样平均值，RSS 为峰值；mpv 数字已包含主进程和子进程。请在同一台机器、同一首歌和同一音频输出设备下比较后再确定最终后端。"
    );
    Ok(())
}

fn benchmark_native(path: &Path, duration: Duration) -> Result<Measurement> {
    let mut player = NativePlayer::default();
    let started = Instant::now();
    player
        .load_and_play_looping(path, 0)
        .map_err(|error| anyhow!(error))?;
    let startup = started.elapsed();
    let pids = [std::process::id()];
    let initial_thread_count = total_thread_count(&pids);
    let samples = sample_for(duration, &pids, || player.has_finished());
    let final_thread_count = total_thread_count(&pids);
    player.stop();
    Ok(Measurement::from_samples(
        "native rodio",
        startup,
        samples,
        initial_thread_count,
        final_thread_count,
        "原生 decoder + 系统默认输出",
    ))
}

fn benchmark_mpv(path: &Path, duration: Duration) -> Result<Option<Measurement>> {
    if Command::new("mpv")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_err()
    {
        return Ok(None);
    }
    let started = Instant::now();
    let mut child = Command::new("mpv")
        .args([
            "--no-video",
            "--really-quiet",
            "--force-window=no",
            "--loop-file=inf",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("无法启动 mpv")?;
    let startup = started.elapsed();
    let child_pid = child.id();
    let pids = [std::process::id(), child_pid];
    let initial_thread_count = total_thread_count(&pids);
    let samples = sample_for(duration, &pids, || {
        child.try_wait().ok().flatten().is_some()
    });
    let final_thread_count = total_thread_count(&pids);
    if child.try_wait()?.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(Some(Measurement::from_samples(
        "mpv（主进程 + 子进程）",
        startup,
        samples,
        initial_thread_count,
        final_thread_count,
        "外部播放器；总量包含 clarus-tui 与 mpv",
    )))
}

impl Measurement {
    fn from_samples(
        name: &'static str,
        startup: Duration,
        samples: Vec<ProcessSample>,
        initial_thread_count: Option<u64>,
        final_thread_count: Option<u64>,
        note: &str,
    ) -> Self {
        let samples_len = samples.len() as u32;
        let average_cpu_percent = if samples.is_empty() {
            0.0
        } else {
            samples.iter().map(|sample| sample.cpu_percent).sum::<f64>() / samples.len() as f64
        };
        let peak_rss_kib = samples
            .iter()
            .map(|sample| sample.rss_kib)
            .max()
            .unwrap_or_default();
        let initial_rss_kib = samples
            .first()
            .map(|sample| sample.rss_kib)
            .unwrap_or_default();
        let final_rss_kib = samples
            .last()
            .map(|sample| sample.rss_kib)
            .unwrap_or_default();
        Self {
            name,
            startup,
            average_cpu_percent,
            peak_rss_kib,
            initial_rss_kib,
            final_rss_kib,
            initial_thread_count,
            final_thread_count,
            samples: samples_len,
            note: note.to_string(),
        }
    }
}

#[derive(Debug, Default)]
struct ProcessSample {
    cpu_percent: f64,
    rss_kib: u64,
}

fn sample_for(
    duration: Duration,
    pids: &[u32],
    finished: impl FnMut() -> bool,
) -> Vec<ProcessSample> {
    let started = Instant::now();
    let mut samples = Vec::new();
    let mut finished = finished;
    while started.elapsed() < duration {
        if finished() {
            break;
        }
        if let Some(sample) = process_sample(pids) {
            samples.push(sample);
        }
        let remaining = duration.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(remaining.min(Duration::from_millis(250)));
    }
    samples
}

fn process_sample(pids: &[u32]) -> Option<ProcessSample> {
    let ids = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let output = Command::new("ps")
        .args(["-o", "rss=,pcpu=", "-p", &ids])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut sample = ProcessSample::default();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(rss), Some(cpu)) = (fields.next(), fields.next()) else {
            continue;
        };
        sample.rss_kib = sample.rss_kib.saturating_add(rss.parse().ok()?);
        sample.cpu_percent += cpu.parse::<f64>().ok()?;
    }
    Some(sample)
}

/// Count only at the beginning and end of a benchmark. Sampling this via a
/// separate system command every 250ms would itself perturb the CPU result,
/// whereas the two snapshots are enough to expose an obvious thread leak over
/// a long run.
fn total_thread_count(pids: &[u32]) -> Option<u64> {
    let mut total = 0_u64;
    let mut observed = false;
    for pid in pids {
        if let Some(count) = process_thread_count(*pid) {
            total = total.saturating_add(count);
            observed = true;
        }
    }
    observed.then_some(total)
}

#[cfg(target_os = "macos")]
fn process_thread_count(pid: u32) -> Option<u64> {
    // `ps -M` prints one process/thread row after its header on macOS. Avoid
    // mixing it into the RSS/CPU sample command because the BSD and procps
    // implementations expose incompatible thread-count columns.
    let pid_text = pid.to_string();
    let output = Command::new("ps")
        .args(["-M", "-p", &pid_text])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // The first row is the process itself and starts with the username. Each
    // following thread row starts with the numeric PID. A wrapped command
    // line can contain non-PID continuation rows, so counting non-empty lines
    // would over-report threads for long executable arguments.
    let thread_rows = String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            // Real thread rows contain PID plus the scheduler columns. A
            // wrapped COMMAND continuation can also begin with the PID, but
            // has fewer fields and must not be counted as another thread.
            fields.first().copied() == Some(pid_text.as_str()) && fields.len() >= 5
        })
        .count() as u64;
    (thread_rows > 0).then_some(thread_rows.saturating_add(1))
}

#[cfg(target_os = "linux")]
fn process_thread_count(pid: u32) -> Option<u64> {
    let count = std::fs::read_dir(format!("/proc/{pid}/task"))
        .ok()?
        .filter_map(Result::ok)
        .count() as u64;
    (count > 0).then_some(count)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_thread_count(_pid: u32) -> Option<u64> {
    None
}

fn print_measurement(measurement: &Measurement) {
    let rss_delta_kib = measurement.final_rss_kib as i64 - measurement.initial_rss_kib as i64;
    let thread_summary = match (
        measurement.initial_thread_count,
        measurement.final_thread_count,
    ) {
        (Some(initial), Some(final_count)) => format!("线程 {initial}→{final_count}"),
        _ => "线程 不可用".to_string(),
    };
    println!(
        "{}\n  启动 {:.1} ms · 平均 CPU {:.2}% · 峰值 RSS {:.1} MiB · RSS 首尾 {:+.1} MiB · {} · {} 个样本\n  {}",
        measurement.name,
        measurement.startup.as_secs_f64() * 1_000.0,
        measurement.average_cpu_percent,
        measurement.peak_rss_kib as f64 / 1024.0,
        rss_delta_kib as f64 / 1024.0,
        thread_summary,
        measurement.samples,
        measurement.note,
    );
}

#[cfg(test)]
mod tests {
    use super::{Measurement, MAX_BENCHMARK_SECONDS, MIN_BENCHMARK_SECONDS};
    use std::time::Duration;

    #[test]
    fn empty_samples_produce_a_safe_report() {
        let result =
            Measurement::from_samples("test", Duration::ZERO, Vec::new(), None, None, "test");
        assert_eq!(result.samples, 0);
        assert_eq!(result.peak_rss_kib, 0);
        assert_eq!(result.initial_rss_kib, 0);
        assert_eq!(result.final_rss_kib, 0);
        assert_eq!(result.initial_thread_count, None);
        assert_eq!(result.final_thread_count, None);
    }

    #[test]
    fn benchmark_window_supports_the_required_thirty_minute_run() {
        assert_eq!(MIN_BENCHMARK_SECONDS, 3);
        assert_eq!(MAX_BENCHMARK_SECONDS, 1_800);
        assert_eq!(
            20_u64.clamp(MIN_BENCHMARK_SECONDS, MAX_BENCHMARK_SECONDS),
            20
        );
        assert_eq!(1_u64.clamp(MIN_BENCHMARK_SECONDS, MAX_BENCHMARK_SECONDS), 3);
        assert_eq!(
            3_600_u64.clamp(MIN_BENCHMARK_SECONDS, MAX_BENCHMARK_SECONDS),
            1_800
        );
    }
}
