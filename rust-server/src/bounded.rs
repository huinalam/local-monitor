use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
pub fn run(mut command: Command, limit: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "unavailable")?;
    let out = child.stdout.take().ok_or("unavailable")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        out.take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("unavailable");
            }
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            break Err("timeout");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader
        .join()
        .map_err(|_| "unavailable")?
        .map_err(|_| "unavailable")?;
    let status = status?;
    if !status.success() {
        return Err("command_failed".into());
    }
    if bytes.len() > limit {
        return Err("output_limit".into());
    }
    Ok(bytes)
}
pub fn text(program: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(program);
    c.args(args);
    String::from_utf8(run(c, 1024 * 1024, Duration::from_secs(2))?)
        .map_err(|_| "invalid_data".into())
}
