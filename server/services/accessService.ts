import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RequestHandler } from "express";
import type { SqliteStore } from "../storage/sqliteStore.js";
import { HttpError } from "../errors.js";
import type { WorkspaceService } from "./workspaceService.js";
import type { RunSubmitter } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";

import { LoginLimiter } from "../security/loginLimiter.js";
import { PUBLIC_ENTRY_CONTRACT } from "../security/contracts.js";

const scrypt = promisify(scryptCallback);
const SYSTEM = "@zane-system";
export interface UserAccount { id: string; revision: number; username: string; displayName: string; role: "admin" | "user"; enabled: boolean; sceneIds: string[]; createdAt: string; updatedAt: string }
interface StoredUser extends UserAccount { passwordHash: string; authVersion: number }
export interface Identity extends UserAccount { authVersion?: number; credentialId?: string }
interface Credential { id: string; revision: number; userId: string; authVersion: number; hash: string; name: string; kind: "session" | "api"; revoked: boolean; createdAt: string; expiresAt: string }
export function publicUser(user: StoredUser | Identity): UserAccount {
  const { id, revision, username, displayName, role, enabled, sceneIds, createdAt, updatedAt } = user;
  return { id, revision, username, displayName, role, enabled, sceneIds, createdAt, updatedAt };
}
export function runSubmitter(user: Pick<UserAccount, "id" | "username" | "displayName">): RunSubmitter {
  return { userId: user.id, username: user.username, displayName: user.displayName };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function passwordHash(password: string) { const salt = randomBytes(16).toString("hex"); return salt + ":" + (await scrypt(password, salt, 64) as Buffer).toString("hex"); }
async function passwordMatches(password: string, stored: string) { const [salt, encoded] = stored.split(":"); const value = await scrypt(password, salt, 64) as Buffer; const expected = Buffer.from(encoded, "hex"); return expected.length === value.length && timingSafeEqual(expected, value); }
export function accessPagination<T extends { id: string; revision: number }>(all: T[], query: { limit?: number; cursor?: string }, scope: string, context: unknown = null) {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "分页条数无效", "INVALID_ACCESS_REQUEST");
  const revision = hash(JSON.stringify([context,all])); let offset = 0;
  if (query.cursor) {
    let page: Record<string, unknown> | undefined;
    try { page = asRecord(JSON.parse(Buffer.from(query.cursor, "base64url").toString())); } catch { /* validated below */ }
    if (!page || page.scope !== scope || !Number.isSafeInteger(page.offset) || Number(page.offset) <= 0) throw new HttpError(400, "分页游标无效", "INVALID_ACCESS_CURSOR");
    if (page.revision !== revision) throw new HttpError(409, "列表已变化，请重新读取第一页", "ACCESS_PAGE_CHANGED");
    offset = Number(page.offset);
    if (offset >= all.length) throw new HttpError(400, "分页游标超出范围", "INVALID_ACCESS_CURSOR");
  }
  const items = all.slice(offset, offset + limit); const hasMore = offset + items.length < all.length;
  return { revision, total: all.length, items, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ scope, revision, offset: offset + items.length })).toString("base64url") } : {}) };
}
export class AccessService {
  constructor(readonly store: SqliteStore, readonly workspace: WorkspaceService, readonly operatorToken = process.env.ZANE_ADMIN_TOKEN ?? "", readonly loginLimiter = new LoginLimiter()) {
    if (operatorToken && operatorToken.length < 32) throw new Error("ZANE_ADMIN_TOKEN 至少32个字符，不能使用默认或短凭证");
  }
  private users() { return this.store.listDocuments<StoredUser>(SYSTEM, "users"); }
  initialized() { return this.users().some(user => user.role === "admin" && user.enabled); }
  private raw(id: string) { const user = this.store.getDocument<StoredUser>(SYSTEM, "users", id); if (!user) throw new HttpError(404, "用户不存在", "USER_NOT_FOUND"); return user; }
  get(id: string) { return publicUser(this.raw(id)); }
  /** Resolve a historical run owner without turning a missing account into a list failure. */
  find(id: string) { const user = this.store.getDocument<StoredUser>(SYSTEM, "users", id); return user ? publicUser(user) : undefined; }
  list(query: { limit?: number; cursor?: string }) { return accessPagination(this.users().map(publicUser).sort((a,b) => a.username.localeCompare(b.username)), query, "users"); }
  async create(input: { userId: string; username: string; displayName: string; password: string; role: "admin" | "user" }, setup = false, authorize?: () => void) {
    const encoded = await passwordHash(input.password); const now = new Date().toISOString();
    const saved = this.store.putDocumentChecked<StoredUser>(SYSTEM, "users", { id: input.userId, revision: 0, username: input.username.toLowerCase(), displayName: input.displayName, passwordHash: encoded, authVersion: 1, role: setup ? "admin" : input.role, enabled: true, sceneIds: [], createdAt: now, updatedAt: now }, 0, () => {
      authorize?.();
      if (setup && this.initialized()) throw new HttpError(409, "管理员已经初始化，请登录", "ADMIN_ALREADY_INITIALIZED");
      if (this.users().some(user => user.id === input.userId || user.username === input.username.toLowerCase())) throw new HttpError(409, "用户ID或登录名已存在；请读取原ID对账", "USER_ALREADY_EXISTS");
    });
    return { user: publicUser(saved), nextAction: "set_user_scene_access" };
  }
  private replace(id: string, revision: number, transform: (current: StoredUser) => StoredUser) {
    try {
      const current = this.raw(id); const next = transform(current);
      return publicUser(this.store.putDocumentChecked(SYSTEM, "users", next, revision, () => {
        if (current.role === "admin" && current.enabled && (next.role !== "admin" || !next.enabled) && this.users().filter(user => user.role === "admin" && user.enabled).length <= 1) throw new HttpError(409, "不能停用或降级最后一个管理员", "LAST_ADMIN_REQUIRED");
      }));
    } catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "用户或授权已变化，请重新读取", "USER_REVISION_CONFLICT"); throw error; }
  }
  update(input: { userId: string; revision: number; displayName?: string; role?: "admin" | "user"; enabled?: boolean }) {
    return { user: this.replace(input.userId, input.revision, current => ({ ...current, ...(input.displayName === undefined ? {} : { displayName: input.displayName }), ...(input.role === undefined ? {} : { role: input.role }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }), authVersion: current.authVersion + ((input.role !== undefined && input.role !== current.role) || (input.enabled !== undefined && input.enabled !== current.enabled) ? 1 : 0), updatedAt: new Date().toISOString() })), nextAction: "get_user" };
  }
  async setScenes(input: { userId: string; revision: number; sceneIds: string[] }, authorize?: () => void) {
    const snapshot = await this.workspace.get(); const known = new Set((Array.isArray(snapshot?.scenes) ? snapshot.scenes : []).map(scene => asRecord(scene)?.id));
    if (new Set(input.sceneIds).size !== input.sceneIds.length || input.sceneIds.some(id => !known.has(id))) throw new HttpError(400, "授权场景重复或不存在", "INVALID_SCENE_ACCESS");
    authorize?.();
    return { user: this.replace(input.userId, input.revision, current => ({ ...current, sceneIds: [...input.sceneIds], updatedAt: new Date().toISOString() })), nextAction: "get_user" };
  }
  async resetPassword(input: { userId: string; revision: number; password: string }, authorize?: () => void) {
    const encoded = await passwordHash(input.password);
    authorize?.();
    return { user: this.replace(input.userId, input.revision, current => ({ ...current, passwordHash: encoded, authVersion: current.authVersion + 1, updatedAt: new Date().toISOString() })), sessionsRevoked: true, nextAction: "login" };
  }
  securityPolicy(userOnly = false) { return { contractVersion: PUBLIC_ENTRY_CONTRACT.version, entryMode: userOnly ? "user-only" : "full", setupAvailable: !userOnly, administratorCredentials: userOnly ? "rejected" : "allowed", errors: "redacted_on_public_or_production", loginRateLimit: this.loginLimiter.policy() }; }
  async login(username: string, password: string, context: { clientAddress?: string; userOnly?: boolean } = {}) {
    const release = this.loginLimiter.enter(username, context.clientAddress, context.userOnly ? "public-user" : "private");
    try {
      const user = this.users().find(item => item.username === username.toLowerCase());
      const matched = await passwordMatches(password, user?.passwordHash ?? "0".repeat(32) + ":" + "0".repeat(128));
      if (!user || !matched || !user.enabled) throw new HttpError(401, "账号、密码无效或账户已停用", "LOGIN_FAILED");
      // Password verification was asynchronous; check the same account version before issuing credentials.
      const current = this.raw(user.id);
      if (current.authVersion !== user.authVersion || !current.enabled) throw new HttpError(401, "账号状态已变化，请重新登录", "LOGIN_FAILED");
      if (context.userOnly && current.role !== "user") throw new HttpError(403, "此入口仅供普通用户登录，请使用私有管理入口", "PUBLIC_USER_ONLY");
      return this.issue(current, "session", randomBytes(16).toString("hex"), "浏览器会话");
    } finally { release(); }
  }
  private issue(user: StoredUser, kind: Credential["kind"], id: string, name: string) {
    const token = randomBytes(32).toString("base64url"); const now = new Date();
    const credential = this.store.putDocument<Credential>(SYSTEM, "credentials", { id, revision: 0, userId: user.id, authVersion: user.authVersion, hash: hash(token), name, kind, revoked: false, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + (kind === "session" ? 24 * 3600 : 90 * 86400) * 1000).toISOString() }, 0);
    return { user: publicUser(user), token, credential: this.publicCredential(credential), nextAction: kind === "api" ? "save_token_now" : "get_current_user" };
  }
  private publicCredential(value: Credential) { const { id, revision, name, createdAt, expiresAt, revoked } = value; return { id, revision, name, createdAt, expiresAt, revoked }; }
  credentials(identity: Identity, query: { limit?: number; cursor?: string }) { return accessPagination(this.store.listDocuments<Credential>(SYSTEM, "credentials").filter(value => value.userId === identity.id && value.kind === "api").map(value => this.publicCredential(value)), query, "tokens:" + identity.id); }
  createCredential(identity: Identity, input: { tokenId: string; name: string }) {
    const user = this.current(identity);
    try { return this.issue(user, "api", input.tokenId, input.name); } catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "凭证ID已存在；密钥只返回一次，先读取元数据对账，再显式吊销", "TOKEN_ALREADY_EXISTS"); throw error; }
  }
  revokeCredential(identity: Identity, id: string, revision: number) {
    const credential = this.store.getDocument<Credential>(SYSTEM, "credentials", id);
    if (!credential || credential.userId !== identity.id || credential.kind !== "api") throw new HttpError(404, "凭证不存在", "TOKEN_NOT_FOUND");
    try { return { credential: this.publicCredential(this.store.putDocument(SYSTEM, "credentials", { ...credential, revoked: true }, revision)), nextAction: "list_own_tokens" }; } catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "凭证版本已变化", "TOKEN_REVISION_CONFLICT"); throw error; }
  }
  private current(identity: Identity) {
    const user = this.raw(identity.id);
    const credential = identity.credentialId ? this.store.getDocument<Credential>(SYSTEM, "credentials", identity.credentialId) : undefined;
    if (!user.enabled || user.authVersion !== identity.authVersion || !credential
      || credential.userId !== user.id || credential.authVersion !== user.authVersion
      || credential.revoked || credential.expiresAt <= new Date().toISOString()) {
      throw new HttpError(401, "会话或AI凭证已失效，请重新登录", "AUTH_REQUIRED");
    }
    return user;
  }
  refresh(identity: Identity): Identity { return identity.id === "@operator" ? identity : { ...this.current(identity), credentialId: identity.credentialId }; }
  authorizeScene(identity: Identity, sceneId: string) { const current = this.refresh(identity); if (current.role !== "admin" && !current.sceneIds.includes(sceneId)) throw new HttpError(403, "没有此场景的使用权限", "SCENE_ACCESS_DENIED"); return current; }
  authenticate(token: string): Identity {
    if (!token || token.length > 512) throw new HttpError(401, "请登录或配置AI凭证", "AUTH_REQUIRED");
    if (this.operatorToken && timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(this.operatorToken)))) return { id: "@operator", username: "operator", displayName: "运维管理员", role: "admin", enabled: true, revision: 1, sceneIds: [], createdAt: "", updatedAt: "" };
    const digest = hash(token);
    const credential = this.store.findCredentialByHash<Credential>(SYSTEM,digest);
    if (!credential || credential.revoked || credential.expiresAt <= new Date().toISOString()) throw new HttpError(401, "登录或AI凭证已失效", "AUTH_REQUIRED");
    const user = this.raw(credential.userId);
    if (!user.enabled || user.authVersion !== credential.authVersion) throw new HttpError(401, "账户已停用或会话已失效", "ACCOUNT_DISABLED");
    return { ...user, credentialId: credential.id };
  }
  logout(identity: Identity) { if (!identity.credentialId) return; const item = this.store.getDocument<Credential>(SYSTEM, "credentials", identity.credentialId); if (item) this.store.putDocument(SYSTEM, "credentials", { ...item, revoked: true }, item.revision); }
  middleware(loadProject: () => Promise<string>): RequestHandler {
    return async (req, res, next) => {
      try {
        if (!req.path.startsWith("/api/") || ["/api/health", "/api/ready"].includes(req.path)) { next(); return; }
        res.set("Cache-Control", "no-store");
        const bearer = req.get("Authorization"); const cookie = (req.get("Cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith("zane_session="))?.slice(13);
        const identity = this.authenticate(bearer?.startsWith("Bearer ") ? bearer.slice(7) : cookie ?? "");
        if (res.locals.publicUserOnly && identity.role !== "user") throw new HttpError(403, "此入口不接受管理员凭证，请使用私有管理入口", "PUBLIC_USER_ONLY");
        if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
          const origin = req.get("Origin"); if (origin && origin !== req.protocol + "://" + req.get("Host")) throw new HttpError(403, "请求来源不匹配", "INVALID_REQUEST_ORIGIN");
        }
        if (req.get("X-Zane-Actor") && req.get("X-Zane-Actor") !== identity.id) throw new HttpError(409, "登录身份已变化，请重新加载页面", "IDENTITY_CHANGED");
        res.locals.identity = identity;
        res.locals.authorizeRunMedia = (run: import("../domain/types.js").RunRecord) => {
          const current = this.refresh(identity);
          if (current.role === "admin") return;
          if (run.ownerUserId !== current.id) throw new HttpError(404, "运行不存在", "OBJECT_NOT_FOUND");
          this.authorizeScene(current, run.sceneId ?? "");
        };
        res.locals.authorizeAdmin = () => { const current = this.refresh(identity); if (current.role !== "admin") throw new HttpError(403,"需要管理员权限","ADMIN_REQUIRED"); };
        res.locals.authorizeAssetMedia = (project: string, id: string) => {
          const current = this.refresh(identity);
          if (current.role === "admin") return;
          const asset = this.store.getDocument<{ ownerUserId?: string }>(project, "assets", id);
          if (asset?.ownerUserId !== current.id) throw new HttpError(404, "素材不存在", "OBJECT_NOT_FOUND");
        };
        if (identity.role === "admin" || req.path.startsWith("/api/v1/self/") || ["/api/v1/ai", "/api/v1/ai/guide", "/api/v1/ai/openapi.json"].includes(req.path)) { next(); return; }
        if (["GET", "HEAD"].includes(req.method)) {
          const media = /^\/api\/v1\/runs\/([^/]+)\/(?:output-media|media\/[^/]+)$/.exec(req.path);
          if (media) { const run = this.store.getRun(await loadProject(), decodeURIComponent(media[1])); if (run?.ownerUserId === identity.id) { res.locals.authorizeRunMedia(run); next(); return; } throw new HttpError(404, "媒体不存在", "OBJECT_NOT_FOUND"); }
          const archive = /^\/api\/v1\/runs\/([^/]+)\/(?:media-export|media\.zip)$/.exec(req.path);
          if (archive) { const run = this.store.getRun(await loadProject(), decodeURIComponent(archive[1])); if (!run) throw new HttpError(404, "运行不存在", "OBJECT_NOT_FOUND"); res.locals.authorizeRunMedia(run); next(); return; }
          const asset = /^\/api\/v1\/assets\/([^/]+)\/versions\/\d+\/media$/.exec(req.path);
          if (asset) { res.locals.authorizeAssetMedia(await loadProject(), decodeURIComponent(asset[1])); next(); return; }
        }
        throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
      } catch (error) { next(error); }
    };
  }
}
