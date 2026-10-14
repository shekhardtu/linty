use std::time::{Duration, Instant};

const REBUILD_INTERVAL: Duration = Duration::from_secs(30);
const REBUILD_WINDOW: Duration = Duration::from_secs(300);
const REBUILD_LIMIT: usize = 3;

/// Native visibility checks are tied to a presentation epoch, not a timer's
/// lifetime. Hiding/replacing the panel invalidates every outstanding check.
#[derive(Default)]
pub(super) struct SpaceRecovery {
    epoch: u64,
    probing: bool,
    pending: bool,
    rebuilding: bool,
    rebuilds: Vec<Instant>,
}

impl SpaceRecovery {
    pub(super) fn begin_probe(&mut self) -> Option<u64> {
        if self.probing || self.pending || self.rebuilding {
            return None;
        }
        self.epoch += 1;
        self.probing = true;
        Some(self.epoch)
    }

    pub(super) fn current(&self, epoch: u64) -> bool {
        self.probing && self.epoch == epoch
    }

    pub(super) fn finish(&mut self, epoch: u64, recovered: bool) {
        if self.current(epoch) {
            self.probing = false;
            self.pending = !recovered;
        }
    }

    pub(super) fn cancel_probe(&mut self) {
        self.epoch += 1;
        self.probing = false;
    }

    pub(super) fn rebuilding(&self) -> bool {
        self.rebuilding
    }

    pub(super) fn begin_rebuild(&mut self, idle: bool, now: Instant) -> bool {
        if !idle || !self.pending || self.rebuilding {
            return false;
        }
        self.rebuilds
            .retain(|at| now.duration_since(*at) < REBUILD_WINDOW);
        if self.rebuilds.len() >= REBUILD_LIMIT
            || self
                .rebuilds
                .last()
                .is_some_and(|at| now.duration_since(*at) < REBUILD_INTERVAL)
        {
            return false;
        }
        self.cancel_probe();
        self.rebuilding = true;
        self.rebuilds.push(now);
        true
    }

    pub(super) fn rebuilt(&mut self, success: bool) {
        self.rebuilding = false;
        self.pending = !success;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_or_replaced_presentations_cannot_report_recovery() {
        let mut state = SpaceRecovery::default();
        let old = state.begin_probe().unwrap();
        assert!(state.begin_probe().is_none());
        state.cancel_probe();
        let current = state.begin_probe().unwrap();
        state.finish(old, false);
        assert!(state.current(current));
        state.finish(current, true);
        assert!(!state.begin_rebuild(true, Instant::now()));
    }

    #[test]
    fn failures_wait_for_idle_and_rebuilds_are_serialized_and_bounded() {
        let mut state = SpaceRecovery::default();
        let now = Instant::now();
        let probe = state.begin_probe().unwrap();
        state.finish(probe, false);
        assert!(!state.begin_rebuild(false, now));
        assert!(state.begin_probe().is_none());
        assert!(state.begin_rebuild(true, now));
        assert!(!state.begin_rebuild(true, now + REBUILD_INTERVAL));
        state.rebuilt(false);
        assert!(!state.begin_rebuild(true, now + Duration::from_secs(1)));
        assert!(state.begin_rebuild(true, now + REBUILD_INTERVAL));
        state.rebuilt(false);
        assert!(state.begin_rebuild(true, now + REBUILD_INTERVAL * 2));
        state.rebuilt(false);
        assert!(!state.begin_rebuild(true, now + REBUILD_INTERVAL * 3));
        assert!(state.begin_rebuild(true, now + REBUILD_WINDOW));
        state.rebuilt(true);
        assert!(state.begin_probe().is_some());
    }
}
