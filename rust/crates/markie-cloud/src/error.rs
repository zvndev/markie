use thiserror::Error;

/// Why a cloud call did not produce what was asked.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CloudError {
    /// The origin is not on the trusted list, so nothing was sent.
    #[error("That server isn't one of your Markie servers.")]
    NotTrusted,
    /// The path or request shape is not one this client may send.
    #[error("That request isn't allowed.")]
    Refused,
    /// No session for this server.
    #[error("Not signed in to this server.")]
    NotSignedIn,
    /// The request never reached the server (offline, DNS, timeout).
    #[error("Couldn't reach the server.")]
    Offline,
    /// The answer was bigger than this client reads.
    #[error("The server's answer was too large.")]
    TooLarge,
    /// A 2xx whose body was not the JSON shape expected.
    #[error("The server sent an answer this app can't read.")]
    Unreadable,
    /// The server answered with a non-2xx status.
    #[error("The server answered {status}{}", message.as_deref().map(|m| format!(": {m}")).unwrap_or_default())]
    Status { status: u16, message: Option<String> },
    /// The session changed while the request was in flight; its answer was dropped.
    #[error("Your sign-in changed during the request.")]
    StaleSession,
    /// Local storage of a token failed.
    #[error("Couldn't store the sign-in: {0}")]
    Storage(String),
    /// A rule this client enforces itself (for example an auth deep link).
    #[error("{0}")]
    Invalid(String),
}

impl CloudError {
    pub fn status(&self) -> Option<u16> {
        match self {
            CloudError::Status { status, .. } => Some(*status),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, CloudError>;
