#![cfg_attr(windows, windows_subsystem = "windows")]
use amplifier_native_platform::{self as platform, Application, local_auth};
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

mod acp;
mod update;

const APP: Application = Application {
    display_name: "Teams Connector",
    startup_description: "Teams Connector",
    executable_name: "acp-teams-adapter",
    startup_prefix: "acp-teams-adapter",
    data_directory: "acp-teams-adapter",
    background_command: "serve",
};
const DOMAIN: &str = "acp-teams-adapter.local-proof/1";
#[derive(Parser)]
#[command(version)]
struct Cli {
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    #[arg(long, global = true)]
    no_browser: bool,
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Subcommand)]
enum Action {
    Serve,
    #[command(hide = true)]
    Acp,
    #[command(hide = true)]
    ApplyUpdate {
        request_id: uuid::Uuid,
    },
    #[command(hide = true)]
    HashPassword,
    #[command(hide = true)]
    VerifyPassword,
    #[command(hide = true)]
    Startup {
        #[arg(long)]
        enabled: bool,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Password {
    password: String,
    #[serde(default)]
    encoded: Option<String>,
}
fn input() -> Result<Password> {
    let mut b = Vec::new();
    std::io::stdin().take(8193).read_to_end(&mut b)?;
    ensure!(b.len() <= 8192, "Input exceeds bound");
    Ok(serde_json::from_slice(&b)?)
}
fn main() {
    let cli = Cli::parse();
    let visible = cli.command.is_none() && !cli.no_browser;
    if let Err(e) = run(cli) {
        if visible {
            platform::show_launch_error(&APP, &e.to_string());
        }
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}
fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Action::HashPassword) => {
            let p = input()?;
            ensure!(p.encoded.is_none(), "Unexpected encoded password");
            println!(
                "{}",
                json!({"encoded":local_auth::hash_password(&p.password)?})
            );
            return Ok(());
        }
        Some(Action::VerifyPassword) => {
            let p = input()?;
            println!(
                "{}",
                json!({"valid":local_auth::verify_password(p.encoded.as_deref().context("Missing hash")?,&p.password)})
            );
            return Ok(());
        }
        _ => {}
    }
    let home = std::path::absolute(match cli.home {
        Some(h) => h,
        None => platform::default_home(&APP, "default")?,
    })?;
    if matches!(cli.command, Some(Action::Acp)) {
        return acp::run(&home);
    }
    if let Some(Action::ApplyUpdate { request_id }) = &cli.command {
        return update::apply(&home, &request_id.to_string());
    }
    if let Some(Action::Startup { enabled }) = cli.command {
        let settings = read_json(&home.join("native.json"))?;
        let id = uuid::Uuid::parse_str(settings["id"].as_str().context("Missing identity")?)?;
        if enabled {
            platform::install_startup(&APP, &home, &id)?;
        } else {
            platform::remove_startup(&APP, &home, &id)?;
        }
        println!("{}", json!({"configured":enabled}));
        return Ok(());
    }
    if !home.join("adapter.json").exists() {
        ensure!(
            cli.command.is_none(),
            "Open Teams Connector once to set up this installation"
        );
        create(&home)?;
    }
    let native=read_json(&home.join("native.json")).context("This existing installation remains managed by its current owner; no native migration was performed")?;
    if cli.command.is_none() && update::different_download(&home)? {
        return update::offer(&home, cli.no_browser);
    }
    if local_status(&home, &native).is_ok() {
        if cli.command.is_none() {
            ready(&home, &native, !cli.no_browser)?;
        }
        return Ok(());
    }
    let lock_path = home.join("service.lock");
    ensure!(
        !lock_path.is_symlink(),
        "Service lock must be an ordinary file"
    );
    platform::private_create(&lock_path, b"")
        .or_else(|e| if lock_path.is_file() { Ok(()) } else { Err(e) })?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.try_lock_exclusive()
        .context("This Teams Connector is already starting or running")?;
    update::validate_launch(&home)?;
    validate_bundle(&home)?;
    let executable = home.join(if cfg!(windows) {
        "bin/acp-teams-adapter.exe"
    } else {
        "bin/acp-teams-adapter"
    });
    // Install termination handling before the child can expose its endpoint.
    // A caller may close the app as soon as that endpoint becomes reachable.
    let stopping = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let signal = stopping.clone();
    ctrlc::set_handler(move || signal.store(true, std::sync::atomic::Ordering::SeqCst))?;
    let mut command = Command::new(node(&home));
    command
        .arg(home.join("app/dist/cli.js"))
        .arg("serve")
        .arg("--home")
        .arg(&home)
        .env("ACP_TEAMS_NATIVE_LAUNCHER", &executable)
        .env("ACP_TEAMS_LAUNCHER_PID", std::process::id().to_string())
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
    }
    // Bundle hashing can outlast a recovery decision; re-read the same launch
    // receipt while service.lock is still held, before the server opens state.
    update::validate_launch(&home)?;
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let _job = match ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(windows)]
    if let Err(error) = resume_suspended(&child) {
        drop(_job);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut live = false;
    for _ in 0..100 {
        if stopping.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("Teams Connector closed during startup; saved state was preserved");
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("Teams Connector stopped during startup ({status})");
        }
        if local_status(&home, &native).is_ok() {
            live = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !live {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("Teams Connector did not become ready; saved state was preserved");
    }
    if cli.command.is_none()
        && let Err(e) = ready(&home, &native, !cli.no_browser)
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if stopping.load(std::sync::atomic::Ordering::SeqCst) {
            #[cfg(unix)]
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            loop {
                if let Some(status) = child.try_wait()? {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(anyhow::anyhow!(
                            "Teams process stopped before graceful shutdown"
                        ))
                    };
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    anyhow::bail!(
                        "Teams process needed a forced stop; pending outcomes remain for review"
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    ensure!(status.success(), "Teams Connector exited ({status})");
    Ok(())
}
fn read_json(path: &Path) -> Result<Value> {
    let b = fs::read(path)?;
    ensure!(b.len() <= 4 * 1024 * 1024, "Metadata exceeds bound");
    Ok(serde_json::from_slice(&b)?)
}
fn random() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn resources() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let parent = exe.parent().context("Missing bundle directory")?;
    let mac = parent.join("../Resources");
    if parent.join("native-bundle.json").is_file() {
        Ok(parent.into())
    } else if mac.join("native-bundle.json").is_file() {
        Ok(mac)
    } else {
        anyhow::bail!("Keep this app together with its bundled runtime and files")
    }
}
fn safe_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':'])
        && Path::new(name)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}
fn validate_bundle(root: &Path) -> Result<Value> {
    let manifest = read_json(&root.join("native-bundle.json"))?;
    ensure!(
        manifest["schema"] == 1
            && manifest["component"] == "acp-teams-adapter"
            && manifest["version"] == env!("CARGO_PKG_VERSION"),
        "Invalid bundle identity"
    );
    let files = manifest["files"]
        .as_object()
        .context("Missing file inventory")?;
    ensure!(files.len() <= 20000, "Bundle inventory exceeds bound");
    for (name, expected) in files {
        ensure!(safe_relative(name), "Unsafe bundle path");
        let path = root.join(name);
        let mut prefix = root.to_owned();
        for part in Path::new(name).components() {
            prefix.push(part);
            ensure!(
                !fs::symlink_metadata(&prefix)?.file_type().is_symlink(),
                "Bundle links are not supported"
            );
        }
        let m = fs::metadata(&path)?;
        ensure!(
            m.is_file() && m.len() <= 256 * 1024 * 1024,
            "Invalid bundled file"
        );
        let actual = format!("{:x}", Sha256::digest(fs::read(path)?));
        ensure!(
            expected.as_str() == Some(&actual),
            "Bundled file checksum mismatch: {name}"
        );
    }
    ensure!(
        files.contains_key(if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        }) && files.contains_key("app/dist/cli.js"),
        "Incomplete runtime"
    );
    Ok(manifest)
}
fn create(home: &Path) -> Result<()> {
    ensure!(
        !home.exists(),
        "This folder already exists; its contents were preserved"
    );
    let source = resources()?;
    let manifest = validate_bundle(&source)?;
    let parent = home.parent().context("Missing installation parent")?;
    fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".teams-setup-{}", uuid::Uuid::new_v4()));
    platform::private_dir(&stage)?;
    let files = manifest["files"].as_object().unwrap();
    eprintln!(
        "Preparing the private Teams runtime ({} files)",
        files.len()
    );
    for (index, (name, _)) in files.iter().enumerate() {
        let dest = stage.join(name);
        platform::private_dir(dest.parent().context("Missing file parent")?)?;
        platform::private_create(&dest, &fs::read(source.join(name))?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if name == "runtime/node" {
                fs::set_permissions(&dest, fs::Permissions::from_mode(0o700))?;
            }
        }
        if (index + 1) % 1000 == 0 {
            eprintln!("Prepared {} of {} runtime files", index + 1, files.len());
        }
    }
    platform::private_create(
        &stage.join("native-bundle.json"),
        &serde_json::to_vec(&manifest)?,
    )?;
    platform::copy_self(&APP, &stage)?;
    // Keep the unpublished directory free of executing images/modules. Setup
    // already verified this download; only its output belongs in staging.
    let init = initialization_command(&source, &stage).output()?;
    ensure!(
        init.status.success(),
        "Could not create local Teams configuration"
    );
    let mut config = read_json(&stage.join("adapter.json"))?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    config["server"]["port"] = json!(port);
    config["acp"]["cwd"] = json!(home.join("workspace"));
    platform::private_write(
        &stage.join("adapter.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    let origin = format!("http://127.0.0.1:{port}");
    let settings = json!({"schema":1,"id":config["id"],"origin":origin});
    platform::private_create(&stage.join("native.json"), &serde_json::to_vec(&settings)?)?;
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        + 24 * 3600 * 1000;
    platform::private_create(
        &stage.join("secrets/first-account.json"),
        &serde_json::to_vec(&json!({"id":config["id"],"token":random(),"expires_at":expires}))?,
    )?;
    platform::publish_directory_if_absent(&stage, home)?;
    Ok(())
}
fn initialization_command(source: &Path, stage: &Path) -> Command {
    let mut command = Command::new(node(source));
    command
        .arg(source.join("app/dist/cli.js"))
        .arg("init")
        .arg("--home")
        .arg(stage);
    command
}
fn node(home: &Path) -> PathBuf {
    home.join(if cfg!(windows) {
        "runtime/node.exe"
    } else {
        "runtime/node"
    })
}
fn ready(home: &Path, native: &Value, browser: bool) -> Result<()> {
    let mut url = native["origin"]
        .as_str()
        .context("Missing origin")?
        .to_owned();
    if !home.join("secrets/local-password.json").exists() {
        let path = home.join("secrets/first-account.json");
        let mut setup = read_json(&path)?;
        ensure!(setup["id"] == native["id"], "Wrong setup identity");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64;
        if setup["expires_at"].as_u64().unwrap_or(0) <= now {
            setup = json!({"id":native["id"],"token":random(),"expires_at":now+24*3600*1000});
            platform::private_write(&path, &serde_json::to_vec(&setup)?)?;
        }
        url.push_str(&format!(
            "/#setup={}",
            setup["token"].as_str().context("Missing setup token")?
        ));
    }
    if browser {
        platform::open_browser(&url)?;
    } else {
        println!(
            "{}",
            json!({"ready":true,"id":native["id"],"url":url,"home":home})
        );
    }
    Ok(())
}
// A single TCP connection carries both challenge and subsequent bearer request.
fn response(stream: &mut TcpStream) -> Result<Value> {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        stream.set_read_timeout(Some(
            deadline
                .checked_duration_since(std::time::Instant::now())
                .context("Local response timed out")?,
        ))?;
        let mut b = [0];
        stream.read_exact(&mut b)?;
        head.push(b[0]);
        ensure!(head.len() < 8192, "Response headers exceed bound");
    }
    let text = std::str::from_utf8(&head)?;
    ensure!(
        text.starts_with("HTTP/1.1 200 "),
        "Local server refused request"
    );
    let mut length = None;
    for row in text.lines().skip(1) {
        if let Some((k, v)) = row.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                ensure!(length.is_none(), "Duplicate content length");
                length = Some(v.trim().parse::<usize>()?);
            }
            ensure!(
                !k.eq_ignore_ascii_case("transfer-encoding"),
                "Unexpected transfer encoding"
            );
        }
    }
    let n = length.context("Missing bounded response length")?;
    ensure!(n <= 100_000, "Response exceeds bound");
    let mut data = vec![0; n];
    stream.set_read_timeout(Some(
        deadline
            .checked_duration_since(std::time::Instant::now())
            .context("Local response timed out")?,
    ))?;
    stream.read_exact(&mut data)?;
    Ok(serde_json::from_slice(&data)?)
}
fn local_status(home: &Path, native: &Value) -> Result<Value> {
    local_api(home, native, "GET", "status", None)
}
fn local_api(
    home: &Path,
    native: &Value,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let origin = native["origin"].as_str().context("Missing origin")?;
    let address = origin
        .strip_prefix("http://127.0.0.1:")
        .context("Native management must be loopback")?;
    let port = address.parse::<u16>()?;
    let id = native["id"]
        .as_str()
        .context("Missing installation identity")?;
    let secret = fs::read_to_string(home.join("secrets/control-token"))?;
    let nonce = random();
    let mut stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET /api/v1/local-proof?nonce={nonce} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: keep-alive\r\n\r\n"
    )?;
    let reply = response(&mut stream)?;
    ensure!(
        reply["id"] == id && reply["origin"] == origin && reply["nonce"] == nonce,
        "Wrong local installation"
    );
    local_auth::verify_listener_proof(
        DOMAIN,
        id,
        origin,
        &nonce,
        secret.trim(),
        reply["proof"].as_str().context("Missing listener proof")?,
    )?;
    let encoded = body.map(Value::to_string).unwrap_or_default();
    write!(
        stream,
        "{method} /api/v1/{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        secret.trim(),
        encoded.len(),
        encoded
    )?;
    let value = response(&mut stream)?;
    ensure!(value["id"] == id, "Wrong installation status");
    Ok(value)
}

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessJob {
    fn terminate_and_wait(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            ensure!(
                TerminateJobObject(self.0, 1) != 0,
                "Could not stop the ACP process tree"
            );
            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                ensure!(
                    QueryInformationJobObject(
                        self.0,
                        JobObjectBasicAccountingInformation,
                        &mut info as *mut _ as *mut _,
                        std::mem::size_of_val(&info) as u32,
                        std::ptr::null_mut()
                    ) != 0,
                    "ACP process-tree exit is unknown"
                );
                if info.ActiveProcesses == 0 {
                    return Ok(());
                }
                ensure!(
                    std::time::Instant::now() < deadline,
                    "ACP descendants did not stop"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    fn attach(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            ensure!(!job.is_null(), "Could not create child process job");
            let owned = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            ensure!(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32
                ) != 0,
                "Could not set child process limits"
            );
            ensure!(
                AssignProcessToJobObject(job, child.as_raw_handle()) != 0,
                "Could not contain Teams runtime"
            );
            Ok(owned)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
// std::process retains the process handle but not the initial thread handle.
// CREATE_SUSPENDED guarantees that no child code runs before job assignment.
#[cfg(windows)]
fn resume_suspended(child: &std::process::Child) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::*,
        System::{Diagnostics::ToolHelp::*, Threading::*},
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    ensure!(
        snapshot != INVALID_HANDLE_VALUE,
        "Could not inspect the suspended Teams process"
    );
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = None;
    let mut available = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while available {
        if entry.th32OwnerProcessID == child.id() {
            found = Some(entry.th32ThreadID);
            break;
        }
        available = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    let id = found.context("The suspended Teams process has no initial thread")?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, id) };
    ensure!(
        !thread.is_null(),
        "Could not open the suspended Teams thread"
    );
    let resumed = unsafe { ResumeThread(thread) };
    unsafe {
        CloseHandle(thread);
    }
    ensure!(resumed == 1, "Could not resume the suspended Teams process");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initialization_executes_verified_download_and_only_writes_staging() {
        let source = Path::new("verified-download");
        let stage = Path::new("unpublished-installation");
        let command = initialization_command(source, stage);
        assert_eq!(command.get_program(), node(source));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                source.join("app/dist/cli.js").as_os_str(),
                std::ffi::OsStr::new("init"),
                std::ffi::OsStr::new("--home"),
                stage.as_os_str()
            ]
        );
        assert!(command.get_current_dir().is_none());
    }
    #[cfg(windows)]
    #[test]
    fn windows_completed_node_execution_and_directory_publication() {
        let supplied = PathBuf::from(std::env::var("TEAMS_TEST_NODE").expect("fixed Node fixture"));
        let bytes = fs::read(supplied).unwrap();
        let expected = if cfg!(target_arch = "aarch64") {
            "c2eaa48231229b966bfef21554df203221862a9fc94ec2a6908aad5eaa6c0ba0"
        } else {
            "247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a"
        };
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
        let mut observations = Vec::new();
        for execute_from_stage in [true, false] {
            let temporary = tempfile::tempdir().unwrap();
            let source = temporary.path().join("download");
            let stage = temporary.path().join("unpublished");
            let destination = temporary.path().join("installed");
            let cwd = std::env::current_dir().unwrap();
            assert!(!cwd.starts_with(&stage));
            for root in [&source, &stage] {
                platform::private_dir(&root.join("runtime")).unwrap();
                platform::private_dir(&root.join("app/dist")).unwrap();
                platform::private_create(&node(root), &bytes).unwrap();
                platform::private_create(
                    &root.join("app/dist/cli.js"),
                    br#"const fs=require('node:fs');const path=require('node:path');const home=process.argv.at(-1);fs.writeFileSync(path.join(home,'initialized.json'),'{}');console.log(JSON.stringify({pid:process.pid,execPath:process.execPath,cwd:process.cwd()}));"#,
                )
                .unwrap();
            }
            let origin = if execute_from_stage { &stage } else { &source };
            let output = initialization_command(origin, &stage).output().unwrap();
            assert!(output.status.success());
            // No sleeps, repeated rename, or additional filesystem probes between
            // the waited child exit and the single atomic publication attempt.
            let published = platform::publish_directory_if_absent(&stage, &destination);
            let process: Value = serde_json::from_slice(&output.stdout).unwrap();
            let record = json!({"executed_from_stage":execute_from_stage,"node_sha256":expected,"child_exit_success":true,"caller_cwd_outside_stage":true,"child_cwd_matches_caller":Path::new(process["cwd"].as_str().unwrap())==cwd,"publication_succeeded":published.is_ok(),"error":published.as_ref().err().map(|e|format!("{e:#}"))});
            observations.push(record);
            if !execute_from_stage {
                assert!(published.is_ok(), "{}", json!(observations));
                assert!(destination.join("initialized.json").is_file());
                assert!(!stage.exists());
            }
        }
        let report = std::env::var("TEAMS_PUBLICATION_REPORT").expect("report path");
        fs::write(report, serde_json::to_vec_pretty(&observations).unwrap()).unwrap();
        eprintln!("Windows publication comparison: {}", json!(observations));
    }
    #[test]
    fn paths_do_not_escape_bundle() {
        for x in ["../x", "/x", "a/../x", "C:\\x", ""] {
            assert!(!safe_relative(x));
        }
        assert!(safe_relative("app/dist/cli.js"));
    }
    #[test]
    fn shared_listener_golden() {
        assert_eq!(
            local_auth::listener_proof(
                DOMAIN,
                "installation",
                "http://127.0.0.1:4321",
                &"a".repeat(64),
                &"b".repeat(64)
            )
            .unwrap(),
            "12a53eddbd6b17397073581b4090df8a9b03827de69b16c0ff831bbd0d5564a5"
        );
    }
    #[test]
    fn impostor_listener_never_receives_saved_bearer() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("secrets")).unwrap();
        let secret = "b".repeat(64);
        fs::write(temp.path().join("secrets/control-token"), &secret).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let native = json!({"id":"installation","origin":format!("http://127.0.0.1:{port}")});
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut input = Vec::new();
            while !input.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                socket.read_exact(&mut b).unwrap();
                input.push(b[0]);
            }
            let text = String::from_utf8(input).unwrap();
            let nonce = text
                .split("nonce=")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap();
            let body=json!({"id":"installation","origin":format!("http://127.0.0.1:{port}"),"nonce":nonce,"proof":"0".repeat(64)}).to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            let mut later = String::new();
            let _ = socket.read_to_string(&mut later);
            text + &later
        });
        assert!(local_status(temp.path(), &native).is_err());
        let received = server.join().unwrap();
        assert!(!received.contains("Authorization"));
        assert!(!received.contains(&secret));
    }
    #[cfg(windows)]
    #[test]
    fn suspended_node_child_is_owned_before_it_can_execute() {
        use std::os::windows::process::CommandExt;
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("ran.txt");
        let python = std::env::var("TEAMS_TEST_PYTHON").unwrap_or_else(|_| "python".into());
        let mut command = Command::new(python);
        command.args(["-c","import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('ran'); time.sleep(60)"]).arg(&marker).creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
        let mut child = command.spawn().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(!marker.exists());
        let job = ProcessJob::attach(&child).unwrap();
        resume_suspended(&child).unwrap();
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(marker.exists());
        drop(job);
        child.wait().unwrap();
    }
}
