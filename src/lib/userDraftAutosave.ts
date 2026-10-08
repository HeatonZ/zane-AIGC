export interface OwnDraftSaveSession {
  id: string;
  revision: number;
  sceneId: string;
  versionId: string;
  title: string;
  hasServerDraft: boolean;
  editVersion: number;
  savedEditVersion: number;
  enqueuedEditVersion: number;
  reconcileRequired: boolean;
  reviewRequired: boolean;
  failedWrite?: { editVersion: number; inputValues: Record<string, unknown> };
  lastSaved?: { editVersion: number; inputValues: Record<string, unknown> };
  pendingWrite?: Promise<{ id: string; revision: number; inputValues: Record<string, unknown> }>;
}

export interface OwnDraftSaveRequest {
  draftId: string;
  revision: number;
  sceneId: string;
  versionId: string;
  title: string;
  inputValues: Record<string, unknown>;
}

export interface OwnDraftSaveResponse {
  draft: { id: string; revision: number; inputValues: Record<string, unknown> };
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function draftSaveNeedsReconciliation(error: unknown): boolean {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && (status === 0 || status === 409 || status >= 500);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function sameDraftInputs(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export class OwnDraftSaveQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly write: (request: OwnDraftSaveRequest) => Promise<OwnDraftSaveResponse>) {}

  save(session: OwnDraftSaveSession, inputValues: Record<string, unknown>, editVersion: number): Promise<OwnDraftSaveResponse["draft"]> {
    if (session.reconcileRequired) return Promise.reject(new Error("草稿写入回执待核对，请先读取原草稿ID。"));
    const snapshot = copyJson(inputValues);
    session.enqueuedEditVersion = Math.max(session.enqueuedEditVersion, editVersion);
    const request = this.tail.then(async () => {
      if (session.reconcileRequired) throw new Error("草稿写入回执待核对，请先读取原草稿ID。");
      const result = await this.write({
        draftId: session.id,
        revision: session.revision,
        sceneId: session.sceneId,
        versionId: session.versionId,
        title: session.title,
        inputValues: snapshot,
      });
      session.revision = result.draft.revision;
      session.hasServerDraft = true;
      session.savedEditVersion = Math.max(session.savedEditVersion, editVersion);
      session.lastSaved = { editVersion, inputValues: snapshot };
      return result.draft;
    }).catch(error => {
      if (!session.reconcileRequired && draftSaveNeedsReconciliation(error)) {
        session.reconcileRequired = true;
        session.failedWrite = { editVersion, inputValues: snapshot };
      }
      throw error;
    });
    session.pendingWrite = request;
    this.tail = request.then(() => undefined, () => undefined);
    void request.then(
      () => { if (session.pendingWrite === request) session.pendingWrite = undefined; },
      () => { if (session.pendingWrite === request) session.pendingWrite = undefined; },
    );
    return request;
  }
}
