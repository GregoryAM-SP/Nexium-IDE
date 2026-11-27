//! Provider API keys live in the operating system's credential store
//! (Windows Credential Manager, macOS Keychain, the Linux kernel keyring)
//! instead of the webview's `localStorage`, which is a plain file on disk that
//! any script running in the page can read. Each provider has its own entry.

use std::collections::HashMap;

use keyring::{Entry, Error};

const SERVICE: &str = "com.nexium.studio";
/// The single NVIDIA key from before providers existed; read as NVIDIA's key
/// and moved to the per-provider entry the first time it is found.
const LEGACY_ACCOUNT: &str = "nvidia-nim-api-key";
const LEGACY_PROVIDER: &str = "nvidia";

fn valid_provider(provider: &str) -> Result<(), String> {
    let ok = !provider.is_empty()
        && provider.len() <= 64
        && provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if ok {
        Ok(())
    } else {
        Err("That provider id is not valid.".into())
    }
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account)
        .map_err(|error| format!("The credential store is unavailable: {error}"))
}

fn account(provider: &str) -> String {
    format!("api-key:{provider}")
}

fn read(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("An API key could not be read: {error}")),
    }
}

fn remove(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("The API key could not be removed: {error}")),
    }
}

pub fn get_keys(providers: &[String]) -> Result<HashMap<String, String>, String> {
    let mut keys = HashMap::new();

    for provider in providers {
        valid_provider(provider)?;

        if let Some(key) = read(&account(provider))? {
            keys.insert(provider.clone(), key);
        }
    }

    if !keys.contains_key(LEGACY_PROVIDER) {
        if let Some(key) = read(LEGACY_ACCOUNT)? {
            set_key(LEGACY_PROVIDER, &key)?;
            remove(LEGACY_ACCOUNT)?;
            keys.insert(LEGACY_PROVIDER.to_string(), key);
        }
    }

    Ok(keys)
}

pub fn set_key(provider: &str, key: &str) -> Result<(), String> {
    valid_provider(provider)?;
    let key = key.trim();

    if key.is_empty() {
        return remove(&account(provider));
    }

    entry(&account(provider))?
        .set_password(key)
        .map_err(|error| format!("The API key could not be saved: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_plain_slugs() {
        assert!(valid_provider("openrouter").is_ok());
        assert!(valid_provider("custom-1a2b").is_ok());
        assert!(valid_provider("").is_err());
        assert!(valid_provider("../x").is_err());
        assert!(valid_provider("a b").is_err());
    }
}
