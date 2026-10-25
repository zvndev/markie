// The Keychain (iOS) and Keystore (Android) behind session.ts.
//
// @aparajita/capacitor-secure-storage keeps values in the Keychain on iOS and
// encrypts them with a non-exportable AndroidKeyStore key on Android. Its web
// fallback writes to localStorage, so it is never used off a device: a desktop
// browser gets memory only.
import { Capacitor } from "@capacitor/core";
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { memoryKeyValue, type SecureKeyValue } from "./session";

let configured: Promise<void> | null = null;

function configure(): Promise<void> {
  // Not in iCloud Keychain, and only on this device after its first unlock:
  // a session should not follow a backup to another phone.
  configured ??= Promise.all([
    SecureStorage.setSynchronize(false),
    SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly),
  ]).then(() => undefined);
  return configured;
}

export function platformSecureStore(isNative = Capacitor.isNativePlatform()): SecureKeyValue {
  if (!isNative) return memoryKeyValue();
  return {
    async get(key) {
      await configure();
      const value = await SecureStorage.get(key, false, false);
      return typeof value === "string" ? value : null;
    },
    async set(key, value) {
      await configure();
      await SecureStorage.set(key, value, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly);
    },
    async remove(key) {
      await configure();
      await SecureStorage.remove(key, false);
    },
  };
}
