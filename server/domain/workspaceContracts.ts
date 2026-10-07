/** Read-only metadata from the same SQLite authority used by UI, HTTP and MCP. */
export interface WorkspaceStatus {
  authority: "sqlite";
  initialized: boolean;
  workspaceRevision: number | null;
  catalogView: "draft";
  executionView: "published";
}
