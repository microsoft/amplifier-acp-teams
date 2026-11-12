//! Explicit local-package update; no polling, arbitrary commands or data rollback.
use super::*;
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use std::{fs::File, process::Child, sync::Arc};

fn sha(path: &Path) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}
fn worker_active(home: &Path) -> Option<bool> {
    match lock(home, "native-update.lock") {
        Ok(_) => Some(false),
        Err(error) => error.downcast_ref::<std::io::Error>().and_then(|e| {
            (e.kind() == std::io::ErrorKind::WouldBlock
                || (e.raw_os_error().is_some()
                    && e.raw_os_error() == fs2::lock_contended_error().raw_os_error()))
            .then_some(true)
        }),
    }
}
fn optional_saved(home: &Path) -> Result<Option<Value>> {
    let path = home.join("native-update.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) => ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "Update record must be an ordinary file"
        ),
    }
    let j = read_json(&path)?;
    ensure!(
        j["schema"] == 1
            && uuid::Uuid::parse_str(j["request_id"].as_str().unwrap_or("")).is_ok()
            && uuid::Uuid::parse_str(j["installation_id"].as_str().unwrap_or("")).is_ok()
            && matches!(
                j["phase"].as_str(),
                Some(
                    "prepared"
                        | "deferred"
                        | "stopping"
                        | "swapping"
                        | "starting"
                        | "rolling_back"
                        | "rollback_starting"
                        | "recovery_required"
                        | "applied"
                        | "rolled_back"
                        | "cancelled"
                )
            )
            && j["candidate"].is_object()
            && j["previous"].is_object()
            && j["protected"].is_object(),
        "Update record is invalid; saved evidence was preserved"
    );
    Ok(Some(j))
}
fn saved(home: &Path) -> Result<Value> {
    optional_saved(home)?.context("No prepared update")
}
fn save(home: &Path, j: &Value) -> Result<()> {
    platform::private_write_data(&home.join("native-update.json"), &serde_json::to_vec(j)?)
}
fn phase(home: &Path, j: &mut Value, value: &str) -> Result<()> {
    j["phase"] = json!(value);
    j.as_object_mut().unwrap().remove("launch_nonce");
    save(home, j)
}
fn terminal(j: &Value) -> bool {
    matches!(
        j["phase"].as_str(),
        Some("applied" | "rolled_back" | "cancelled")
    )
}
fn binary(home: &Path) -> PathBuf {
    home.join(if cfg!(windows) {
        "bin/acp-teams-adapter.exe"
    } else {
        "bin/acp-teams-adapter"
    })
}
fn lock(home: &Path, name: &str) -> Result<File> {
    let path = home.join(name);
    ensure!(
        !path.is_symlink(),
        "Application lock must be an ordinary file"
    );
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    platform::protect_file(&path)?;
    file.try_lock_exclusive()
        .context("This installation is still working")?;
    Ok(file)
}
fn directory(home: &Path, id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(id)?;
    Ok(home.join("native-updates").join(id))
}
fn copy_file(from: &Path, to: &Path) -> Result<()> {
    ensure!(
        from.is_file() && !from.is_symlink(),
        "Use ordinary package files"
    );
    platform::private_write(to, &fs::read(from)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(to, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn owner(home: &Path) -> Result<Value> {
    ensure!(
        !home.join("saved-connections.json").exists()
            && !home.join("updates/registered-service.json").exists(),
        "This connector retains its external update owner"
    );
    let native = read_json(&home.join("native.json"))?;
    let config = read_json(&home.join("adapter.json"))?;
    ensure!(
        native["id"] == config["id"] && native["schema"] == 1,
        "Installation identity changed"
    );
    Ok(native)
}
fn validate_files(root: &Path, manifest: &Value) -> Result<()> {
    ensure!(
        manifest["schema"] == 1 && manifest["component"] == "acp-teams-adapter",
        "Invalid package identity"
    );
    let files = manifest["files"]
        .as_object()
        .context("Missing package inventory")?;
    ensure!(
        !files.is_empty() && files.len() <= 20000,
        "Invalid package inventory size"
    );
    for (name, expected) in files {
        ensure!(safe_relative(name), "Unsafe package path");
        let mut p = root.to_owned();
        for part in Path::new(name).components() {
            p.push(part);
            ensure!(
                !fs::symlink_metadata(&p)?.file_type().is_symlink(),
                "Package links are not supported"
            );
        }
        ensure!(
            p.is_file()
                && p.metadata()?.len() <= 256 * 1024 * 1024
                && expected.as_str() == Some(sha(&p)?.as_str()),
            "Package file changed"
        );
    }
    Ok(())
}
fn copy_files(from: &Path, to: &Path, manifest: &Value) -> Result<()> {
    platform::private_dir(to)?;
    validate_files(from, manifest)?;
    for (name, _) in manifest["files"].as_object().unwrap() {
        copy_file(&from.join(name), &to.join(name))?;
    }
    platform::private_write(
        &to.join("native-bundle.json"),
        &serde_json::to_vec(manifest)?,
    )?;
    Ok(())
}
fn protected(home: &Path) -> Result<Value> {
    let mut files = serde_json::Map::new();
    for name in ["adapter.json", "native.json", "startup.json"] {
        let p = home.join(name);
        if p.exists() {
            files.insert(name.into(), json!(sha(&p)?));
        }
    }
    for item in fs::read_dir(home.join("secrets"))? {
        let p = item?.path();
        ensure!(p.is_file() && !p.is_symlink(), "Unexpected secret entry");
        files.insert(
            format!("secrets/{}", p.file_name().unwrap().to_string_lossy()),
            json!(sha(&p)?),
        );
    }
    Ok(Value::Object(files))
}
pub fn different_download(home: &Path) -> Result<bool> {
    owner(home)?;
    let current = std::env::current_exe()?;
    if current.canonicalize()? == binary(home).canonicalize()? {
        return Ok(false);
    }
    let package = validate_bundle(&resources()?)?;
    ensure!(
        package["launcher_sha256"] == sha(&current)?,
        "Keep the verified native download intact"
    );
    Ok(sha(&current)? != sha(&binary(home))?
        || package != read_json(&home.join("native-bundle.json"))?)
}
fn stage(home: &Path) -> Result<Value> {
    let _lock = lock(home, "native-update.lock")?;
    let native = owner(home)?;
    let current = std::env::current_exe()?;
    let candidate = validate_bundle(&resources()?)?;
    ensure!(
        candidate["launcher_sha256"] == sha(&current)?,
        "Downloaded launcher changed"
    );
    if let Some(j) = optional_saved(home)?
        && !terminal(&j)
    {
        ensure!(
            j["candidate"] == candidate,
            "Finish the existing update before opening another download"
        );
        return Ok(j);
    }
    if let Some(previous_record) = optional_saved(home)? {
        let path = directory(home, previous_record["request_id"].as_str().unwrap())?
            .join("completion.json");
        platform::private_write(&path, &serde_json::to_vec(&previous_record)?)?;
    }
    let previous = read_json(&home.join("native-bundle.json"))?;
    validate_files(home, &previous)?;
    ensure!(
        previous["launcher_sha256"] == sha(&binary(home))?,
        "Installed application changed; saved files were preserved"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let dir = directory(home, &id)?;
    platform::private_dir(&dir)?;
    copy_files(&resources()?, &dir.join("candidate-files"), &candidate)?;
    copy_files(home, &dir.join("previous-files"), &previous)?;
    copy_file(
        &current,
        &dir.join(if cfg!(windows) {
            "worker.exe"
        } else {
            "worker"
        }),
    )?;
    copy_file(&binary(home), &dir.join("previous-binary"))?;
    let j = json!({"schema":1,"request_id":id,"installation_id":native["id"],"phase":"prepared","candidate":candidate,"previous":previous,"protected":protected(home)?});
    save(home, &j)?;
    Ok(j)
}
fn discard(home: &Path, id: &str) -> Result<()> {
    let _lock = lock(home, "native-update.lock")?;
    let mut j = saved(home)?;
    ensure!(
        j["request_id"] == id && matches!(j["phase"].as_str(), Some("prepared" | "deferred")),
        "An active or unresolved update cannot be discarded"
    );
    phase(home, &mut j, "cancelled")?;
    platform::private_write(
        &directory(home, id)?.join("completion.json"),
        &serde_json::to_vec(&j)?,
    )?;
    Ok(())
}
fn api(home: &Path, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    local_api(home, &owner(home)?, method, path, body)
}
#[cfg(windows)]
struct ProcessHandle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessHandle {
    fn open(pid: u32) -> Result<Self> {
        let h = unsafe { windows_sys::Win32::System::Threading::OpenProcess(0x100000, 0, pid) };
        ensure!(!h.is_null(), "Running app identity is unknown");
        Ok(Self(h))
    }
    fn wait(&self) -> Result<()> {
        ensure!(
            unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 20000) }
                == 0,
            "Running app did not exit"
        );
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[derive(Debug)]
struct WorkBusy;
impl std::fmt::Display for WorkBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Current connector work needs to finish first")
    }
}
impl std::error::Error for WorkBusy {}

fn stopped(home: &Path, j: &Value, child: &mut Option<Child>) -> Result<File> {
    if let Ok(status) = api(home, "GET", "status", None) {
        #[cfg(windows)]
        let handles = ["pid", "launcher_pid"].map(|key| {
            status[key]
                .as_u64()
                .filter(|v| *v > 0 && *v <= u32::MAX as u64)
                .context("App process identity is missing")
                .and_then(|v| ProcessHandle::open(v as u32))
        });
        #[cfg(not(windows))]
        let _ = status;
        #[cfg(windows)]
        let handles = [
            handles[0]
                .as_ref()
                .map_err(|e| anyhow::anyhow!(e.to_string()))?,
            handles[1]
                .as_ref()
                .map_err(|e| anyhow::anyhow!(e.to_string()))?,
        ];
        let response = api(
            home,
            "POST",
            "native-update/stop",
            Some(&json!({"request_id":j["request_id"]})),
        )?;
        if response["accepted"] == false && response["reason"] == "busy" {
            return Err(WorkBusy.into());
        }
        ensure!(
            response["accepted"] == true,
            "Connector stop was not confirmed"
        );
        #[cfg(windows)]
        for handle in handles {
            handle.wait()?;
        }
    }
    // A known child may not yet hold service.lock. Keep its identity until exit.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(process) = child.as_mut()
            && process.try_wait()?.is_none()
        {
            if std::time::Instant::now() >= deadline {
                anyhow::bail!("Known replacement stop is unresolved");
            }
            if api(home, "GET", "status", None).is_ok() {
                let _ = api(
                    home,
                    "POST",
                    "native-update/stop",
                    Some(&json!({"request_id":j["request_id"]})),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        match lock(home, "service.lock") {
            Ok(lock) => return Ok(lock),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}
fn install(home: &Path, dir: &Path, restore: bool, j: &Value) -> Result<()> {
    let (from, metadata, exe) = if restore {
        (
            dir.join("previous-files"),
            &j["previous"],
            dir.join("previous-binary"),
        )
    } else {
        (
            dir.join("candidate-files"),
            &j["candidate"],
            dir.join(if cfg!(windows) {
                "worker.exe"
            } else {
                "worker"
            }),
        )
    };
    validate_files(&from, metadata)?;
    ensure!(
        metadata["launcher_sha256"] == sha(&exe)?,
        "Staged executable changed"
    );
    // Immutable files only. The old trees remain with this durable transaction.
    for name in ["app", "runtime"] {
        let target = home.join(name);
        let next = dir.join(format!("next-{name}"));
        if next.exists() {
            fs::remove_dir_all(&next)?;
        }
        copy_tree(&from.join(name), &next)?;
        let old = dir.join(format!("replaced-{name}"));
        if old.exists() {
            fs::remove_dir_all(&old)?;
        }
        if target.exists() {
            platform::publish_directory_if_absent(&target, &old)?;
        }
        platform::publish_directory_if_absent(&next, &target)?;
    }
    copy_file(&exe, &binary(home))?;
    platform::private_write(
        &home.join("native-bundle.json"),
        &serde_json::to_vec(metadata)?,
    )?;
    Ok(())
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    platform::private_dir(to)?;
    for item in fs::read_dir(from)? {
        let item = item?;
        let kind = item.file_type()?;
        ensure!(!kind.is_symlink(), "Runtime links are unsupported");
        if kind.is_dir() {
            copy_tree(&item.path(), &to.join(item.file_name()))?;
        } else {
            copy_file(&item.path(), &to.join(item.file_name()))?;
        }
    }
    Ok(())
}
fn start(home: &Path, j: &mut Value) -> Result<Child> {
    let nonce = random();
    j["launch_nonce"] = json!(nonce);
    save(home, j)?;
    let mut command = Command::new(binary(home));
    command
        .env("ACP_TEAMS_UPDATE_NONCE", nonce)
        .env(
            "ACP_TEAMS_UPDATE_REQUEST",
            j["request_id"].as_str().context("Missing update request")?,
        )
        .env(
            "ACP_TEAMS_UPDATE_PHASE",
            j["phase"].as_str().context("Missing update phase")?,
        )
        .arg("--home")
        .arg(home)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    Ok(command.spawn()?)
}
fn healthy(home: &Path, j: &Value, metadata: &Value, child: &mut Child) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    loop {
        ensure!(
            child.try_wait()?.is_none(),
            "Replacement exited before readiness"
        );
        if let Ok(value) = api(home, "GET", "status", None)
            && value["id"] == j["installation_id"]
            && value["version"] == metadata["version"]
            && value["launcher_pid"] == child.id()
            && sha(&binary(home))? == metadata["launcher_sha256"]
        {
            return Ok(());
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "Replacement did not confirm its identity and version"
        );
        std::thread::sleep(Duration::from_millis(150));
    }
}
pub fn apply(home: &Path, id: &str) -> Result<()> {
    let _lock = lock(home, "native-update.lock")?;
    let mut j = saved(home)?;
    ensure!(
        j["request_id"] == id && owner(home)?["id"] == j["installation_id"],
        "Update identity changed"
    );
    if j["phase"] == "cancelled" {
        return Ok(());
    }
    if terminal(&j) {
        let _ = api(
            home,
            "POST",
            "native-update/finish",
            Some(&json!({"request_id":id})),
        );
        return Ok(());
    }
    let dir = directory(home, id)?;
    let mut child = None;
    if matches!(j["phase"].as_str(), Some("prepared" | "deferred")) {
        let preflight = (|| -> Result<Value> {
            ensure!(
                protected(home)? == j["protected"],
                "Saved settings changed. Discard this prepared update and reopen the download; no update was applied"
            );
            api(home, "GET", "native-update/readiness", None).context("Could not verify the running connector. Open the installed connector first, then return here to install; no update was applied")
        })();
        let readiness = match preflight {
            Ok(value) => value,
            Err(error) => {
                j["error"] = json!(error.to_string());
                save(home, &j)?;
                return Err(error);
            }
        };
        if readiness["idle"] != true {
            j["error"] = json!("Current connector work needs to finish first");
            phase(home, &mut j, "deferred")?;
            anyhow::bail!("Current connector work needs to finish first");
        }
        j.as_object_mut().unwrap().remove("error");
        let result = (|| -> Result<()> {
            phase(home, &mut j, "stopping")?;
            let service = stopped(home, &j, &mut child)?;
            phase(home, &mut j, "swapping")?;
            install(home, &dir, false, &j)?;
            phase(home, &mut j, "starting")?;
            drop(service);
            child = Some(start(home, &mut j)?);
            healthy(home, &j, &j["candidate"], child.as_mut().unwrap())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                phase(home, &mut j, "applied")?;
                let _ = api(
                    home,
                    "POST",
                    "native-update/finish",
                    Some(&json!({"request_id":id})),
                );
                return Ok(());
            }
            Err(error) => {
                j["error"] = json!(error.to_string());
                if j["phase"] == "stopping" {
                    let refused = error.downcast_ref::<WorkBusy>().is_some();
                    phase(
                        home,
                        &mut j,
                        if refused {
                            "deferred"
                        } else {
                            "recovery_required"
                        },
                    )?;
                    return Err(error);
                }
                save(home, &j)?;
            }
        }
    }
    phase(home, &mut j, "rolling_back")?;
    let result = (|| -> Result<()> {
        let service = stopped(home, &j, &mut child)?;
        install(home, &dir, true, &j)?;
        phase(home, &mut j, "rollback_starting")?;
        drop(service);
        child = Some(start(home, &mut j)?);
        healthy(home, &j, &j["previous"], child.as_mut().unwrap())?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            phase(home, &mut j, "rolled_back")?;
            let _ = api(
                home,
                "POST",
                "native-update/finish",
                Some(&json!({"request_id":id})),
            );
            Ok(())
        }
        Err(error) => {
            j["error"] = json!(error.to_string());
            phase(home, &mut j, "recovery_required")?;
            Err(error)
        }
    }
}
struct Offer {
    home: PathBuf,
    id: std::sync::Mutex<Option<String>>,
    error: std::sync::Mutex<Option<String>>,
    origin: String,
    token: String,
}
pub fn offer(home: &Path, no_browser: bool) -> Result<()> {
    let home = home.to_owned();
    tokio::runtime::Runtime::new()?.block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let token = random();
        let url = format!("{origin}/#{token}");
        if no_browser {
            println!("{}", json!({"state":"preparing_update","url":url}));
        } else {
            platform::open_browser(&url)?;
        }
        let state = Arc::new(Offer {
            home,
            id: std::sync::Mutex::new(None),
            error: std::sync::Mutex::new(None),
            origin,
            token,
        });
        let preparation = state.clone();
        tokio::task::spawn_blocking(move || match stage(&preparation.home) {
            Ok(j) => *preparation.id.lock().unwrap() = j["request_id"].as_str().map(str::to_owned),
            Err(error) => *preparation.error.lock().unwrap() = Some(error.to_string()),
        });
        axum::serve(
            listener,
            Router::new().fallback(any(offer_request)).with_state(state),
        )
        .await?;
        Ok(())
    })
}
async fn offer_request(State(s): State<Arc<Offer>>, request: Request) -> Response {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != s.origin.strip_prefix("http://")
        || request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|v| v.to_str().ok() != Some(&s.origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() == "GET" && request.uri().path() == "/" {
        return ([(header::CONTENT_TYPE,"text/html; charset=utf-8"),(header::CACHE_CONTROL,"no-store"),(header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")],include_str!("update.html")).into_response();
    }
    if request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {}", s.token).as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = (|| -> Result<Value> {
        let id = s.id.lock().unwrap().clone();
        if id.is_none() && request.method() == "GET" && request.uri().path() == "/status" {
            return Ok(
                json!({"phase":"preparing","version":env!("CARGO_PKG_VERSION"),"error":s.error.lock().unwrap().clone(),"worker_active":true}),
            );
        }
        let id = id.context("Private application files are still being prepared")?;
        let j = saved(&s.home)?;
        ensure!(j["request_id"] == id, "Update request changed");
        match (request.method().as_str(), request.uri().path()) {
            ("GET", "/status") => Ok(
                json!({"phase":j["phase"],"version":j["candidate"]["version"],"error":j["error"],"worker_active":worker_active(&s.home),"url":owner(&s.home)?["origin"]}),
            ),
            ("POST", "/discard") => {
                discard(&s.home, &id)?;
                Ok(json!({"discarded":true,"request_id":id}))
            }
            ("POST", "/apply") => {
                let _guard = lock(&s.home, "native-update.lock")?;
                let executable = directory(&s.home, &id)?.join(if cfg!(windows) {
                    "worker.exe"
                } else {
                    "worker"
                });
                ensure!(
                    sha(&executable)? == j["candidate"]["launcher_sha256"],
                    "Worker changed"
                );
                let mut command = Command::new(executable);
                command
                    .arg("--home")
                    .arg(&s.home)
                    .arg("apply-update")
                    .arg(&id)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000 | 0x00000200);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    command.process_group(0);
                }
                // The child acquires the same lock and reconciles this exact journal.
                // Release our validation guard before it can begin execution.
                drop(_guard);
                command.spawn()?;
                Ok(json!({"accepted":true,"request_id":id}))
            }
            _ => anyhow::bail!("Unknown operation"),
        }
    })();
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::CONFLICT, Json(json!({"error":e.to_string()}))).into_response(),
    }
}

/// An interrupted worker cannot leave a late child starting across recovery.
pub fn validate_launch(home: &Path) -> Result<()> {
    let request = std::env::var("ACP_TEAMS_UPDATE_REQUEST").ok();
    let phase_expected = std::env::var("ACP_TEAMS_UPDATE_PHASE").ok();
    let nonce = std::env::var("ACP_TEAMS_UPDATE_NONCE").ok();
    validate_launch_request(
        home,
        request.as_deref(),
        phase_expected.as_deref(),
        nonce.as_deref(),
    )
}
fn launch_binding(
    j: &Value,
    request: &str,
    phase_expected: Option<&str>,
    nonce: Option<&str>,
) -> bool {
    j["request_id"] == request
        && j["phase"].as_str() == phase_expected
        && matches!(phase_expected, Some("starting" | "rollback_starting"))
        && nonce.is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        && j["launch_nonce"].as_str() == nonce
}
fn validate_launch_request(
    home: &Path,
    request: Option<&str>,
    phase_expected: Option<&str>,
    nonce: Option<&str>,
) -> Result<()> {
    validate_launch_with_hash(home, request, phase_expected, nonce, || sha(&binary(home)))
}
fn validate_launch_with_hash(
    home: &Path,
    request: Option<&str>,
    phase_expected: Option<&str>,
    nonce: Option<&str>,
    hash: impl FnOnce() -> Result<String>,
) -> Result<()> {
    let j = optional_saved(home)?;
    if let Some(request) = request {
        let j = j.context("No update owns this launch")?;
        ensure!(
            launch_binding(&j, request, phase_expected, nonce),
            "Update launch was superseded"
        );
        let key = if phase_expected == Some("starting") {
            "candidate"
        } else {
            "previous"
        };
        let digest = hash()?;
        ensure!(
            digest == j[key]["launcher_sha256"],
            "Update launch bytes changed"
        );
        // A recovery can invalidate this launch while a large executable is read.
        let latest = saved(home)?;
        ensure!(
            launch_binding(&latest, request, phase_expected, nonce)
                && latest["installation_id"] == j["installation_id"]
                && latest[key]["launcher_sha256"] == digest,
            "Update launch was superseded during verification"
        );
    } else if let Some(j) = j {
        ensure!(
            matches!(
                j["phase"].as_str(),
                Some("prepared" | "deferred" | "applied" | "rolled_back" | "cancelled")
            ),
            "Open the prepared download to finish or recover the current update"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_publication_keeps_open_reader_on_its_original_snapshot() {
        use std::io::Read;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut j = json!({"schema":1,"request_id":uuid::Uuid::new_v4().to_string(),"installation_id":uuid::Uuid::new_v4().to_string(),"phase":"stopping","candidate":{},"previous":{},"protected":{}});
        save(home, &j).unwrap();
        let before = fs::read(home.join("native-update.json")).unwrap();
        let mut reader = File::open(home.join("native-update.json")).unwrap();
        phase(home, &mut j, "swapping").unwrap();
        assert_eq!(saved(home).unwrap(), j);
        let mut retained = Vec::new();
        reader.read_to_end(&mut retained).unwrap();
        assert_eq!(
            retained, before,
            "An active reader retains one complete prior snapshot"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&retained).unwrap()["phase"],
            "stopping"
        );
    }
    #[test]
    fn late_launch_is_rejected_after_recovery_changes_phase() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        platform::private_dir(&home.join("bin")).unwrap();
        fs::write(binary(home), b"installed").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut j = json!({"schema":1,"request_id":id,"installation_id":uuid::Uuid::new_v4().to_string(),"phase":"starting","launch_nonce":"a".repeat(64),"candidate":{"launcher_sha256":sha(&binary(home)).unwrap()},"previous":{},"protected":{}});
        save(home, &j).unwrap();
        assert!(
            validate_launch_request(home, Some(&id), Some("starting"), Some(&"a".repeat(64)))
                .is_ok()
        );
        j["phase"] = json!("rolling_back");
        save(home, &j).unwrap();
        assert!(
            validate_launch_request(home, Some(&id), Some("starting"), Some(&"a".repeat(64)))
                .is_err()
        );
        assert!(validate_launch_request(home, None, None, None).is_err());
    }
    #[test]
    fn repeated_rollback_rejects_the_prior_launch_generation() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        platform::private_dir(&home.join("bin")).unwrap();
        fs::write(binary(home), b"installed").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let old_nonce = random();
        let mut j = json!({"schema":1,"request_id":id,"installation_id":uuid::Uuid::new_v4().to_string(),"phase":"rollback_starting","launch_nonce":old_nonce,"candidate":{},"previous":{"launcher_sha256":sha(&binary(home)).unwrap()},"protected":{}});
        save(home, &j).unwrap();
        assert!(
            validate_launch_request(home, Some(&id), Some("rollback_starting"), Some(&old_nonce))
                .is_ok()
        );
        j["launch_nonce"] = json!(random());
        save(home, &j).unwrap();
        assert!(
            validate_launch_request(home, Some(&id), Some("rollback_starting"), Some(&old_nonce))
                .is_err(),
            "A stale child must not reuse a later rollback's launch permission"
        );
    }
    #[test]
    fn launch_rechecks_nonce_after_executable_verification() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        platform::private_dir(&home.join("bin")).unwrap();
        fs::write(binary(home), b"installed").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let nonce = random();
        let digest = sha(&binary(home)).unwrap();
        let mut j = json!({"schema":1,"request_id":id,"installation_id":uuid::Uuid::new_v4().to_string(),"phase":"starting","launch_nonce":nonce,"candidate":{"launcher_sha256":digest},"previous":{},"protected":{}});
        save(home, &j).unwrap();
        let result =
            validate_launch_with_hash(home, Some(&id), Some("starting"), Some(&nonce), || {
                j["launch_nonce"] = json!(random());
                save(home, &j)?;
                Ok(digest.clone())
            });
        assert!(result.is_err());
    }
    #[test]
    fn invalid_existing_journal_never_becomes_a_fresh_installation() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        assert!(optional_saved(home).unwrap().is_none());
        for raw in [b"{partial".as_slice(), b"{}".as_slice()] {
            fs::write(home.join("native-update.json"), raw).unwrap();
            assert!(optional_saved(home).is_err());
            assert!(validate_launch_request(home, None, None, None).is_err());
            assert_eq!(fs::read(home.join("native-update.json")).unwrap(), raw);
        }
    }
    #[test]
    fn discard_is_only_available_before_cutover_and_retains_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let id = uuid::Uuid::new_v4().to_string();
        let mut j = json!({"schema":1,"request_id":id,"installation_id":uuid::Uuid::new_v4().to_string(),"phase":"prepared","candidate":{},"previous":{},"protected":{}});
        save(home, &j).unwrap();
        discard(home, &id).unwrap();
        assert_eq!(saved(home).unwrap()["phase"], "cancelled");
        assert_eq!(
            read_json(&directory(home, &id).unwrap().join("completion.json")).unwrap()["phase"],
            "cancelled"
        );
        for phase in ["stopping", "swapping", "starting", "recovery_required"] {
            j["phase"] = json!(phase);
            save(home, &j).unwrap();
            assert!(discard(home, &id).is_err());
            assert_eq!(saved(home).unwrap()["phase"], phase);
        }
    }
    #[test]
    fn staged_inventory_refuses_changed_content_and_parent_paths() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::create_dir(home.join("app")).unwrap();
        fs::write(home.join("app/file"), b"original").unwrap();
        let mut manifest = json!({"schema":1,"component":"acp-teams-adapter","files":{"app/file":sha(&home.join("app/file")).unwrap()}});
        assert!(validate_files(home, &manifest).is_ok());
        fs::write(home.join("app/file"), b"changed").unwrap();
        assert!(validate_files(home, &manifest).is_err());
        manifest["files"] = json!({"../private":"bad"});
        assert!(validate_files(home, &manifest).is_err());
    }
    #[test]
    fn immutable_package_copy_leaves_configuration_and_evidence_alone() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let source = home.join("source");
        let dest = home.join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&dest).unwrap();
        fs::write(source.join("app.txt"), b"app").unwrap();
        fs::write(dest.join("conversation.sqlite"), b"newest data").unwrap();
        let manifest = json!({"schema":1,"component":"acp-teams-adapter","files":{"app.txt":sha(&source.join("app.txt")).unwrap()}});
        copy_files(&source, &dest, &manifest).unwrap();
        assert_eq!(
            fs::read(dest.join("conversation.sqlite")).unwrap(),
            b"newest data"
        );
    }
}
