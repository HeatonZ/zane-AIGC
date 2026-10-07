import { AccessApiError } from "./accessApi";

export class DraftFavoriteUnconfirmedError extends Error {
  constructor() { super("收藏回执和服务端对账均未取得，请先读取原草稿ID对账，不要重复提交。"); }
}

/** Exactly one write attempt. An uncertain receipt/stale revision is reconciled by reading the same object. */
export async function writeDraftFavorite<T>(options: {
  isFavorite: boolean; write: () => Promise<T>; read: () => Promise<T>; favorite: (snapshot: T) => boolean;
}): Promise<{ snapshot: T; outcome: "saved" | "reconciled" | "not_saved"; error?: Error }> {
  try { return { snapshot: await options.write(), outcome: "saved" }; }
  catch (error) {
    if (!(error instanceof AccessApiError)) throw error;
    const uncertain = error.status === 0 || error.status >= 500;
    if (!uncertain && error.status !== 409) throw error;
    let snapshot: T;
    try { snapshot = await options.read(); }
    catch { if (uncertain) throw new DraftFavoriteUnconfirmedError(); throw error; }
    return {
      snapshot,
      outcome: uncertain && options.favorite(snapshot) === options.isFavorite ? "reconciled" : "not_saved",
      ...(error.status === 409 || options.favorite(snapshot) !== options.isFavorite ? { error } : {}),
    };
  }
}
