use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::fd::AsRawFd;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const MINIMUM_CODEX_VERSION: (u32, u32, u32) = (0, 153, 4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SERVER_PAGE_SIZE: u32 = 250;
const DEFAULT_PAGE_SIZE: usize = 25;
const MAX_PAGE_SIZE: usize = 100;
const ALL_SOURCE_KINDS: [&str; 10] = [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
];

static HISTORY_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn operation_lock() -> &'static Mutex<()> {
    HISTORY_OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(windows)]
struct HistoryMutationGuard {
    handle: isize,
}

#[cfg(windows)]
impl Drop for HistoryMutationGuard {
    fn drop(&mut self) {
        unsafe {
            ReleaseSemaphore(
                self.handle as *mut std::ffi::c_void,
                1,
                std::ptr::null_mut(),
            );
            CloseHandle(self.handle as *mut std::ffi::c_void);
        }
    }
}

#[cfg(unix)]
struct HistoryMutationGuard {
    file: File,
}

#[cfg(unix)]
impl Drop for HistoryMutationGuard {
    fn drop(&mut self) {
        unsafe {
            flock(self.file.as_raw_fd(), LOCK_UN);
        }
    }
}

#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const WAIT_TIMEOUT: u32 = 0x00000102;
#[cfg(unix)]
const LOCK_EX: i32 = 2;
#[cfg(unix)]
const LOCK_NB: i32 = 4;
#[cfg(unix)]
const LOCK_UN: i32 = 8;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateSemaphoreW(
        attributes: *mut std::ffi::c_void,
        initial_count: i32,
        maximum_count: i32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn ReleaseSemaphore(
        handle: *mut std::ffi::c_void,
        release_count: i32,
        previous_count: *mut i32,
    ) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

#[cfg(unix)]
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryCapabilities {
    pub available: bool,
    pub cli_version: String,
    pub cli_path: String,
    pub codex_home: String,
    pub project_management: bool,
    pub minimum_cli_version: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListQuery {
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub search_term: Option<String>,
    #[serde(default)]
    pub project_filter: HistoryProjectFilter,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub updated_after: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryProjectFilter {
    #[default]
    All,
    Unassigned,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryOverview {
    pub capabilities: HistoryCapabilities,
    pub totals: HistoryTotals,
    pub projects: Vec<HistoryProjectSummary>,
    pub threads: Vec<HistoryThreadSummary>,
    pub filtered_count: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryTotals {
    pub projects: usize,
    pub active_threads: usize,
    pub archived_threads: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryProjectSummary {
    pub id: String,
    pub name: String,
    pub roots: Vec<String>,
    pub active_thread_count: usize,
    pub archived_thread_count: usize,
    pub recency_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryThreadSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub project_id: Option<String>,
    pub source_kind: String,
    pub status: String,
    pub active_flags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: i64,
    pub archived: bool,
    pub descendant_count: usize,
    pub can_mutate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionMutationAction {
    Rename {
        #[serde(rename = "threadId")]
        thread_id: String,
        name: String,
    },
    Archive {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Unarchive {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Delete {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
}

impl SessionMutationAction {
    fn thread_id(&self) -> &str {
        match self {
            Self::Rename { thread_id, .. }
            | Self::Archive { thread_id }
            | Self::Unarchive { thread_id }
            | Self::Delete { thread_id } => thread_id,
        }
    }

    fn action_name(&self) -> &'static str {
        match self {
            Self::Rename { .. } => "rename",
            Self::Archive { .. } => "archive",
            Self::Unarchive { .. } => "unarchive",
            Self::Delete { .. } => "delete",
        }
    }

    fn collapses_descendants(&self) -> bool {
        matches!(self, Self::Archive { .. } | Self::Delete { .. })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMutationSummary {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub results: Vec<SessionMutationResult>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMutationResult {
    pub thread_id: String,
    pub action: String,
    pub success: bool,
    pub skipped_descendant: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ProjectMutationAction {
    Remove {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectMutationResult {
    pub project_id: String,
    pub success: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexCli {
    path: PathBuf,
    version: String,
}

pub struct CodexHistoryManager {
    cli: CodexCli,
    codex_home_override: Option<PathBuf>,
}

impl CodexHistoryManager {
    pub async fn discover() -> Result<Self, String> {
        Self::discover_with_home(None).await
    }

    async fn discover_with_home(codex_home_override: Option<PathBuf>) -> Result<Self, String> {
        let cli = discover_codex_cli().await?;
        Ok(Self {
            cli,
            codex_home_override,
        })
    }

    async fn connect(&self) -> Result<(AppServerSession, String), String> {
        AppServerSession::connect(&self.cli.path, self.codex_home_override.as_deref()).await
    }

    fn acquire_mutation_guard(&self) -> Result<HistoryMutationGuard, String> {
        let codex_home = self
            .codex_home_override
            .clone()
            .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
            .ok_or_else(|| "Cannot determine the Codex home directory for history locking.".to_string())?;
        let canonical_home = std::fs::canonicalize(&codex_home).unwrap_or_else(|_| {
            if codex_home.is_absolute() {
                codex_home
            } else {
                std::env::current_dir()
                    .map(|current| current.join(&codex_home))
                    .unwrap_or(codex_home)
            }
        });
        let mut lock_key = canonical_home.to_string_lossy().into_owned();
        if cfg!(windows) {
            lock_key = lock_key.replace('/', "\\");
            lock_key.make_ascii_lowercase();
        }
        let digest = format!("{:x}", Sha256::digest(lock_key.as_bytes()));

        #[cfg(windows)]
        {
            let name = format!("Local\\CodexSwitcherHistory-{}", &digest[..24]);
            let wide_name = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
            let handle = unsafe {
                CreateSemaphoreW(std::ptr::null_mut(), 1, 1, wide_name.as_ptr())
            };
            if handle.is_null() {
                return Err("Failed to create the Codex history mutation lock.".to_string());
            }
            let wait_result = unsafe { WaitForSingleObject(handle, 0) };
            if wait_result == WAIT_TIMEOUT {
                unsafe {
                    CloseHandle(handle);
                }
                return Err(
                    "Another Codex Switcher window is already changing Codex history. Try again when it finishes."
                        .to_string(),
                );
            }
            if wait_result != WAIT_OBJECT_0 {
                let error = unsafe { GetLastError() };
                unsafe {
                    CloseHandle(handle);
                }
                return Err(format!(
                    "Failed to acquire the Codex history mutation lock (Win32 error {error})."
                ));
            }
            return Ok(HistoryMutationGuard {
                handle: handle as isize,
            });
        }

        #[cfg(unix)]
        {
            let lock_path = std::env::temp_dir().join(format!(
                "codex-switcher-history-{}.lock",
                &digest[..24]
            ));
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|error| format!("Failed to open the Codex history lock: {error}"))?;
            if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
                return Err(
                    "Another Codex Switcher window is already changing Codex history. Try again when it finishes."
                        .to_string(),
                );
            }
            Ok(HistoryMutationGuard { file })
        }
    }

    fn capabilities(&self, codex_home: String, project_management: bool) -> HistoryCapabilities {
        HistoryCapabilities {
            available: true,
            cli_version: self.cli.version.clone(),
            cli_path: self.cli.path.to_string_lossy().into_owned(),
            codex_home,
            project_management,
            minimum_cli_version: format!(
                "{}.{}.{}",
                MINIMUM_CODEX_VERSION.0, MINIMUM_CODEX_VERSION.1, MINIMUM_CODEX_VERSION.2
            ),
        }
    }

    pub async fn get_capabilities(&self) -> Result<HistoryCapabilities, String> {
        let _guard = operation_lock().lock().await;
        let (mut session, codex_home) = self.connect().await?;
        let result = probe_project_management(&mut session)
            .await
            .map(|project_management| self.capabilities(codex_home, project_management));
        let shutdown = session.shutdown().await;
        merge_session_shutdown(result, shutdown)
    }

    pub async fn list_overview(&self, query: HistoryListQuery) -> Result<HistoryOverview, String> {
        let _guard = operation_lock().lock().await;
        let (mut session, codex_home) = self.connect().await?;
        let result = async {
            let projects = match fetch_projects(&mut session).await {
                Ok(projects) => Some(projects),
                Err(error) if is_method_unavailable(&error) => None,
                Err(error) => return Err(error),
            };
            let active_threads = fetch_threads(&mut session, false).await?;
            let archived_threads = fetch_threads(&mut session, true).await?;
            let project_management = projects.is_some();
            build_overview(
                self.capabilities(codex_home, project_management),
                projects.unwrap_or_default(),
                active_threads,
                archived_threads,
                query,
            )
        }
        .await;
        let shutdown = session.shutdown().await;
        merge_session_shutdown(result, shutdown)
    }

    pub async fn mutate_sessions(
        &self,
        actions: Vec<SessionMutationAction>,
    ) -> Result<SessionMutationSummary, String> {
        if actions.is_empty() {
            return Ok(SessionMutationSummary {
                total: 0,
                succeeded: 0,
                failed: 0,
                results: Vec::new(),
                warning: None,
            });
        }
        let _guard = operation_lock().lock().await;
        let _system_guard = self.acquire_mutation_guard()?;
        crate::commands::process::ensure_codex_not_running_for_history()?;
        let (mut session, _) = self.connect().await?;
        let server_pid = match session.process_id() {
            Some(server_pid) => server_pid,
            None => {
                let shutdown = session.shutdown().await;
                return merge_session_shutdown(
                    Err("Codex app server process ID is unavailable.".to_string()),
                    shutdown,
                );
            }
        };
        let result = async {
            let mut all_threads = fetch_threads(&mut session, false).await?;
            all_threads.extend(fetch_threads(&mut session, true).await?);
            let parents: HashMap<String, Option<String>> = all_threads
                .iter()
                .map(|thread| {
                    (
                        thread.id.clone(),
                        thread.effective_parent_id().map(str::to_string),
                    )
                })
                .collect();
            let mut indexed_actions = actions.into_iter().enumerate().collect::<Vec<_>>();
            indexed_actions.sort_by_key(|(index, action)| {
                (
                    action
                        .collapses_descendants()
                        .then(|| ancestor_depth(action.thread_id(), &parents))
                        .unwrap_or_default(),
                    *index,
                )
            });
            let mut successful_collapsing_actions: HashMap<&str, HashSet<String>> = HashMap::new();
            let mut writer_block: Option<String> = None;
            let mut results = vec![None; indexed_actions.len()];
            for (index, action) in indexed_actions {
                let thread_id = action.thread_id().to_string();
                let action_name = action.action_name().to_string();
                if action.collapses_descendants()
                    && successful_collapsing_actions
                        .get(action.action_name())
                        .is_some_and(|successful| {
                            has_selected_ancestor(&thread_id, successful, &parents)
                        })
                {
                    results[index] = Some(SessionMutationResult {
                        thread_id,
                        action: action_name,
                        success: true,
                        skipped_descendant: true,
                        error: None,
                    });
                    continue;
                }

                let mutation = match writer_block.as_ref() {
                    Some(error) => Err(error.clone()),
                    None => execute_session_mutation(&mut session, server_pid, &action).await,
                };
                if mutation
                    .as_ref()
                    .err()
                    .is_some_and(|error| {
                        crate::commands::process::is_codex_running_history_block(error)
                    })
                {
                    writer_block = mutation.as_ref().err().cloned();
                }
                let success = mutation.is_ok();
                if success && action.collapses_descendants() {
                    successful_collapsing_actions
                        .entry(action.action_name())
                        .or_default()
                        .insert(thread_id.clone());
                }
                results[index] = Some(SessionMutationResult {
                    thread_id,
                    action: action_name,
                    success,
                    skipped_descendant: false,
                    error: mutation.err(),
                });
            }
            let results = results
                .into_iter()
                .map(|result| result.expect("every session action produces a result"))
                .collect::<Vec<_>>();
            let succeeded = results.iter().filter(|result| result.success).count();
            Ok(SessionMutationSummary {
                total: results.len(),
                succeeded,
                failed: results.len() - succeeded,
                results,
                warning: None,
            })
        }
        .await;
        let shutdown = session.shutdown().await;
        attach_session_shutdown_warning(result, shutdown)
    }

    pub async fn mutate_project(
        &self,
        action: ProjectMutationAction,
    ) -> Result<ProjectMutationResult, String> {
        let _guard = operation_lock().lock().await;
        let _system_guard = self.acquire_mutation_guard()?;
        crate::commands::process::ensure_codex_not_running_for_history()?;
        let (mut session, _) = self.connect().await?;
        let server_pid = match session.process_id() {
            Some(server_pid) => server_pid,
            None => {
                let shutdown = session.shutdown().await;
                return merge_session_shutdown(
                    Err("Codex app server process ID is unavailable.".to_string()),
                    shutdown,
                );
            }
        };
        let result = match action {
            ProjectMutationAction::Remove { project_id } => {
                async {
                    session
                        .request("project/read", json!({ "projectId": project_id }))
                        .await?;
                    crate::commands::process::ensure_codex_not_running_for_history_except(Some(
                        server_pid,
                    ))?;
                    session
                        .request("project/delete", json!({ "projectId": project_id }))
                        .await?;
                    Ok(ProjectMutationResult {
                        project_id,
                        success: true,
                        warning: None,
                    })
                }
                .await
            }
        };
        let shutdown = session.shutdown().await;
        attach_project_shutdown_warning(result, shutdown)
    }
}

pub async fn get_history_capabilities() -> Result<HistoryCapabilities, String> {
    CodexHistoryManager::discover().await?.get_capabilities().await
}

pub async fn list_history_overview(query: HistoryListQuery) -> Result<HistoryOverview, String> {
    CodexHistoryManager::discover()
        .await?
        .list_overview(query)
        .await
}

pub async fn mutate_sessions(
    actions: Vec<SessionMutationAction>,
) -> Result<SessionMutationSummary, String> {
    CodexHistoryManager::discover()
        .await?
        .mutate_sessions(actions)
        .await
}

pub async fn mutate_project(
    action: ProjectMutationAction,
) -> Result<ProjectMutationResult, String> {
    CodexHistoryManager::discover()
        .await?
        .mutate_project(action)
        .await
}

struct AppServerSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl AppServerSession {
    async fn connect(cli_path: &Path, codex_home: Option<&Path>) -> Result<(Self, String), String> {
        let mut command = Command::new(cli_path);
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(home) = codex_home {
            command.env("CODEX_HOME", home);
        }
        if let Some(parent) = cli_path.parent().filter(|_| cli_path.components().count() > 1) {
            command.current_dir(parent);
        }
        #[cfg(windows)]
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start Codex app server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app server stdout is unavailable".to_string())?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        let initialized = match session
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "codex-switcher",
                        "title": "Codex Switcher",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "optOutNotificationMethods": [
                            "thread/started",
                            "thread/status/changed",
                            "thread/name/updated",
                            "thread/archived",
                            "thread/unarchived",
                            "thread/deleted",
                            "project/changed"
                        ]
                    }
                }),
            )
            .await
        {
            Ok(initialized) => initialized,
            Err(error) => {
                let shutdown = session.shutdown().await;
                return merge_session_shutdown(Err(error), shutdown);
            }
        };
        let codex_home = match initialized
            .get("codexHome")
            .and_then(Value::as_str)
        {
            Some(codex_home) => codex_home.to_string(),
            None => {
                let shutdown = session.shutdown().await;
                return merge_session_shutdown(
                    Err("Codex app server returned no codexHome".to_string()),
                    shutdown,
                );
            }
        };
        if let Err(error) = session.notify("initialized", None).await {
            let shutdown = session.shutdown().await;
            return merge_session_shutdown(Err(error), shutdown);
        }
        Ok((session, codex_home))
    }

    fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    async fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({ "id": id, "method": method, "params": params }))
            .await?;

        timeout(REQUEST_TIMEOUT, async {
            loop {
                let mut line = String::new();
                let bytes = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|error| format!("Failed to read Codex app server output: {error}"))?;
                if bytes == 0 {
                    let status = self.child.try_wait().ok().flatten();
                    return Err(match status {
                        Some(status) => format!("Codex app server exited with {status}"),
                        None => "Codex app server closed its output unexpectedly".to_string(),
                    });
                }
                if let Some(result) = matching_response(&line, id)? {
                    return Ok(result);
                }
            }
        })
        .await
        .map_err(|_| format!("Codex app server request `{method}` timed out"))?
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), String> {
        let encoded = serde_json::to_vec(message)
            .map_err(|error| format!("Failed to encode Codex app server request: {error}"))?;
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Failed to write Codex app server request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Failed to terminate Codex app server request: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush Codex app server request: {error}"))
    }

    async fn shutdown(&mut self) -> Result<(), String> {
        let _ = self.stdin.shutdown().await;
        if matches!(
            timeout(Duration::from_secs(2), self.child.wait()).await,
            Ok(Ok(_))
        ) {
            return Ok(());
        }
        let kill_error = self
            .child
            .start_kill()
            .err()
            .map(|error| format!("Failed to stop Codex app server: {error}"));
        match timeout(Duration::from_secs(2), self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(match kill_error {
                Some(kill_error) => format!(
                    "{kill_error}; failed to wait for Codex app server exit: {error}"
                ),
                None => format!("Failed to wait for Codex app server exit: {error}"),
            }),
            Err(_) => Err(match kill_error {
                Some(kill_error) => {
                    format!("{kill_error}; timed out waiting for Codex app server to stop.")
                }
                None => "Timed out waiting for Codex app server to stop.".to_string(),
            }),
        }
    }
}

fn merge_session_shutdown<T>(
    operation: Result<T, String>,
    shutdown: Result<(), String>,
) -> Result<T, String> {
    match (operation, shutdown) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(cleanup)) => Err(cleanup),
        (Err(operation), Ok(())) => Err(operation),
        (Err(operation), Err(cleanup)) => Err(format!(
            "{operation}; additionally failed to stop Codex app server: {cleanup}"
        )),
    }
}

fn attach_session_shutdown_warning(
    operation: Result<SessionMutationSummary, String>,
    shutdown: Result<(), String>,
) -> Result<SessionMutationSummary, String> {
    match (operation, shutdown) {
        (Ok(mut summary), Err(cleanup)) => {
            summary.warning = Some(cleanup);
            Ok(summary)
        }
        (operation, shutdown) => merge_session_shutdown(operation, shutdown),
    }
}

fn attach_project_shutdown_warning(
    operation: Result<ProjectMutationResult, String>,
    shutdown: Result<(), String>,
) -> Result<ProjectMutationResult, String> {
    match (operation, shutdown) {
        (Ok(mut result), Err(cleanup)) => {
            result.warning = Some(cleanup);
            Ok(result)
        }
        (operation, shutdown) => merge_session_shutdown(operation, shutdown),
    }
}

impl Drop for AppServerSession {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn matching_response(line: &str, expected_id: u64) -> Result<Option<Value>, String> {
    let message: Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("Codex app server returned invalid JSON: {error}"))?;
    if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Ok(None);
    }
    if let Some(error) = message.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown protocol error");
        return Err(format!("Codex app server error {code}: {text}"));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(|| "Codex app server response contains no result".to_string())
}

async fn discover_codex_cli() -> Result<CodexCli, String> {
    let candidates = codex_cli_candidates();
    let mut unsupported = Vec::new();
    for candidate in candidates {
        let mut command = Command::new(&candidate);
        command
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        let Ok(output) = timeout(Duration::from_secs(5), command.output()).await else {
            continue;
        };
        let Ok(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let version_output = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if is_supported_cli_version(&version_output) {
            return Ok(CodexCli {
                path: candidate,
                version: version_output
                    .split_whitespace()
                    .find(|part| part.chars().next().is_some_and(|value| value.is_ascii_digit()))
                    .unwrap_or(&version_output)
                    .to_string(),
            });
        }
        unsupported.push(version_output);
    }
    if let Some(version) = unsupported.into_iter().find(|value| !value.is_empty()) {
        return Err(format!(
            "Codex CLI {version} is unsupported. Version 0.153.4 or newer is required."
        ));
    }
    Err("Codex CLI was not found. Install or update Codex Desktop, or add codex to PATH.".to_string())
}

fn codex_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("CODEX_SWITCHER_CODEX_BIN") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(PathBuf::from(if cfg!(windows) { "codex.exe" } else { "codex" }));

    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        let bin_root = local_app_data.join("OpenAI").join("Codex").join("bin");
        candidates.push(bin_root.join("codex.exe"));
        if let Ok(entries) = std::fs::read_dir(&bin_root) {
            let mut installed: Vec<_> = entries
                .flatten()
                .map(|entry| entry.path().join("codex.exe"))
                .filter(|path| path.is_file())
                .collect();
            installed.sort_by_key(|path| {
                std::fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            });
            installed.reverse();
            candidates.extend(installed);
        }
        let packages = local_app_data.join("Packages");
        if let Ok(entries) = std::fs::read_dir(packages) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with("openai.codex_")
                {
                    candidates.push(
                        entry
                            .path()
                            .join("LocalCache")
                            .join("Local")
                            .join("OpenAI")
                            .join("Codex")
                            .join("bin")
                            .join("codex.exe"),
                    );
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        for base in [PathBuf::from("/Applications"), home_applications_dir()] {
            candidates.push(base.join("Codex.app/Contents/Resources/codex"));
            candidates.push(base.join("ChatGPT.app/Contents/Resources/codex"));
        }
    }

    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

#[cfg(target_os = "macos")]
fn home_applications_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join("Applications")
}

fn parse_cli_version(output: &str) -> Option<(u32, u32, u32)> {
    let token = output
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|value| value.is_ascii_digit()))?;
    let mut parts = token.split('.');
    Some((
        numeric_prefix(parts.next()?)?,
        numeric_prefix(parts.next()?)?,
        numeric_prefix(parts.next()?)?,
    ))
}

fn numeric_prefix(value: &str) -> Option<u32> {
    let digits: String = value
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn is_supported_cli_version(output: &str) -> bool {
    parse_cli_version(output).is_some_and(|version| version >= MINIMUM_CODEX_VERSION)
}

fn is_method_unavailable(error: &str) -> bool {
    error.contains("-32601") || error.to_ascii_lowercase().contains("method not found")
}

async fn probe_project_management(session: &mut AppServerSession) -> Result<bool, String> {
    match session
        .request(
            "project/list",
            json!({ "limit": 1, "sortKey": "position", "sortDirection": "asc" }),
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(error) if is_method_unavailable(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preview: String,
    cwd: String,
    #[serde(default)]
    project_id: Option<String>,
    source: Value,
    status: RawThreadStatus,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    recency_at: Option<i64>,
    #[serde(default)]
    parent_thread_id: Option<String>,
}

impl RawThread {
    fn effective_parent_id(&self) -> Option<&str> {
        self.parent_thread_id.as_deref().or_else(|| {
            self.source
                .get("subAgent")?
                .get("thread_spawn")?
                .get("parent_thread_id")?
                .as_str()
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawThreadStatus {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, rename = "activeFlags")]
    active_flags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListResponse {
    data: Vec<RawThread>,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ThreadReadResponse {
    thread: RawThread,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProject {
    id: String,
    name: String,
    roots: Vec<RawProjectRoot>,
    #[serde(default)]
    recency_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawProjectRoot {
    path: String,
}

struct ProjectRootMatch {
    project_id: String,
    normalized_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListResponse {
    data: Vec<RawProject>,
    #[serde(default)]
    next_cursor: Option<String>,
}

async fn fetch_threads(
    session: &mut AppServerSession,
    archived: bool,
) -> Result<Vec<RawThread>, String> {
    let mut threads = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let response = session
            .request(
                "thread/list",
                json!({
                    "archived": archived,
                    "cursor": cursor,
                    "limit": SERVER_PAGE_SIZE,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": ALL_SOURCE_KINDS
                }),
            )
            .await?;
        let page: ThreadListResponse = serde_json::from_value(response)
            .map_err(|error| format!("Invalid thread/list response: {error}"))?;
        threads.extend(page.data);
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            return Err("Codex app server returned a repeated thread cursor".to_string());
        }
        cursor = Some(next_cursor);
    }
    Ok(threads)
}

async fn fetch_projects(session: &mut AppServerSession) -> Result<Vec<RawProject>, String> {
    let mut projects = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let response = session
            .request(
                "project/list",
                json!({
                    "cursor": cursor,
                    "limit": SERVER_PAGE_SIZE,
                    "sortKey": "position",
                    "sortDirection": "asc"
                }),
            )
            .await?;
        let page: ProjectListResponse = serde_json::from_value(response)
            .map_err(|error| format!("Invalid project/list response: {error}"))?;
        projects.extend(page.data);
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            return Err("Codex app server returned a repeated project cursor".to_string());
        }
        cursor = Some(next_cursor);
    }
    Ok(projects)
}

fn build_overview(
    capabilities: HistoryCapabilities,
    projects: Vec<RawProject>,
    active_threads: Vec<RawThread>,
    archived_threads: Vec<RawThread>,
    query: HistoryListQuery,
) -> Result<HistoryOverview, String> {
    let project_roots = build_project_root_matches(&projects);
    let all_threads: Vec<(&RawThread, bool)> = active_threads
        .iter()
        .map(|thread| (thread, false))
        .chain(archived_threads.iter().map(|thread| (thread, true)))
        .collect();
    let top_level_active = active_threads
        .iter()
        .filter(|thread| thread.effective_parent_id().is_none())
        .count();
    let top_level_archived = archived_threads
        .iter()
        .filter(|thread| thread.effective_parent_id().is_none())
        .count();
    let children = build_children_map(&all_threads);

    let project_summaries = projects
        .into_iter()
        .map(|project| HistoryProjectSummary {
            active_thread_count: active_threads
                .iter()
                .filter(|thread| {
                    thread.effective_parent_id().is_none()
                        && effective_project_id(thread, &project_roots)
                            == Some(project.id.as_str())
                })
                .count(),
            archived_thread_count: archived_threads
                .iter()
                .filter(|thread| {
                    thread.effective_parent_id().is_none()
                        && effective_project_id(thread, &project_roots)
                            == Some(project.id.as_str())
                })
                .count(),
            id: project.id,
            name: project.name,
            roots: project.roots.into_iter().map(|root| root.path).collect(),
            recency_at: project.recency_at,
        })
        .collect::<Vec<_>>();

    let search_term = query
        .search_term
        .as_deref()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase);
    let requested_threads = if query.archived {
        &archived_threads
    } else {
        &active_threads
    };
    let mut filtered: Vec<&RawThread> = requested_threads
        .iter()
        .filter(|thread| thread.effective_parent_id().is_none())
        .filter(|thread| {
            project_matches(
                effective_project_id(thread, &project_roots),
                &query.project_filter,
            )
        })
        .filter(|thread| {
            query
                .source_kind
                .as_deref()
                .is_none_or(|source| source_matches(&thread.source, source))
        })
        .filter(|thread| {
            query
                .status
                .as_deref()
                .is_none_or(|status| thread.status.kind == status)
        })
        .filter(|thread| {
            query
                .updated_after
                .is_none_or(|updated_after| thread.updated_at >= updated_after)
        })
        .filter(|thread| {
            search_term.as_ref().is_none_or(|term| {
                display_title(thread).to_lowercase().contains(term)
                    || thread.cwd.to_lowercase().contains(term)
            })
        })
        .collect();
    filtered.sort_by_key(|thread| std::cmp::Reverse(thread.recency_at.unwrap_or(thread.updated_at)));

    let offset = parse_page_cursor(query.cursor.as_deref())?;
    let page_size = query.limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let filtered_count = filtered.len();
    let page = filtered
        .into_iter()
        .skip(offset)
        .take(page_size)
        .map(|thread| HistoryThreadSummary {
            id: thread.id.clone(),
            title: display_title(thread),
            cwd: thread.cwd.clone(),
            project_id: effective_project_id(thread, &project_roots).map(str::to_string),
            source_kind: source_kind(&thread.source),
            status: thread.status.kind.clone(),
            active_flags: thread.status.active_flags.clone(),
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            recency_at: thread.recency_at.unwrap_or(thread.updated_at),
            archived: query.archived,
            descendant_count: descendant_count(&thread.id, &children),
            can_mutate: thread.status.kind != "active",
        })
        .collect::<Vec<_>>();
    let next_offset = offset.saturating_add(page.len());
    let next_cursor = (next_offset < filtered_count).then(|| next_offset.to_string());

    Ok(HistoryOverview {
        capabilities,
        totals: HistoryTotals {
            projects: project_summaries.len(),
            active_threads: top_level_active,
            archived_threads: top_level_archived,
        },
        projects: project_summaries,
        threads: page,
        filtered_count,
        next_cursor,
    })
}

fn parse_page_cursor(cursor: Option<&str>) -> Result<usize, String> {
    cursor
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "Invalid history page cursor".to_string())
}

fn build_project_root_matches(projects: &[RawProject]) -> Vec<ProjectRootMatch> {
    projects
        .iter()
        .flat_map(|project| {
            project.roots.iter().filter_map(|root| {
                let normalized_root = normalize_history_path(&root.path);
                (!normalized_root.is_empty()).then(|| ProjectRootMatch {
                    project_id: project.id.clone(),
                    normalized_root,
                })
            })
        })
        .collect()
}

fn effective_project_id<'a>(
    thread: &'a RawThread,
    roots: &'a [ProjectRootMatch],
) -> Option<&'a str> {
    if let Some(project_id) = thread.project_id.as_deref() {
        return Some(project_id);
    }

    let cwd = normalize_history_path(&thread.cwd);
    roots
        .iter()
        .filter(|root| history_path_is_within(&cwd, &root.normalized_root))
        .max_by_key(|root| root.normalized_root.len())
        .map(|root| root.project_id.as_str())
}

fn normalize_history_path(path: &str) -> String {
    let replaced = path.trim().replace('\\', "/");
    let prefix = if replaced.starts_with("//") {
        "//"
    } else if replaced.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut components = Vec::new();
    for component in replaced.split('/') {
        match component {
            "" | "." => {}
            ".." if components.last().is_some_and(|value| *value != "..") => {
                components.pop();
            }
            ".." if prefix.is_empty() => components.push(component),
            ".." => {}
            _ => components.push(component),
        }
    }
    let mut normalized = format!("{prefix}{}", components.join("/"));
    if cfg!(windows) {
        normalized = normalized.to_lowercase();
    }
    normalized
}

fn history_path_is_within(path: &str, root: &str) -> bool {
    path == root
        || (path.starts_with(root)
            && path
                .as_bytes()
                .get(root.len())
                .is_some_and(|value| *value == b'/'))
}

fn project_matches(effective_project_id: Option<&str>, filter: &HistoryProjectFilter) -> bool {
    match filter {
        HistoryProjectFilter::All => true,
        HistoryProjectFilter::Unassigned => effective_project_id.is_none(),
        HistoryProjectFilter::Project { project_id } => {
            effective_project_id == Some(project_id.as_str())
        }
    }
}

fn source_kind(source: &Value) -> String {
    if let Some(source) = source.as_str() {
        return source.to_string();
    }
    if let Some(sub_agent) = source.get("subAgent") {
        if let Some(kind) = sub_agent.as_str() {
            return match kind {
                "review" => "subAgentReview",
                "compact" => "subAgentCompact",
                _ => "subAgentOther",
            }
            .to_string();
        }
        if sub_agent.get("thread_spawn").is_some() {
            return "subAgentThreadSpawn".to_string();
        }
        return "subAgentOther".to_string();
    }
    if source.get("custom").is_some() {
        return "custom".to_string();
    }
    "unknown".to_string()
}

fn source_matches(source: &Value, requested: &str) -> bool {
    let actual = source_kind(source);
    if requested == "subAgent" {
        actual.starts_with("subAgent")
    } else {
        actual == requested
    }
}

fn display_title(thread: &RawThread) -> String {
    let value = thread
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| thread.preview.lines().find(|line| !line.trim().is_empty()))
        .unwrap_or("Untitled session")
        .trim();
    truncate_chars(value, 96)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn build_children_map(threads: &[(&RawThread, bool)]) -> HashMap<String, Vec<String>> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (thread, _) in threads {
        if let Some(parent) = thread.effective_parent_id() {
            children
                .entry(parent.to_string())
                .or_default()
                .push(thread.id.clone());
        }
    }
    children
}

fn descendant_count(thread_id: &str, children: &HashMap<String, Vec<String>>) -> usize {
    let mut found = HashSet::new();
    let mut queue: VecDeque<&str> = children
        .get(thread_id)
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect();
    while let Some(id) = queue.pop_front() {
        if !found.insert(id) {
            continue;
        }
        if let Some(descendants) = children.get(id) {
            queue.extend(descendants.iter().map(String::as_str));
        }
    }
    found.len()
}

fn has_selected_ancestor(
    thread_id: &str,
    selected: &HashSet<String>,
    parents: &HashMap<String, Option<String>>,
) -> bool {
    let mut seen = HashSet::new();
    let mut current = parents.get(thread_id).and_then(|parent| parent.as_deref());
    while let Some(parent) = current {
        if !seen.insert(parent) {
            break;
        }
        if selected.contains(parent) {
            return true;
        }
        current = parents.get(parent).and_then(|value| value.as_deref());
    }
    false
}

fn ancestor_depth(
    thread_id: &str,
    parents: &HashMap<String, Option<String>>,
) -> usize {
    let mut seen = HashSet::new();
    let mut depth = 0;
    let mut current = parents.get(thread_id).and_then(|parent| parent.as_deref());
    while let Some(parent) = current {
        if !seen.insert(parent) {
            break;
        }
        depth += 1;
        current = parents.get(parent).and_then(|value| value.as_deref());
    }
    depth
}

async fn execute_session_mutation(
    session: &mut AppServerSession,
    server_pid: u32,
    action: &SessionMutationAction,
) -> Result<(), String> {
    let thread_id = action.thread_id();
    let response = session
        .request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": false }),
        )
        .await?;
    let current: ThreadReadResponse = serde_json::from_value(response)
        .map_err(|error| format!("Invalid thread/read response: {error}"))?;
    if current.thread.status.kind == "active" {
        return Err("This session is active and cannot be changed until it becomes idle.".to_string());
    }
    crate::commands::process::ensure_codex_not_running_for_history_except(Some(server_pid))?;

    match action {
        SessionMutationAction::Rename { name, .. } => {
            let name = name.trim();
            if name.is_empty() {
                return Err("Session name cannot be empty.".to_string());
            }
            if name.chars().count() > 120 {
                return Err("Session name cannot exceed 120 characters.".to_string());
            }
            session
                .request(
                    "thread/name/set",
                    json!({ "threadId": thread_id, "name": name }),
                )
                .await?;
        }
        SessionMutationAction::Archive { .. } => {
            session
                .request("thread/archive", json!({ "threadId": thread_id }))
                .await?;
        }
        SessionMutationAction::Unarchive { .. } => {
            session
                .request("thread/unarchive", json!({ "threadId": thread_id }))
                .await?;
        }
        SessionMutationAction::Delete { .. } => {
            session
                .request("thread/delete", json!({ "threadId": thread_id }))
                .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ancestor_depth, build_overview, has_selected_ancestor, is_supported_cli_version,
        matching_response, parse_cli_version, source_kind, source_matches, HistoryCapabilities,
        HistoryListQuery, HistoryProjectFilter, RawProject, RawProjectRoot, RawThread,
        RawThreadStatus,
    };
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn codex_version_gate_accepts_the_supported_baseline() {
        assert_eq!(parse_cli_version("codex-cli 0.153.4\n"), Some((0, 153, 4)));
        assert!(is_supported_cli_version("codex-cli 0.153.4"));
        assert!(is_supported_cli_version("codex-cli 1.0.0-beta.2"));
        assert!(!is_supported_cli_version("codex-cli 0.153.3"));
        assert!(!is_supported_cli_version("unexpected output"));
    }

    #[test]
    fn response_matching_ignores_notifications_and_other_request_ids() {
        assert_eq!(
            matching_response(r#"{"method":"thread/started","params":{}}"#, 7).unwrap(),
            None
        );
        assert_eq!(
            matching_response(r#"{"id":6,"result":{"ignored":true}}"#, 7).unwrap(),
            None
        );
        assert_eq!(
            matching_response(r#"{"id":7,"result":{"data":[]}}"#, 7).unwrap(),
            Some(json!({"data": []}))
        );
    }

    #[test]
    fn response_matching_surfaces_protocol_errors() {
        let error = matching_response(
            r#"{"id":9,"error":{"code":-32601,"message":"Method not found"}}"#,
            9,
        )
        .unwrap_err();
        assert!(error.contains("Method not found"));
        assert!(error.contains("-32601"));
    }

    #[test]
    fn subagent_sources_keep_their_effective_kind() {
        assert_eq!(
            source_kind(&json!({"subAgent": "review"})),
            "subAgentReview"
        );
        assert_eq!(
            source_kind(&json!({"subAgent": {"thread_spawn": {
                "parent_thread_id": "parent",
                "depth": 1,
                "agent_path": null,
                "agent_nickname": null,
                "agent_role": null
            }}})),
            "subAgentThreadSpawn"
        );
        assert!(source_matches(&json!({"subAgent": "review"}), "subAgent"));
        assert!(source_matches(
            &json!({"subAgent": "review"}),
            "subAgentReview"
        ));
        assert!(!source_matches(&json!({"subAgent": "review"}), "cli"));
        assert!(source_matches(&json!({"custom": "automation"}), "custom"));
    }

    fn thread(
        id: &str,
        name: &str,
        project_id: Option<&str>,
        parent: Option<&str>,
        updated_at: i64,
    ) -> RawThread {
        RawThread {
            id: id.into(),
            name: Some(name.into()),
            preview: String::new(),
            cwd: format!("C:/work/{id}"),
            project_id: project_id.map(str::to_string),
            source: json!("appServer"),
            status: RawThreadStatus {
                kind: "idle".into(),
                active_flags: Vec::new(),
            },
            created_at: updated_at - 10,
            updated_at,
            recency_at: Some(updated_at),
            parent_thread_id: parent.map(str::to_string),
        }
    }

    #[test]
    fn overview_filters_top_level_threads_and_counts_descendants() {
        let capabilities = HistoryCapabilities {
            available: true,
            cli_version: "0.153.4".into(),
            cli_path: "codex".into(),
            codex_home: "C:/codex".into(),
            project_management: true,
            minimum_cli_version: "0.153.4".into(),
        };
        let projects = vec![RawProject {
            id: "project-a".into(),
            name: "Alpha".into(),
            roots: vec![RawProjectRoot {
                path: "C:/work".into(),
            }],
            recency_at: Some(30),
        }];
        let mut child = thread("child", "Child task", Some("project-a"), None, 25);
        child.source = json!({
            "subAgent": {
                "thread_spawn": {
                    "parent_thread_id": "parent",
                    "depth": 1,
                    "agent_path": null,
                    "agent_nickname": null,
                    "agent_role": null
                }
            }
        });
        let mut other = thread("other", "Other task", None, None, 20);
        other.cwd = "C:/notes".into();
        let active = vec![
            thread("parent", "Parent task", Some("project-a"), None, 30),
            child,
            other,
        ];
        let archived = vec![thread("old", "Old task", Some("project-a"), None, 10)];
        let query = HistoryListQuery {
            project_filter: HistoryProjectFilter::Project {
                project_id: "project-a".into(),
            },
            limit: Some(1),
            ..HistoryListQuery::default()
        };

        let overview = build_overview(capabilities, projects, active, archived, query).unwrap();

        assert_eq!(overview.totals.active_threads, 2);
        assert_eq!(overview.totals.archived_threads, 1);
        assert_eq!(overview.filtered_count, 1);
        assert_eq!(overview.threads[0].id, "parent");
        assert_eq!(overview.threads[0].descendant_count, 1);
        assert_eq!(overview.projects[0].active_thread_count, 1);
        assert_eq!(overview.projects[0].archived_thread_count, 1);
        assert_eq!(overview.next_cursor, None);
    }

    #[test]
    fn overview_infers_project_from_the_most_specific_root_when_project_id_is_missing() {
        let capabilities = HistoryCapabilities {
            available: true,
            cli_version: "0.153.4".into(),
            cli_path: "codex".into(),
            codex_home: "C:/codex".into(),
            project_management: true,
            minimum_cli_version: "0.153.4".into(),
        };
        let projects = vec![
            RawProject {
                id: "games".into(),
                name: "Games".into(),
                roots: vec![RawProjectRoot {
                    path: "E:/work/games".into(),
                }],
                recency_at: Some(20),
            },
            RawProject {
                id: "unity".into(),
                name: "Unity".into(),
                roots: vec![RawProjectRoot {
                    path: "E:\\work\\games\\unity".into(),
                }],
                recency_at: Some(30),
            },
        ];
        let mut unity_thread = thread("unity-thread", "Unity task", None, None, 30);
        unity_thread.cwd = "E:/work/games/unity/client".into();
        let query = HistoryListQuery {
            project_filter: HistoryProjectFilter::Project {
                project_id: "unity".into(),
            },
            ..HistoryListQuery::default()
        };

        let overview = build_overview(
            capabilities,
            projects,
            vec![unity_thread],
            Vec::new(),
            query,
        )
        .unwrap();

        assert_eq!(overview.filtered_count, 1);
        assert_eq!(overview.threads[0].project_id.as_deref(), Some("unity"));
        assert_eq!(overview.projects[0].active_thread_count, 0);
        assert_eq!(overview.projects[1].active_thread_count, 1);
    }

    #[test]
    fn batch_collapse_detects_a_selected_ancestor() {
        let parents = HashMap::from([
            ("parent".to_string(), None),
            ("child".to_string(), Some("parent".to_string())),
            ("grandchild".to_string(), Some("child".to_string())),
        ]);
        let selected = HashSet::from(["parent".to_string()]);
        assert!(has_selected_ancestor("grandchild", &selected, &parents));
        assert!(!has_selected_ancestor("parent", &selected, &parents));
        assert_eq!(ancestor_depth("grandchild", &parents), 2);

        let no_successes = HashSet::new();
        assert!(!has_selected_ancestor("grandchild", &no_successes, &parents));
    }
}
