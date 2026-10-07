import { compareDrafts } from "../../server/domain/draftFavorites";
import type { WorkflowDraft } from "../types";

/** Sorting is a pure projection of server-owned task drafts, not browser persistence. */
export function sortWorkflowDrafts(drafts: WorkflowDraft[]): WorkflowDraft[] {
  return [...drafts].sort(compareDrafts);
}

/** Reorder only confirmed, loaded server snapshots; never invent or restore missing drafts. */
export function sortOwnDrafts<T extends { id: string; updatedAt: string; isFavorite?: boolean }>(drafts: readonly T[]): T[] {
  return [...drafts].sort((left, right) => compareDrafts(left, right, "updatedAt"));
}
