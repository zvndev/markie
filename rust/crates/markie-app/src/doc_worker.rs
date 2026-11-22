//! Keep legacy DOC parsing behind a process deadline, like Electron's
//! disposable Web Worker. This entry point never creates a desktop window.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use markie_office::cfb::{CfbLimits, DEFAULT_CFB_LIMITS};
use markie_office::legacy_doc::{DEFAULT_LEGACY_DOC_LIMITS, LEGACY_DOC_MAX_INPUT, LegacyDocLimits, LegacyDocText, extract_legacy_doc_text};
use serde::{Deserialize, Serialize};

pub const ARG: &str = "--legacy-doc-worker";
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 112 * 1024 * 1024;
const LATE: &str = "DOC import exceeded its time budget. The local reader was stopped; the original is unchanged.";
const FAILED: &str = "The local DOC reader failed. Your open document and original file are unchanged.";

#[derive(Serialize, Deserialize)]
struct Answer {
    text: String,
    raw_text: Vec<u16>,
    warnings: Vec<String>,
}

fn read_document(mut input: impl Read) -> Result<Answer, String> {
    let mut bytes = Vec::new();
    input.by_ref().take((LEGACY_DOC_MAX_INPUT + 1) as u64).read_to_end(&mut bytes).map_err(|_| FAILED.to_string())?;
    if bytes.len() > LEGACY_DOC_MAX_INPUT {
        return Err("Legacy DOC exceeds the 32 MiB import limit.".into());
    }
    let limits = LegacyDocLimits {
        cfb: CfbLimits { max_input_bytes: LEGACY_DOC_MAX_INPUT, ..DEFAULT_CFB_LIMITS },
        ..DEFAULT_LEGACY_DOC_LIMITS
    };
    extract_legacy_doc_text(&bytes, limits).map(|d| Answer {
        text: d.text, raw_text: d.raw_text, warnings: d.warnings,
    }).map_err(|e| e.message)
}

pub fn serve() -> bool {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &read_document(std::io::stdin().lock())).is_ok()
        && output.flush().is_ok()
}

pub fn read(bytes: Vec<u8>, canceled: &AtomicBool) -> Result<LegacyDocText, String> {
    let mut command = Command::new(std::env::current_exe().map_err(|_| FAILED)?);
    command.arg(ARG);
    let response = exchange(command, bytes, canceled, TIMEOUT)?;
    let answer: Result<Answer, String> = serde_json::from_slice(&response).map_err(|_| FAILED)?;
    let answer = answer?;
    let max_text = 8 * 1024 * 1024;
    if answer.raw_text.len() > max_text || answer.text.encode_utf16().take(max_text + 1).count() > max_text
        || answer.warnings.len() > 100 || answer.warnings.iter().any(|w| w.encode_utf16().take(4097).count() > 4096)
    {
        return Err("The local DOC reader returned an invalid result.".into());
    }
    Ok(LegacyDocText { text: answer.text, raw_text: answer.raw_text, warnings: answer.warnings })
}

fn exchange(mut command: Command, bytes: Vec<u8>, canceled: &AtomicBool, timeout: Duration) -> Result<Vec<u8>, String> {
    if canceled.load(Ordering::Relaxed) { return Err("DOC import canceled.".into()); }
    let start = Instant::now();
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "A local document worker is unavailable. This DOC was not opened or uploaded.")?;
    let mut input = child.stdin.take().expect("piped stdin");
    let output = child.stdout.take().expect("piped stdout");
    let (sender, reply) = std::sync::mpsc::sync_channel(1);
    let transfer = std::thread::Builder::new().name("markie-doc-transport".into()).spawn(move || {
        let result = input.write_all(&bytes);
        drop(input);
        let mut response = Vec::new();
        let result = result.and_then(|_| output.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut response)).map(|_| response);
        let _ = sender.send(result);
    });
    let received = if transfer.is_err() {
        Err(FAILED)
    } else {
        loop {
            if canceled.load(Ordering::Relaxed) { break Err("DOC import canceled."); }
            let Some(left) = timeout.checked_sub(start.elapsed()) else { break Err(LATE) };
            match reply.recv_timeout(left.min(Duration::from_millis(20))) {
                Ok(Ok(body)) if body.len() <= MAX_OUTPUT => break Ok(body),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                _ => break Err(FAILED),
            }
        }
    };
    if received.is_err() { let _ = child.kill(); }
    let status = child.wait();
    if received.is_ok() && !status.is_ok_and(|status| status.success()) { return Err(FAILED.into()); }
    received.map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_parses_an_original_doc_without_opening_a_window() {
        use markie_office::cfb::write_compound_file;
        use markie_office::legacy_doc::serialize_legacy_doc_plain_story_streams;
        let fixture = serialize_legacy_doc_plain_story_streams("Synthetic text", Default::default()).unwrap();
        let bytes = write_compound_file(&fixture.streams, DEFAULT_CFB_LIMITS).unwrap();
        let answer = read_document(bytes.as_slice()).unwrap();
        assert!(answer.text.contains("Synthetic text"));
    }

    #[test]
    #[cfg(unix)]
    fn reaps_a_timed_out_document_worker() {
        let mut command = Command::new("/bin/sleep");
        command.arg("10");
        let start = Instant::now();
        assert_eq!(exchange(command, Vec::new(), &AtomicBool::new(false), Duration::from_millis(25)).unwrap_err(), LATE);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
