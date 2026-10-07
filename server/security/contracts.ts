export const PUBLIC_ENTRY_CONTRACT = {
  version: "1.0.0",
  entryMode: "user-only",
  allowedRole: "user",
  administratorCredentials: "rejected",
  setup: "unavailable",
  operations: "authenticated_operations_only",
  media: "existing_owner_and_scene_authorization_including_head_range",
  errors: "redacted_with_stable_code_and_request_id",
  businessState: "shared_authoritative_services_and_sqlite",
} as const;

export const HTTP_SECURITY_CONTRACT = {
  version: "1.0.0",
  publicEntry: PUBLIC_ENTRY_CONTRACT,
  configuration: {
    channel: "server_environment_restart_required_no_ai_write_proxy",
    ZANE_PUBLIC_USER_PORT: { type: "integer", minimum: 0, maximum: 65535, default: null, description: "留空不开启；0仅隔离测试使用；不得与非零API_PORT相同" },
    ZANE_PUBLIC_USER_HOST: { type: "string", default: "127.0.0.1", description: "用户入口回源监听；开启时API_HOST必须回环，只能公开用户端口" },
    ZANE_LOGIN_WINDOW_SECONDS: { type: "integer", minimum: 1, maximum: 86400, default: 900 },
    ZANE_LOGIN_ACCOUNT_ATTEMPTS: { type: "integer", minimum: 1, maximum: 1000, default: 8 },
    ZANE_LOGIN_SOURCE_ATTEMPTS: { type: "integer", minimum: 1, maximum: 10000, default: 30 },
    ZANE_LOGIN_MAX_CONCURRENT: { type: "integer", minimum: 1, maximum: 64, default: 4 },
  },
  login: { counted: "all_attempts", keyScopes: "private_and_public_user_separate", accountCase: "lowercase", source: "verified_request_ip_not_client_forwarded_header", concurrentScope: "shared_process", storage: "bounded_process_local_counters", restart: "counters_reset", retry: "429_LOGIN_RATE_LIMITED_Retry_After_seconds_no_automatic_replay" },
  error: { fields: ["error", "code", "requestId", "details"], unknownProductionOrPublic: "generic_no_raw_exception", domain: "preserve_4xx_code_revision_and_redact_sensitive_text_details", retry: "Retry-After_header_and_details.retryAfterSeconds", lostMutationResponse: "read_same_id_do_not_replay" },
  discovery: "auth_status_and_get_workbench_report_entry_mode_and_login_policy_public_openapi_and_guide_user_only",
  deferred: ["trusted_proxy_https_configuration", "resource_quotas", "upload_hardening", "agent_execution_isolation"],
} as const;
