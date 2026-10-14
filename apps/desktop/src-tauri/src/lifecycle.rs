//! The desktop is a management companion, never the owner of the shared gateway.
use crate::{api::AdminClient, settings::ConnectionSettings};
use std::{
    ffi::{OsStr, OsString},
    net::{IpAddr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

#[derive(Debug, PartialEq)]
pub enum PortState {
    Refused,
    Occupied,
    Unknown,
}

pub fn endpoint(base: &str) -> Result<SocketAddr, String> {
    let url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    let host = url
        .host_str()
        .ok_or("Missing local host")?
        .trim_matches(['[', ']']);
    let ip: IpAddr = host.parse().map_err(|_| "Use a numeric loopback address")?;
    if url.scheme() != "http" || !ip.is_loopback() {
        return Err("Only local HTTP loopback endpoints are allowed".into());
    }
    Ok(SocketAddr::new(
        ip,
        url.port_or_known_default().ok_or("Missing port")?,
    ))
}

pub fn probe_port(addr: SocketAddr) -> PortState {
    match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(_) => PortState::Occupied,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => PortState::Refused,
        Err(_) => PortState::Unknown,
    }
}

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn resolve_binary(
    custom: Option<&OsStr>,
    home: &Path,
    path: &OsStr,
) -> Result<PathBuf, String> {
    if let Some(custom) = custom.filter(|s| !s.is_empty()) {
        let custom = PathBuf::from(custom);
        if executable(&custom) {
            return Ok(custom);
        }
        return Err("CCR_BIN must point to an existing executable".into());
    }
    let names: &[&str] = if cfg!(windows) {
        &["ccr.cmd", "ccr.exe", "ccr"]
    } else {
        &["ccr"]
    };
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".npm-global/bin"),
        home.join(".local/bin"),
    ]);
    if cfg!(windows) {
        dirs.push(home.join("AppData/Roaming/npm"));
    }
    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err("ccr not found: install CCR and Node.js, or set CCR_BIN".into())
}

pub fn launcher_path(bin: &Path, inherited: &OsStr) -> Result<OsString, String> {
    let parent = bin
        .parent()
        .ok_or("CCR executable has no parent directory")?;
    let mut dirs = vec![parent.to_path_buf()];
    dirs.extend(std::env::split_paths(inherited));
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    std::env::join_paths(dirs).map_err(|e| e.to_string())
}

// Launch only when the installed CLI's own config proves it uses this endpoint.
// A desktop-only URL override is not proof of the CLI's listen port.
fn config_matches(addr: SocketAddr) -> bool {
    let dir = std::env::var_os("CCR_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|h| PathBuf::from(h).join(".claude-code-router"))
        });
    let Some(file) = dir.map(|d| d.join("config.json")) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(file) else {
        return false;
    };
    config_text_matches(&raw, addr, &|name| std::env::var(name).ok())
}

fn config_text_matches<F: Fn(&str) -> Option<String>>(
    raw: &str,
    addr: SocketAddr,
    env: &F,
) -> bool {
    let Ok(config) = json5::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    if !config.is_object() {
        return false;
    }
    // Only PORT/HOST/SERVICE_PORT prove the endpoint. Unresolvable APIKEY or provider
    // placeholders (common for GUI apps launched from Finder) must not block auto-start
    // proof, so they are deliberately ignored here.
    let resolver = |name: &str| {
        if name.starts_with("CCR_DESKTOP_") {
            None
        } else {
            env(name)
        }
    };
    let config_port = match config.get("PORT") {
        None | Some(serde_json::Value::Null) => "3456".to_string(),
        Some(serde_json::Value::String(text)) => {
            match crate::settings::interpolate(text, &resolver) {
                Ok(port) => port,
                Err(_) => return false,
            }
        }
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => return false,
    };
    let Ok(mut port) = config_port.parse::<u16>() else {
        return false;
    };
    if port == 0 {
        return false;
    }
    // SERVICE_PORT is a CLI/runtime override, unlike the desktop-only port.
    if let Some(value) = env("SERVICE_PORT") {
        match value.parse::<u16>() {
            Ok(override_port) if override_port != 0 => port = override_port,
            _ => return false,
        }
    }
    let host = match config.get("HOST") {
        None => "127.0.0.1".to_string(),
        Some(serde_json::Value::String(host)) => {
            match crate::settings::interpolate(host, &resolver) {
                Ok(host) => host,
                Err(_) => return false,
            }
        }
        _ => return false,
    };
    let host_matches = host
        .parse::<IpAddr>()
        .map(|ip| ip == addr.ip() || ip.is_unspecified())
        .unwrap_or(false);
    port == addr.port() && host_matches
}

fn spawn_gateway(addr: SocketAddr) -> Result<Child, String> {
    if !config_matches(addr) {
        return Err("Cannot safely auto-start: endpoint does not match a known local CCR config. Start ccr manually.".into());
    }
    let home = PathBuf::from(
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    );
    let path = std::env::var_os("PATH").unwrap_or_default();
    let custom = std::env::var_os("CCR_BIN");
    let bin = resolve_binary(custom.as_deref(), &home, &path)?;
    // Recheck immediately before launching; never reclaim an occupied port.
    if probe_port(addr) != PortState::Refused {
        return Err("Port became occupied; not starting another gateway".into());
    }
    Command::new(&bin)
        .arg("start")
        .env("PATH", launcher_path(&bin, &path)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not launch ccr start: {e}"))
}

pub struct Startup {
    pub ready: bool,
    pub message: String,
    pub launcher: Option<Child>,
}

pub async fn connect_or_launch(client: &AdminClient, settings: &ConnectionSettings) -> Startup {
    if client.health().await {
        return Startup {
            ready: true,
            message: "Connected".into(),
            launcher: None,
        };
    }
    // Allow an already-starting server a short chance to become ready.
    for _ in 0..2 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if client.health().await {
            return Startup {
                ready: true,
                message: "Connected".into(),
                launcher: None,
            };
        }
    }
    let addr = match endpoint(&settings.base_url) {
        Ok(addr) => addr,
        Err(message) => {
            return Startup {
                ready: false,
                message,
                launcher: None,
            }
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || match probe_port(addr) {
        PortState::Refused => spawn_gateway(addr),
        PortState::Occupied => {
            Err("API unavailable on an occupied port. No process was stopped or replaced.".into())
        }
        PortState::Unknown => {
            Err("Port status unknown; not starting a gateway. Start ccr manually.".into())
        }
    })
    .await;
    let mut launcher = match result {
        Ok(Ok(child)) => Some(child),
        Ok(Err(message)) => {
            return Startup {
                ready: false,
                message,
                launcher: None,
            }
        }
        Err(e) => {
            return Startup {
                ready: false,
                message: e.to_string(),
                launcher: None,
            }
        }
    };
    for _ in 0..20 {
        if let Some(child) = launcher.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                launcher = None;
            }
        }
        if client.health().await {
            return Startup {
                ready: true,
                message: "Connected (gateway stays running on desktop exit)".into(),
                launcher,
            };
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Startup {
        ready: false,
        message: "Gateway did not become ready. Use Refresh after starting ccr manually.".into(),
        launcher,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_and_accepts_loopback() {
        assert!(endpoint("http://192.168.1.2:3456").is_err());
        assert!(endpoint("https://127.0.0.1:3456").is_err());
        assert!(endpoint("http://[::1]:3456").unwrap().ip().is_loopback());
    }
    #[test]
    fn occupied_non_ccr_port_is_not_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert_eq!(
            probe_port(listener.local_addr().unwrap()),
            PortState::Occupied
        );
        let addr = listener.local_addr().unwrap();
        drop(listener);
        assert_eq!(probe_port(addr), PortState::Refused);
    }
    async fn startup_against_mock(status: u16, count: usize) -> Startup {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        // Keep a duplicate listener alive through the occupied-port safety probe.
        let held_listener = listener.try_clone().unwrap();
        let worker = std::thread::spawn(move || {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).unwrap();
                let body = "{\"status\":\"ok\"}";
                write!(socket, "HTTP/1.1 {status} Mock\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let settings = ConnectionSettings {
            base_url,
            api_key: None,
        };
        let client = AdminClient::new(settings.clone()).unwrap();
        let startup = connect_or_launch(&client, &settings).await;
        worker.join().unwrap();
        drop(held_listener);
        startup
    }
    #[tokio::test]
    async fn healthy_mock_never_launches() {
        let startup = startup_against_mock(200, 1).await;
        assert!(startup.ready);
        assert!(startup.launcher.is_none());
    }
    #[tokio::test]
    async fn occupied_unhealthy_mock_stays_offline_without_launching() {
        let startup = startup_against_mock(503, 3).await;
        assert!(!startup.ready);
        assert!(startup.launcher.is_none());
        assert!(startup.message.contains("occupied port"));
    }
    #[test]
    fn config_proof_rejects_conflicts_and_bad_ports() {
        let addr = endpoint("http://127.0.0.1:4000").unwrap();
        assert!(config_text_matches("{PORT:4000}", addr, &|_| None));
        assert!(!config_text_matches("{PORT:3456}", addr, &|_| None));
        assert!(!config_text_matches("{PORT:'bad'}", addr, &|_| None));
        assert!(!config_text_matches("[]", addr, &|_| None));
        assert!(!config_text_matches(
            "{PORT:4000, HOST:'192.168.1.2'}",
            addr,
            &|_| None
        ));
        let env = |name: &str| match name {
            "SERVICE_PORT" => Some("4001".into()),
            "CCR_DESKTOP_PORT" => Some("4000".into()),
            _ => None,
        };
        assert!(!config_text_matches("{PORT:4000}", addr, &env));
    }
    #[test]
    fn resolver_honors_custom_and_path_parent() {
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            resolve_binary(Some(exe.as_os_str()), Path::new("/missing"), OsStr::new("")).unwrap(),
            exe
        );
        assert!(resolve_binary(
            Some(OsStr::new("/does-not-exist")),
            Path::new("/missing"),
            OsStr::new("")
        )
        .is_err());
        let joined = launcher_path(&exe, OsStr::new("/usr/bin:/bin")).unwrap();
        assert_eq!(
            std::env::split_paths(&joined).next().unwrap(),
            exe.parent().unwrap()
        );
    }
}
