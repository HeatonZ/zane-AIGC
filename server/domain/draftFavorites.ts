/** Shared, deterministic ordering of server-owned task/input drafts. Legacy drafts are not favorites. */
export function compareDrafts(left: { id?: unknown; isFavorite?: unknown; createdAt?: unknown; updatedAt?: unknown }, right: { id?: unknown; isFavorite?: unknown; createdAt?: unknown; updatedAt?: unknown }, timeKey: "createdAt" | "updatedAt" = "createdAt") {
  return Number(right.isFavorite === true) - Number(left.isFavorite === true)
    || String(right[timeKey] ?? "").localeCompare(String(left[timeKey] ?? ""))
    || String(left.id ?? "").localeCompare(String(right.id ?? ""));
}
