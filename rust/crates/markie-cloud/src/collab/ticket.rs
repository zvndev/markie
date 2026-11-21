//! When to ask for a live-editing ticket. Pure rules from connectWithTicket in
//! src/lib/collab.ts; the room supervisor applies them.
use crate::sharing::CollabTicketAnswer;

/// Refresh the ticket in place well inside its 5-minute life.
pub const TICKET_REFRESH_MS: u64 = 2 * 60 * 1000;
/// A close soon after the last ask does not ask again.
pub const TICKET_CLOSE_REFRESH_MIN_MS: u64 = 30 * 1000;
/// Retries for the first ticket on a transient failure.
pub const FIRST_TICKET_RETRY_MS: [u64; 3] = [1000, 3000, 6000];

/// Offline, timeout, rate limit or a server error: worth trying again.
pub fn is_transient(answer: &CollabTicketAnswer) -> bool {
    matches!(answer, CollabTicketAnswer::Failed { status } if *status == 0 || *status == 408 || *status == 429 || *status >= 500)
}

/// What to do about the first ticket answer, on attempt `attempt` (0-based).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirstTicket {
    Connect(String),
    RetryAfterMs(u64),
    /// A server from before tickets. This client does not put a session token
    /// in a URL, so live editing is unavailable there.
    Legacy,
    Unavailable,
}

pub fn first_ticket(answer: &CollabTicketAnswer, attempt: usize) -> FirstTicket {
    match answer {
        CollabTicketAnswer::Ticket { ticket, .. } => FirstTicket::Connect(ticket.clone()),
        CollabTicketAnswer::Legacy => FirstTicket::Legacy,
        a if is_transient(a) && attempt < FIRST_TICKET_RETRY_MS.len() => FirstTicket::RetryAfterMs(FIRST_TICKET_RETRY_MS[attempt]),
        _ => FirstTicket::Unavailable,
    }
}

/// What a socket close means for the ticket loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    /// An application close (4000-4999): stop for good.
    Halt,
    /// Fetch a fresh ticket before the reconnect.
    Refresh,
    /// The ticket is fresh enough; reconnect with it.
    Keep,
}

pub fn on_close(code: Option<u16>, ms_since_asked: u64) -> OnClose {
    if code.is_some_and(|c| (4000..5000).contains(&c)) {
        return OnClose::Halt;
    }
    if ms_since_asked < TICKET_CLOSE_REFRESH_MIN_MS { OnClose::Keep } else { OnClose::Refresh }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_failures_are_retried_three_times() {
        let f = |s| CollabTicketAnswer::Failed { status: s };
        assert_eq!(first_ticket(&f(0), 0), FirstTicket::RetryAfterMs(1000));
        assert_eq!(first_ticket(&f(503), 1), FirstTicket::RetryAfterMs(3000));
        assert_eq!(first_ticket(&f(429), 2), FirstTicket::RetryAfterMs(6000));
        assert_eq!(first_ticket(&f(429), 3), FirstTicket::Unavailable);
        assert_eq!(first_ticket(&f(404), 0), FirstTicket::Unavailable);
        assert_eq!(first_ticket(&f(409), 0), FirstTicket::Unavailable);
        assert_eq!(first_ticket(&CollabTicketAnswer::Legacy, 0), FirstTicket::Legacy);
        assert_eq!(first_ticket(&CollabTicketAnswer::Ticket { ticket: "t".into(), expires_at: 1 }, 0), FirstTicket::Connect("t".into()));
    }

    #[test]
    fn application_closes_halt() {
        assert_eq!(on_close(Some(4403), 999_999), OnClose::Halt);
        assert_eq!(on_close(Some(4426), 0), OnClose::Halt);
        assert_eq!(on_close(Some(1006), 10_000), OnClose::Keep);
        assert_eq!(on_close(None, 31_000), OnClose::Refresh);
        assert_eq!(on_close(Some(1012), 31_000), OnClose::Refresh);
    }
}
