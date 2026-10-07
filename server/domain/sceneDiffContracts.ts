/** Read-only draft/publication comparison. Paths use stable IDs/keys, not array indices. */
export type SceneDiffSection = "scene" | "workflow" | "inputs" | "steps" | "outputs" | "optionPresets";
export type SceneDiffKind = "added" | "removed" | "changed" | "reordered";
export interface SceneDiffValue {
  present: boolean;
  format: "text" | "json";
  text: string;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
  complete: boolean;
}
export interface SceneDiffChange {
  changeId: string;
  path: string;
  section: SceneDiffSection;
  objectId: string | null;
  objectLabel: string;
  label: string;
  kind: SceneDiffKind;
  before: SceneDiffValue;
  after: SceneDiffValue;
}
export interface SceneDiffPage {
  sceneId: string;
  revision: string;
  draftRevision: string;
  contentHash: string;
  baseline: { versionId: string; version: string; publishedAt: string } | null;
  comparisonBasis: "publication-ready";
  preparationWarnings: Array<{ stepId: string; message: string }>;
  hasChanges: boolean;
  summary: Record<SceneDiffKind, number>;
  total: number;
  valueBudgetChars: 65536;
  changes: SceneDiffChange[];
  hasMore: boolean;
  nextCursor: string | null;
  nextAction: "read_more_changes" | "validate_scene_draft" | "get_scene";
}
export interface SceneDiffValuePage {
  sceneId: string;
  revision: string;
  changeId: string;
  side: "before" | "after";
  value: SceneDiffValue;
  nextAction: "read_more_value" | "get_scene_draft_diff";
}
