import type { WorkflowDraft } from "../types";

const storageKey = "zane-studio:drafts:v1";

export function readDrafts(): WorkflowDraft[] {
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved ? (JSON.parse(saved) as WorkflowDraft[]) : [];
  } catch {
    return [];
  }
}

export function writeDrafts(drafts: WorkflowDraft[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(drafts));
}
