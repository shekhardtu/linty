use std::time::{Duration, Instant};

pub const QUIET_WARNING_SECS: u64 = 20;
pub const QUIET_STOP_SECS: u64 = 30;
const FRAME_SAMPLES: usize = 1600; // 100 ms at 16 kHz, independent of device callback size.
const MIN_RMS: f32 = 0.00001;

/// A cheap inactivity guard, not a speech recognizer. The lower envelope adapts
/// to steady room noise; two active frames reject isolated clicks. Audio sent
/// to ASR is never cropped or amplified by this monitor.
pub struct InputActivity {
    last_input: Instant,
    pub heard_input: bool,
    levels: [f32; 50],
    frames: usize,
    energy: f32,
    peak: f32,
    samples: usize,
    active_frames: u8,
}

impl InputActivity {
    pub fn new(now: Instant) -> Self {
        Self {
            last_input: now,
            heard_input: false,
            levels: [MIN_RMS; 50],
            frames: 0,
            energy: 0.0,
            peak: 0.0,
            samples: 0,
            active_frames: 0,
        }
    }

    pub fn observe(&mut self, samples: &[f32], now: Instant) {
        for &sample in samples {
            let sample = if sample.is_finite() { sample } else { 0.0 };
            self.energy += sample * sample;
            self.peak = self.peak.max(sample.abs());
            self.samples += 1;
            if self.samples < FRAME_SAMPLES {
                continue;
            }
            let rms = (self.energy / FRAME_SAMPLES as f32).sqrt();
            let mut sorted = self.levels;
            sorted.sort_unstable_by(f32::total_cmp);
            let floor = sorted[10].max(MIN_RMS);
            // Relative level preserves quiet voices without a fixed loudness gate.
            let active = rms > floor * 1.6 && self.peak > floor * 3.0;
            self.active_frames = if active {
                self.active_frames.saturating_add(1)
            } else {
                0
            };
            if self.active_frames >= 2 {
                self.last_input = now;
                self.heard_input = true;
            }
            self.levels[self.frames % self.levels.len()] = rms;
            self.frames = self.frames.wrapping_add(1);
            self.energy = 0.0;
            self.peak = 0.0;
            self.samples = 0;
        }
    }

    pub fn quiet_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(amplitude: f32) -> Vec<f32> {
        (0..FRAME_SAMPLES)
            .map(|i| if i % 8 == 0 { amplitude } else { 0.0 })
            .collect()
    }

    #[test]
    fn silence_warns_at_twenty_and_stops_at_thirty() {
        let start = Instant::now();
        let mut activity = InputActivity::new(start);
        activity.observe(&[0.0; FRAME_SAMPLES], start + Duration::from_secs(19));
        assert!(!activity.heard_input);
        assert!(
            activity
                .quiet_for(start + Duration::from_secs(19))
                .as_secs()
                < QUIET_WARNING_SECS
        );
        assert_eq!(
            activity
                .quiet_for(start + Duration::from_secs(20))
                .as_secs(),
            QUIET_WARNING_SECS
        );
        assert_eq!(
            activity
                .quiet_for(start + Duration::from_secs(30))
                .as_secs(),
            QUIET_STOP_SECS
        );
    }

    #[test]
    fn quiet_input_rescues_the_countdown_but_one_click_does_not() {
        let start = Instant::now();
        let mut activity = InputActivity::new(start);
        let late = start + Duration::from_secs(25);
        activity.observe(&frame(0.0001), late);
        assert!(!activity.heard_input);
        activity.observe(&frame(0.0001), late + Duration::from_millis(100));
        assert!(activity.heard_input);
        assert!(
            activity
                .quiet_for(late + Duration::from_millis(200))
                .as_secs()
                == 0
        );
    }

    #[test]
    fn steady_background_does_not_keep_capture_alive() {
        let start = Instant::now();
        let mut activity = InputActivity::new(start);
        for i in 0..400 {
            activity.observe(&frame(0.01), start + Duration::from_millis(i * 100));
        }
        assert!(
            activity
                .quiet_for(start + Duration::from_secs(40))
                .as_secs()
                >= QUIET_STOP_SECS
        );
        // A fresh session cannot inherit the previous input or deadline.
        assert!(!InputActivity::new(start).heard_input);
    }

    #[test]
    fn modulated_quiet_input_keeps_a_long_capture_alive_across_callback_sizes() {
        let start = Instant::now();
        let mut activity = InputActivity::new(start);
        for i in 0..1200 {
            let amplitude = if i % 20 < 12 { 0.0002 } else { 0.00001 };
            let samples = frame(amplitude);
            let now = start + Duration::from_millis(i * 100);
            for chunk in samples.chunks(317) {
                activity.observe(chunk, now);
            }
            assert!(activity.quiet_for(now).as_secs() < QUIET_WARNING_SECS);
        }
        assert!(activity.heard_input);
    }
}
