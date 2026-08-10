//! A single-owner native audio backend.
//!
//! The UI owns exactly one decoder/player chain. Audio files live in the core
//! cache and are decoded by rodio on its audio thread; no audio byte buffers are
//! copied into application state.

use std::{fs::File, path::Path, time::Duration};

use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSnapshot {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
}

pub struct NativePlayer {
    device: Option<MixerDeviceSink>,
    player: Option<Player>,
    duration_ms: u64,
    volume: f32,
}

impl Default for NativePlayer {
    fn default() -> Self {
        Self {
            device: None,
            player: None,
            duration_ms: 0,
            volume: 0.8,
        }
    }
}

impl NativePlayer {
    pub fn load_and_play(&mut self, path: &Path, seek_to_ms: u64) -> Result<AudioSnapshot, String> {
        self.load_and_play_with_loop(path, seek_to_ms, false)
    }

    /// Loads a source that should stay alive for a benchmark window.  The
    /// production player deliberately uses the non-looping path so the app
    /// can advance its service-ordered queue when a song ends.
    pub fn load_and_play_looping(
        &mut self,
        path: &Path,
        seek_to_ms: u64,
    ) -> Result<AudioSnapshot, String> {
        self.load_and_play_with_loop(path, seek_to_ms, true)
    }

    fn load_and_play_with_loop(
        &mut self,
        path: &Path,
        seek_to_ms: u64,
        looping: bool,
    ) -> Result<AudioSnapshot, String> {
        self.stop();
        self.ensure_device()?;
        let file = File::open(path).map_err(|error| format!("无法打开缓存音频：{error}"))?;
        let decoder =
            Decoder::try_from(file).map_err(|error| format!("无法解码缓存音频：{error}"))?;
        self.duration_ms = decoder
            .total_duration()
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or_default();
        let player = Player::connect_new(
            self.device
                .as_ref()
                .expect("audio device must exist after ensure_device")
                .mixer(),
        );
        player.set_volume(self.volume);
        player.pause();
        if looping {
            player.append(decoder.repeat_infinite());
        } else {
            player.append(decoder);
        }
        if seek_to_ms > 0 {
            player
                .try_seek(Duration::from_millis(seek_to_ms))
                .map_err(|error| format!("无法跳转播放进度：{error}"))?;
        }
        player.play();
        self.player = Some(player);
        Ok(self.snapshot())
    }

    pub fn play(&mut self) -> Result<AudioSnapshot, String> {
        let player = self
            .player
            .as_ref()
            .ok_or_else(|| "当前没有可播放的音频".to_string())?;
        player.play();
        Ok(self.snapshot())
    }

    pub fn pause(&mut self) -> Result<AudioSnapshot, String> {
        let player = self
            .player
            .as_ref()
            .ok_or_else(|| "当前没有可暂停的音频".to_string())?;
        player.pause();
        Ok(self.snapshot())
    }

    pub fn seek(&mut self, position_ms: u64) -> Result<AudioSnapshot, String> {
        let player = self
            .player
            .as_ref()
            .ok_or_else(|| "当前没有可跳转的音频".to_string())?;
        player
            .try_seek(Duration::from_millis(position_ms))
            .map_err(|error| format!("无法跳转播放进度：{error}"))?;
        Ok(self.snapshot())
    }

    pub fn set_volume(&mut self, value: f32) {
        self.volume = value.clamp(0.0, 1.0);
        if let Some(player) = &self.player {
            player.set_volume(self.volume);
        }
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        let raw_position_ms = self
            .player
            .as_ref()
            .map(|player| player.get_pos().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or_default();
        let position_ms = if self.duration_ms > 0 {
            raw_position_ms.min(self.duration_ms)
        } else {
            // A decoder is allowed not to expose a duration up front. Keep
            // its monotonic clock in that case; clamping to zero would make
            // progress, seek feedback and lyric timing appear frozen.
            raw_position_ms
        };
        AudioSnapshot {
            position_ms,
            duration_ms: self.duration_ms,
            playing: self
                .player
                .as_ref()
                .is_some_and(|player| !player.is_paused() && !player.empty()),
        }
    }

    pub fn has_finished(&self) -> bool {
        self.player.as_ref().is_some_and(Player::empty)
    }

    pub fn stop(&mut self) {
        if let Some(player) = self.player.take() {
            player.stop();
        }
        self.duration_ms = 0;
    }

    fn ensure_device(&mut self) -> Result<(), String> {
        if self.device.is_none() {
            let mut device = DeviceSinkBuilder::open_default_sink()
                .map_err(|error| format!("无法打开默认音频输出：{error}"))?;
            // Renderer output is in the alternate screen; rodio diagnostics must
            // not write over it during normal shutdown.
            device.log_on_drop(false);
            self.device = Some(device);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::NativePlayer;

    #[test]
    fn volume_is_always_bounded() {
        let mut player = NativePlayer::default();
        player.set_volume(2.0);
        assert_eq!(player.volume(), 1.0);
        player.set_volume(-1.0);
        assert_eq!(player.volume(), 0.0);
    }

    #[test]
    fn native_player_can_cross_a_blocking_task_boundary() {
        fn assert_send<T: Send>() {}
        assert_send::<NativePlayer>();
    }
}
