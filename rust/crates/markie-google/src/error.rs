//! What can go wrong, with the sentence a person sees for each.
use thiserror::Error;

pub type Result<T> = std::result::Result<T, GoogleError>;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GoogleError {
    /// No Desktop OAuth client was compiled in.
    #[error("Google Docs is not set up in this build.")]
    NotConfigured,
    /// The person closed the browser tab, said no, or cancelled in Markie.
    #[error("Google Docs connection was cancelled.")]
    Cancelled,
    #[error("Google didn't answer in time. Try again.")]
    Timeout,
    /// The refresh token was revoked or expired: connect again.
    #[error("Markie is no longer connected to Google. Connect again in Settings.")]
    Reconnect,
    #[error("Markie couldn't reach Google. Check your connection and try again.")]
    Network(String),
    /// Google refused or doesn't know the file. `drive.file` only covers picked files.
    #[error("Markie can't open this file in Google. Pick it again with Import from Google Docs.")]
    NoAccess(String),
    #[error("Google sent something Markie didn't expect.")]
    Parse(String),
    #[error("Google answered with an error ({status}).")]
    Http { status: u16, message: String },
    /// 429: too many requests. Markie waits and tries again.
    #[error("Google asked Markie to slow down. It will try again shortly.")]
    RateLimited { retry_after_secs: Option<u64> },
    /// The redirect did not belong to the flow Markie started.
    #[error("The answer from Google didn't match this connection. Try again.")]
    State,
    #[error("Markie couldn't save the file: {0}")]
    Io(String),
    #[error("Markie couldn't store the Google connection in the Keychain.")]
    Keychain,
    #[error("Markie couldn't update its records: {0}")]
    Store(String),
}

impl GoogleError {
    /// Worth trying again later on its own: the network, a timeout, a 429 or
    /// a server error. Anything else needs the person or a new pick.
    pub fn is_transient(&self) -> bool {
        match self {
            GoogleError::Network(_) | GoogleError::Timeout | GoogleError::RateLimited { .. } => true,
            GoogleError::Http { status, .. } => *status >= 500 || *status == 409,
            _ => false,
        }
    }
}

impl From<std::io::Error> for GoogleError {
    fn from(e: std::io::Error) -> Self {
        GoogleError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for GoogleError {
    fn from(e: rusqlite::Error) -> Self {
        GoogleError::Store(e.to_string())
    }
}

impl From<reqwest::Error> for GoogleError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            GoogleError::Timeout
        } else if e.is_decode() {
            GoogleError::Parse(e.to_string())
        } else {
            GoogleError::Network(e.to_string())
        }
    }
}
