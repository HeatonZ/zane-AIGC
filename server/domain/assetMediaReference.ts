import { HttpError } from "../errors.js";
import type { AssetReference } from "./productionContracts.js";

/** A preview URL is not an execution credential. Only local authoritative media
 * routes are aliases for fixed asset references; external URLs remain external. */
export function assetReferenceFromMediaUrl(value: unknown, workbenchBaseUrl?: string): AssetReference | undefined {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const source = typeof value === "string" ? value.trim()
    : typeof record?.url === "string" && record.url.trim() ? record.url.trim()
      : typeof record?.path === "string" ? record.path.trim() : "";
  if (!source) return undefined;
  const relative = source.startsWith("/api/v1/assets/");
  if (!relative && (!/^https?:\/\//i.test(source) || !workbenchBaseUrl)) return undefined;
  const origin = (url: URL) => {
    const canonical = new URL(url.origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(canonical.hostname)) canonical.hostname = "127.0.0.1";
    return canonical.origin;
  };
  let url: URL;
  try {
    url = new URL(source, workbenchBaseUrl ?? "http://workbench.invalid");
    if (!relative && origin(url) !== origin(new URL(workbenchBaseUrl!))) return undefined;
  } catch { return undefined; }
  if (!url.pathname.startsWith("/api/v1/assets/")) return undefined;
  const invalid = () => new HttpError(400, "工作台素材媒体地址必须指定有效素材ID和固定正整数版本", "INVALID_ASSET_REFERENCE");
  if (url.username || url.password) throw invalid();
  const match = /^\/api\/v1\/assets\/([^/]+)\/versions\/([1-9]\d*)\/media$/.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw invalid();
  let assetId: string;
  try { assetId = decodeURIComponent(match[1]); } catch { throw invalid(); }
  if (!assetId.trim() || /[\/\\]/.test(assetId)) throw invalid();
  return { assetId, assetVersion: Number(match[2]) };
}

/** Shared discovery/response metadata; not a public media or signing capability. */
export const ASSET_MEDIA_EXECUTION_CONTRACT = {
  schemaVersion: 1,
  preferredInput: { required: ["assetId", "assetVersion"], assetVersion: "fixed_positive_integer" },
  execution: "authorized_submission_to_asset_service_to_private_run_copy_to_executor_upload",
  imageConsumers: {
    source: "same_authorized_fixed_version_private_run_copy",
    hermes: "private_image_bytes_to_inline_data_url",
    comfyui: "private_image_bytes_to_upload_in_reference_order",
    hermesSizePolicy: "existing_inline_budget_may_resize_without_reselecting_asset_version",
  },
  previewUrl: "authenticated_display_endpoint_not_execution_credential",
  adminUrlCompatibility: "relative_or_current_backend_origin_fixed_asset_media_route",
  loopbackAliases: ["localhost", "127.0.0.1", "[::1]"],
  userInput: "owned_fixed_asset_reference_only",
  externalUrlPolicy: "external_source_no_workbench_credentials_forwarded",
  forwardsWorkbenchCredentials: false,
  preflightExternalCalls: false,
  preflightErrors: ["INVALID_ASSET_REFERENCE", "ASSET_FILE_MISSING"],
  recovery: "retain_original_run_and_asset_version_explicit_resume_with_pre_saved_new_run_id",
} as const;
