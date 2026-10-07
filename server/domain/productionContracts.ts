export type AssetKind = "image" | "video" | "audio";
export type AssetCategory = "character" | "scene" | "prop" | "voice" | "material";
export interface AssetSource { runId: string; stepId?: string; itemIndex?: number; outputKey: string; mediaIndex: number }
export interface AssetVersion { version: number; createdAt: string; sha256: string; bytes: number; filename: string; originalName: string; source?: AssetSource; parameters?: Record<string, unknown> }
export interface AssetRecord { ownerUserId?: string; id: string; revision: number; name: string; category: AssetCategory; kind: AssetKind; description?: string; group: string; tags: string[]; createdAt: string; updatedAt: string; archivedAt?: string; currentVersion: number; versions: AssetVersion[] }
export interface AssetReference { assetId: string; assetVersion: number; previewUrl?: string; assetName?: string }
export interface PendingReview { id: string; stepId: string; name: string; createdAt: string; instruction?: string }
export interface ReviewDecision { reviewId: string; stepId: string; action: "approve" | "redo"; at: string; feedback?: string; feedbackId?: string; originalOutputs?: Record<string, unknown>; editedOutputs?: Record<string, unknown> }
export interface ClipChoice { shotId: string; source: AssetSource; assetId?: string; assetVersion?: number }
export interface ClipSelection { id: string; revision: number; name: string; sourceRunId: string; sceneId: string; generationStepId: string; outputKey: string; createdAt: string; updatedAt: string; shots: Array<{ shotId: string; index: number; value: unknown; choice?: ClipChoice }>; lastRunId?: string }

export interface ClipCandidate { source: AssetSource; previewUrl: string; runTitle: string; createdAt: string }
