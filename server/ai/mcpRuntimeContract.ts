/** Transport lifecycle errors, shared by the stable MCP relay and the machine
 * contract. They are not HTTP business errors and never authorize re-execution. */
export const MCP_RESTARTING = { jsonRpcCode: -32603, code: "MCP_RESTARTING", outcome: "rejected" as const, recovery: "wait_then_reconcile_original_id" };
export const MCP_RESPONSE_UNCONFIRMED = { jsonRpcCode: -32603, code: "MCP_RESPONSE_UNCONFIRMED", recovery: "reconcile_original_id_before_retry" };
export const AI_MCP_TRANSPORT_CONTRACT = {
  schemaVersion: 1,
  transport: "stdio",
  lifecycle: "stable_connection_replaceable_http_adapter",
  restartTrigger: "successful_production_backend_ready_generation",
  inFlightPolicy: "drain_before_planned_replacement",
  mutationReplay: false,
  firstUpgrade: "one_time_client_reload_for_legacy_unsupervised_processes",
  errors: [
    { ...MCP_RESTARTING, outcomes: ["rejected"], sentToBackend: false },
    { ...MCP_RESPONSE_UNCONFIRMED, outcomes: ["unknown", "read_failed"], outcomeRule: "tools/call is conservatively unknown; discovery is read_failed" },
  ],
} as const;
