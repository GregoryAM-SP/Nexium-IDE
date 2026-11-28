//! Runs a shell command for the assistant (tests, a type-check, a build) in the
//! open folder, with a time limit, and returns what it printed. The user
//! approves each command before it runs unless Auto-approve is on.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT: u64 = 120;
pub const MAX_TIMEOUT: u64 = 600;
/// Output kept for the model: the start (what ran) and, mostly, the end
/// (where errors and summaries are).
const KEEP_HEAD: usize = 2_000;
const KEEP_TAIL: usize = 12_000;
const POLL: Duration = Duration::from_millis(100);

pub struct Outcome {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
}

impl Outcome {
    #[cfg(test)]
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out && !self.cancelled
    }

    /// The text handed back to the model.
    pub fn report(&self, command: &str, seconds: u64) -> String {
        let status = if self.cancelled {
            "[stopped by the user]".to_string()
        } else if self.timed_out {
            format!("[timed out after {seconds}s; the process was stopped. Use a narrower command, or a larger timeout_seconds]")
        } else {
            match self.exit_code {
                Some(code) => format!("[exit code {code}]"),
                None => "[ended by a signal]".to_string(),
            }
        };
        let output = if self.output.trim().is_empty() {
            "(no output)".to_string()
        } else {
            clip(&self.output)
        };
        format!("$ {command}\n{output}\n{status}")
    }
}

/// Keeps the head and tail of long output, marking what was cut.
pub fn clip(output: &str) -> String {
    let chars: Vec<char> = output.chars().collect();

    if chars.len() <= KEEP_HEAD + KEEP_TAIL {
        return output.to_string();
    }

    let head: String = chars[..KEEP_HEAD].iter().collect();
    let tail: String = chars[chars.len() - KEEP_TAIL..].iter().collect();
    format!(
        "{head}\n… {} characters of output omitted …\n{tail}",
        chars.len() - KEEP_HEAD - KEEP_TAIL
    )
}

fn shell(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut shell = Command::new("cmd");
        // /S with the whole line in quotes hands it to cmd exactly as written.
        shell
            .args(["/D", "/S", "/C"])
            .raw_arg(format!("\"{command}\""))
            .creation_flags(CREATE_NO_WINDOW);
        shell
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        let mut shell = Command::new("sh");
        // Its own process group, so a timeout can stop everything it started.
        shell.args(["-c", command]).process_group(0);
        shell
    }
}

/// Stops the command and anything it started (npm → node, cargo → rustc).
fn stop_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn collect(mut source: impl Read + Send + 'static, sink: Arc<Mutex<Vec<u8>>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(read) = source.read(&mut buffer) {
            if read == 0 {
                break;
            }
            if let Ok(mut sink) = sink.lock() {
                sink.extend_from_slice(&buffer[..read]);
            }
        }
    })
}

/// Runs `command` in `folder`. Waits asynchronously, so Stop (the `cancel`
/// flag) is noticed within a tenth of a second.
pub async fn run(
    folder: &Path,
    command: &str,
    timeout_seconds: u64,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    let limit = Duration::from_secs(timeout_seconds.clamp(1, MAX_TIMEOUT));
    run_streaming(folder, command, limit, cancel, &mut |_| {}).await
}

/// Like [`run`], with no cap on `limit`, handing each piece of output to
/// `on_output` as it arrives (for a log the user watches).
pub async fn run_streaming(
    folder: &Path,
    command: &str,
    limit: Duration,
    cancel: &AtomicBool,
    on_output: &mut (dyn FnMut(&str) + Send),
) -> Result<Outcome, String> {
    let mut child = shell(command)
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Test runners and tools stay non-interactive and plain.
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb")
        // The Angular CLI otherwise stops to ask about analytics.
        .env("NG_CLI_ANALYTICS", "false")
        .spawn()
        .map_err(|error| format!("Could not start the command: {error}"))?;

    let output = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child.stdout.take().map(|out| collect(out, output.clone())),
        child.stderr.take().map(|err| collect(err, output.clone())),
    ];

    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let mut sent = 0usize;

    let mut forward = |final_flush: bool| {
        let Ok(bytes) = output.lock() else { return };
        let fresh = &bytes[sent..];
        // Hold back a character split across reads, unless this is the end.
        let usable = match std::str::from_utf8(fresh) {
            Ok(_) => fresh.len(),
            Err(error) if error.error_len().is_none() && !final_flush => error.valid_up_to(),
            Err(_) => fresh.len(),
        };
        // A CR at the very end may be the first half of a CRLF.
        let usable = if !final_flush && usable > 0 && fresh[usable - 1] == b'\r' { usable - 1 } else { usable };
        if usable > 0 {
            let text = String::from_utf8_lossy(&fresh[..usable]).replace("\r\n", "\n");
            sent += usable;
            on_output(&text);
        }
    };

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => return Err(format!("Lost track of the command: {error}")),
        }

        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            stop_tree(&mut child);
            break None;
        }

        if started.elapsed() >= limit {
            timed_out = true;
            stop_tree(&mut child);
            break None;
        }

        forward(false);
        tokio::time::sleep(POLL).await;
    };

    for reader in readers.into_iter().flatten() {
        let _ = reader.join();
    }
    forward(true);

    let bytes = output.lock().map(|bytes| bytes.clone()).unwrap_or_default();

    Ok(Outcome {
        output: String::from_utf8_lossy(&bytes).replace("\r\n", "\n"),
        exit_code: status.and_then(|status| status.code()),
        timed_out,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn captures_output_and_exit_code() {
        let folder = std::env::temp_dir();
        let never = AtomicBool::new(false);

        let ok = block(run(&folder, "echo hello from nexium", 30, &never)).unwrap();
        assert!(ok.succeeded());
        assert!(ok.output.contains("hello from nexium"));
        assert!(ok.report("echo", 30).ends_with("[exit code 0]"));

        let failed = block(run(&folder, "exit 3", 30, &never)).unwrap();
        assert_eq!(failed.exit_code, Some(3));
        assert!(!failed.succeeded());
    }

    #[test]
    fn streams_output_as_it_arrives() {
        let folder = std::env::temp_dir();
        let never = AtomicBool::new(false);
        let mut pieces = String::new();
        let command = if cfg!(windows) { "echo one && echo two" } else { "echo one; echo two" };
        let outcome = block(run_streaming(&folder, command, Duration::from_secs(30), &never, &mut |text| {
            pieces.push_str(text)
        }))
        .unwrap();
        assert!(outcome.succeeded());
        assert!(pieces.contains("one") && pieces.contains("two"));
        assert_eq!(pieces.trim(), outcome.output.trim());
    }

    #[test]
    fn stops_at_the_time_limit() {
        let folder = std::env::temp_dir();
        let never = AtomicBool::new(false);
        let slow = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };

        let started = Instant::now();
        let outcome = block(run(&folder, slow, 1, &never)).unwrap();
        assert!(outcome.timed_out);
        assert!(started.elapsed() < Duration::from_secs(15));
        assert!(outcome.report(slow, 1).contains("timed out after 1s"));
    }

    #[test]
    fn stops_when_cancelled() {
        let folder = std::env::temp_dir();
        let stop = AtomicBool::new(true);
        let slow = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };

        let outcome = block(run(&folder, slow, 60, &stop)).unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.report(slow, 60).contains("stopped by the user"));
    }

    #[test]
    fn clips_long_output_keeping_both_ends() {
        let long = format!("START{}END", "x".repeat(50_000));
        let clipped = clip(&long);
        assert!(clipped.starts_with("START"));
        assert!(clipped.ends_with("END"));
        assert!(clipped.contains("characters of output omitted"));
        assert_eq!(clip("short"), "short");
    }
}
