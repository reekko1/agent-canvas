// Secure storage for the Soniox API key. The key is a secret, so it's never
// written in the clear: safeStorage encrypts it with the OS keychain (the macOS
// Keychain here) and we keep only the ciphertext on disk, alongside the app's
// other config in SPINE_DIR. An exported SONIOX_API_KEY overrides the stored
// key — an explicit, env-driven override matching the orchestrator's auth posture.
import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SPINE_DIR } from '../spine/spine'

const KEY_PATH = join(SPINE_DIR, 'soniox.key')

function envKey(): string | undefined {
  const k = process.env.SONIOX_API_KEY?.trim()
  return k || undefined
}

/** The Soniox key in effect, or undefined if none is configured. Env wins; then
 *  the encrypted key on disk (only if the OS can still decrypt it). */
export function loadSonioxKey(): string | undefined {
  const env = envKey()
  if (env) return env
  try {
    if (!existsSync(KEY_PATH) || !safeStorage.isEncryptionAvailable()) return undefined
    const key = safeStorage.decryptString(readFileSync(KEY_PATH)).trim()
    return key || undefined
  } catch {
    // Corrupt ciphertext or a keychain we can't read — treat as unset.
    return undefined
  }
}

/** Where the key comes from — drives the onboarding step and lets the UI say
 *  "set in your environment" without ever revealing the value. */
export function sonioxKeySource(): 'env' | 'stored' | 'none' {
  if (envKey()) return 'env'
  try {
    if (existsSync(KEY_PATH) && safeStorage.isEncryptionAvailable()) return 'stored'
  } catch {
    /* unreadable — fall through to none */
  }
  return 'none'
}

/** Persist the key, OS-encrypted. Returns false when the platform can't encrypt —
 *  we refuse to fall back to plaintext for a secret. */
export function storeSonioxKey(key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed || !safeStorage.isEncryptionAvailable()) return false
  mkdirSync(SPINE_DIR, { recursive: true })
  writeFileSync(KEY_PATH, safeStorage.encryptString(trimmed), { mode: 0o600 })
  return true
}
