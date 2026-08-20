use std::path::Path;
use std::time::{Duration, SystemTime};

const KEEP_DAYS: u64 = 14;
const LOG_PREFIX: &str = "storyboard.log.";

pub fn cleanup_old_logs(dir: &Path) {
    cleanup_old_logs_with_keep(dir, KEEP_DAYS);
}

fn cleanup_old_logs_with_keep(dir: &Path, keep_days: u64) {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(keep_days * 24 * 60 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.starts_with(LOG_PREFIX) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if modified < cutoff {
            let _ = std::fs::remove_file(&path);
        }
    }
}