//! Migration errors. Every message names a shape or a count, never a value.

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("could not read {0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("storage copy is damaged: {0}")]
    Corrupt(String),
    /// A shape Markie does not write. The migration stops rather than guess.
    #[error("unexpected stored data: {0}")]
    Unsupported(String),
    /// The reader was pointed at a live profile instead of a copy.
    #[error("refusing to read {0} in place; copy it first")]
    LiveProfile(String),
}

pub type Result<T> = std::result::Result<T, MigrateError>;
