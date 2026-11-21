//! Errors with the same codes the TypeScript throws, so UI copy can map 1:1.

/// `VaultErrorCode` in envelope.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultErrorCode {
    InvalidEnvelope,
    LimitExceeded,
    InvalidPassphrase,
    AuthenticationFailed,
    Locked,
    Busy,
    Unavailable,
}

/// `VaultStorageErrorCode` in storage.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageErrorCode {
    Unavailable,
    Corrupt,
    Conflict,
    Quota,
    Aborted,
    StorageFailed,
}

/// `VaultDeviceFailure` plus `stale` from repository.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceFailure {
    Missing,
    Cancelled,
    Unavailable,
    Busy,
    /// The keychain secret no longer opens this vault's device slot.
    Stale,
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("Vault operation failed: {0:?}")]
    Vault(VaultErrorCode),
    #[error("Vault storage: {0:?}")]
    Storage(StorageErrorCode),
    #[error("Device unlock failed: {0:?}")]
    Device(DeviceFailure),
    #[error("This is not a Markie vault backup.")]
    Backup,
    /// A failed save keeps its encrypted draft in memory under this ID.
    #[error("The encrypted document could not be committed.")]
    Save { document_id: String, failure: Box<VaultError> },
}

impl VaultError {
    pub fn code(&self) -> Option<VaultErrorCode> {
        match self {
            VaultError::Vault(code) => Some(*code),
            _ => None,
        }
    }
    pub fn storage_code(&self) -> Option<StorageErrorCode> {
        match self {
            VaultError::Storage(code) => Some(*code),
            _ => None,
        }
    }
}

impl From<VaultErrorCode> for VaultError {
    fn from(code: VaultErrorCode) -> Self {
        VaultError::Vault(code)
    }
}

impl From<StorageErrorCode> for VaultError {
    fn from(code: StorageErrorCode) -> Self {
        VaultError::Storage(code)
    }
}

impl From<DeviceFailure> for VaultError {
    fn from(f: DeviceFailure) -> Self {
        VaultError::Device(f)
    }
}
