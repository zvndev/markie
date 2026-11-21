//! Markie RS vault: the encrypted local vault, byte-compatible with the
//! Electron app's `src/lib/vault/*`, plus Touch ID, Keychain and the secret
//! clipboard. No UI and no GPUI dependency.
//!
//! Compatibility both ways is checked by `compat/vault-compat.mjs`, which runs
//! the repo's own TypeScript against this crate's `vault-compat` binary.
pub mod backup;
pub mod clipboard;
pub mod device;
pub mod dotenv;
pub mod envelope;
pub mod error;
pub mod passphrase;
pub mod repository;
pub mod storage;
pub mod vault;

pub use error::{DeviceFailure, StorageErrorCode, VaultError, VaultErrorCode};
pub use repository::{VaultEntry, VaultRepository};
pub use storage::{FileVaultStorage, MemoryVaultStorage, StoredRecord, StoredVault, VaultStorage};
pub use vault::{Vault, VAULT_DEVICE_SECRET_BYTES};
