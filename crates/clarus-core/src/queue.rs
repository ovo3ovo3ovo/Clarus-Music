use std::collections::HashSet;

use crate::Track;

/// Identifies the service-ordered source currently owning a playback queue.
/// Presentation code can use this to reject stale page appends without
/// copying or tagging every track model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QueueSource {
    #[default]
    None,
    Daily,
    Playlist(i64),
}

/// Bounded, UI-independent playback queue.
///
/// The queue owns service order and a cursor; it deliberately does not own an
/// audio decoder.  A client can replace the decoder while keeping this model
/// stable, and page hydration can append only to the source that still owns
/// it.
#[derive(Debug, Clone, Default)]
pub struct PlaybackQueue {
    tracks: Vec<Track>,
    current_index: Option<usize>,
    source: QueueSource,
}

impl PlaybackQueue {
    pub fn new(tracks: Vec<Track>, source: QueueSource, current_index: Option<usize>) -> Self {
        let current_index = current_index.filter(|index| *index < tracks.len());
        Self {
            tracks,
            current_index,
            source,
        }
    }

    pub fn replace(
        &mut self,
        tracks: Vec<Track>,
        source: QueueSource,
        current_index: Option<usize>,
    ) {
        *self = Self::new(tracks, source, current_index);
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
        self.current_index = None;
        self.source = QueueSource::None;
    }

    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    pub fn source(&self) -> QueueSource {
        self.source
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current_index
    }

    pub fn current(&self) -> Option<&Track> {
        self.current_index.and_then(|index| self.tracks.get(index))
    }

    pub fn track_at(&self, index: usize) -> Option<&Track> {
        self.tracks.get(index)
    }

    pub fn set_current_index(&mut self, index: usize) -> Option<&Track> {
        if index >= self.tracks.len() {
            return None;
        }
        self.current_index = Some(index);
        self.current()
    }

    pub fn set_current_track(&mut self, track_id: i64) -> Option<usize> {
        let index = self.tracks.iter().position(|track| track.id == track_id)?;
        self.current_index = Some(index);
        Some(index)
    }

    pub fn is_queued_after(&self, track_id: i64) -> bool {
        let Some(current_index) = self.current_index else {
            return false;
        };
        self.tracks
            .iter()
            .position(|track| track.id == track_id)
            .is_some_and(|index| index > current_index)
    }

    pub fn next_index(&self) -> Option<usize> {
        self.current_index
            .and_then(|index| index.checked_add(1))
            .filter(|index| *index < self.tracks.len())
    }

    pub fn previous_index(&self) -> Option<usize> {
        self.current_index.and_then(|index| index.checked_sub(1))
    }

    pub fn advance_next(&mut self) -> Option<&Track> {
        let index = self.next_index()?;
        self.current_index = Some(index);
        self.current()
    }

    pub fn advance_previous(&mut self) -> Option<&Track> {
        let index = self.previous_index()?;
        self.current_index = Some(index);
        self.current()
    }

    /// Appends only tracks not already in the queue, preserving the exact
    /// order supplied by the service.  Returns how many entries were added.
    pub fn append_unique(&mut self, tracks: impl IntoIterator<Item = Track>) -> usize {
        let mut known = self
            .tracks
            .iter()
            .map(|track| track.id)
            .collect::<HashSet<_>>();
        let mut added = 0;
        for track in tracks {
            if known.insert(track.id) {
                self.tracks.push(track);
                added += 1;
            }
        }
        added
    }
}

#[cfg(test)]
mod tests {
    use clarus_core_test_support::track;

    use super::{PlaybackQueue, QueueSource};

    // This private alias keeps the fixture below readable without making the
    // production crate depend on a test-only helper crate.
    mod clarus_core_test_support {
        use crate::{Album, Artist, Track};

        pub fn track(id: i64) -> Track {
            Track {
                id,
                name: format!("track-{id}"),
                duration_ms: 1_000,
                artists: vec![Artist {
                    id: 1,
                    name: "artist".to_string(),
                }],
                album: Album {
                    id: 1,
                    name: "album".to_string(),
                },
                aliases: Vec::new(),
                translated_names: Vec::new(),
                explicit: false,
                playable: true,
                unavailable_reason: None,
            }
        }
    }

    #[test]
    fn advances_in_service_order_and_appends_without_duplicates() {
        let mut queue =
            PlaybackQueue::new(vec![track(1), track(2)], QueueSource::Playlist(42), Some(0));
        assert_eq!(queue.current().map(|track| track.id), Some(1));
        assert_eq!(queue.advance_next().map(|track| track.id), Some(2));
        assert_eq!(queue.advance_next(), None);
        assert_eq!(queue.append_unique(vec![track(2), track(3), track(4)]), 2);
        assert_eq!(
            queue
                .tracks()
                .iter()
                .map(|track| track.id)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(queue.source(), QueueSource::Playlist(42));
    }
}
