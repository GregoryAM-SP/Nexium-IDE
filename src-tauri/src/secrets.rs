//! The NVIDIA API key lives in the operating system's credential store
//! (Windows Credential Manager, macOS Keychain, the Linux kernel keyring)
//! instead of the webview's `localStorage`, which is a plain file on disk that
//! any script running in the page can read.

use keyring::{Entry, Error};

const SERVICE: &str = "com.nexium.studio";
const ACCOUNT: &str = "nvidia-nim-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| format!("The credential store is unavailable: {error}"))
}

pub fn get_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("The API key could not be read: {error}")),
    }
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    let key = key.trim();

    if key.is_empty() {
        return delete_api_key();
    }

    entry()?
        .set_password(key)
        .map_err(|error| format!("The API key could not be saved: {error}"))
}

pub fn delete_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("The API key could not be removed: {error}")),
    }
}
