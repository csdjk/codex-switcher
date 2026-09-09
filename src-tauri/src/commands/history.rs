use crate::history::{
    self, HistoryCapabilities, HistoryListQuery, HistoryOverview, ProjectMutationAction,
    ProjectMutationResult, SessionMutationAction, SessionMutationSummary,
};

#[tauri::command]
pub async fn get_history_capabilities() -> Result<HistoryCapabilities, String> {
    history::get_history_capabilities().await
}

#[tauri::command]
pub async fn list_history_overview(query: HistoryListQuery) -> Result<HistoryOverview, String> {
    history::list_history_overview(query).await
}

#[tauri::command]
pub async fn mutate_sessions(
    actions: Vec<SessionMutationAction>,
) -> Result<SessionMutationSummary, String> {
    history::mutate_sessions(actions).await
}

#[tauri::command]
pub async fn mutate_project(
    action: ProjectMutationAction,
) -> Result<ProjectMutationResult, String> {
    history::mutate_project(action).await
}
