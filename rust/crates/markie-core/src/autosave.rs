//! When to autosave: after 1 s without typing, and at least every 5 s during
//! continuous typing. Mirrors `src/lib/autosave.ts`. Pure timing, so the UI
//! owns the timer and this decides.

use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Autosave {
    idle: Duration,
    max_wait: Duration,
    burst_start: Option<Instant>,
    last_change: Option<Instant>,
}

impl Default for Autosave {
    fn default() -> Self {
        Self::new(Duration::from_millis(1000), Duration::from_millis(5000))
    }
}

impl Autosave {
    pub fn new(idle: Duration, max_wait: Duration) -> Self {
        Self { idle, max_wait, burst_start: None, last_change: None }
    }

    pub fn note_change(&mut self, now: Instant) {
        self.burst_start.get_or_insert(now);
        self.last_change = Some(now);
    }

    pub fn is_pending(&self) -> bool {
        self.last_change.is_some()
    }

    /// When the next save is due, if one is pending.
    pub fn due_at(&self) -> Option<Instant> {
        let last = self.last_change?;
        let start = self.burst_start.unwrap_or(last);
        Some((last + self.idle).min(start + self.max_wait))
    }

    /// True when a save should run now. Clears the pending state.
    pub fn take_due(&mut self, now: Instant) -> bool {
        match self.due_at() {
            Some(due) if now >= due => {
                self.cancel();
                true
            }
            _ => false,
        }
    }

    pub fn cancel(&mut self) {
        self.burst_start = None;
        self.last_change = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_and_max_wait() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut a = Autosave::default();
        assert!(!a.take_due(t0));
        a.note_change(t0);
        assert_eq!(a.due_at(), Some(t0 + ms(1000)));
        assert!(!a.take_due(t0 + ms(999)));
        assert!(a.take_due(t0 + ms(1000)));
        // Typing every 400 ms never goes idle, so the 5 s ceiling saves.
        let mut t = t0;
        a.note_change(t);
        for _ in 0..20 {
            t += ms(400);
            a.note_change(t);
        }
        assert_eq!(a.due_at(), Some(t0 + ms(5000)));
    }
}
