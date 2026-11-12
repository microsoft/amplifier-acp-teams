//! Fixed, installation-configured ACP lifetime; no command supplied by HTTP.
use super::*;
#[cfg(windows)]
pub fn run(home: &Path) -> Result<()> {
    let native = read_json(&home.join("native.json"))?;
    let raw = fs::read(home.join("adapter.json"))?;
    ensure!(
        raw.len() <= 4 * 1024 * 1024
            && std::env::var("ACP_TEAMS_EXPECTED_CONFIG_HASH")
                .ok()
                .as_deref()
                == Some(format!("{:x}", Sha256::digest(&raw)).as_str()),
        "ACP configuration changed before launch"
    );
    let config: Value = serde_json::from_slice(&raw)?;
    ensure!(
        native["id"] == config["id"],
        "ACP installation identity changed"
    );
    let command = config["acp"]["command"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("No ACP engine configured")?;
    let args = config["acp"]["args"]
        .as_array()
        .context("Invalid ACP arguments")?;
    let cwd = config["acp"]["cwd"]
        .as_str()
        .context("No ACP workspace configured")?;
    let mut child = Command::new(command);
    for argument in args {
        child.arg(argument.as_str().context("Invalid ACP argument")?);
    }
    child
        .env_remove("ACP_TEAMS_EXPECTED_CONFIG_HASH")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    use std::os::windows::process::CommandExt;
    child.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
    let mut process = child.spawn()?;
    let job = match ProcessJob::attach(&process) {
        Ok(job) => job,
        Err(error) => {
            let _ = process.kill();
            let _ = process.wait();
            return Err(error);
        }
    };
    if let Err(error) = resume_suspended(&process) {
        drop(job);
        let _ = process.kill();
        let _ = process.wait();
        return Err(error);
    }
    let mut input = process.stdin.take().context("Missing ACP input")?;
    let (ended, closed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        drop(input);
        let _ = ended.send(());
    });
    loop {
        if process.try_wait()?.is_some() || closed.try_recv().is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    job.terminate_and_wait()?;
    let _ = process.wait();
    Ok(())
}
#[cfg(not(windows))]
pub fn run(_home: &Path) -> Result<()> {
    anyhow::bail!("Unix ACP uses the existing per-operation process group")
}
