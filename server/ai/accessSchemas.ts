import * as z from "zod/v4";
import { id, runId, values } from "./schemas.js";
export const accessPage = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(4000).optional() }).strict();
export const userCreate = z.object({ userId: id, username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/), displayName: z.string().trim().min(1).max(100), password: z.string().min(10).max(256), role: z.enum(["admin", "user"]).default("user") }).strict();
export const adminSetup = userCreate.extend({ role: z.literal("admin").default("admin") });
export const authLogin = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
export const userUpdate = z.object({ userId: id, revision: z.int().positive(), displayName: z.string().trim().min(1).max(100).optional(), role: z.enum(["admin", "user"]).optional(), enabled: z.boolean().optional() }).strict();
export const userAccess = z.object({ userId: id, revision: z.int().positive(), sceneIds: z.array(id).max(1000) }).strict();
export const passwordReset = z.object({ userId: id, revision: z.int().positive(), password: z.string().min(10).max(256) }).strict();
export const ownScene = z.object({ sceneId: id }).strict();
export const ownPreparation = ownScene.extend({ versionId: id, inputValues: values }).strict();
export const ownSubmission = ownPreparation.extend({ runId, runTitle: z.string().trim().max(120).optional() }).strict();
export const ownDraft = ownPreparation.extend({ draftId: id, revision: z.int().nonnegative(), title: z.string().trim().min(1).max(120), runTitle: z.string().trim().max(120).optional() }).strict();
export const credentialCreate = z.object({ tokenId: id, name: z.string().trim().min(1).max(100) }).strict();
export const credentialRevoke = z.object({ tokenId: id, revision: z.int().positive() }).strict();

export const runInputQuery = z.object({
  inputKey: id.optional(), cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  valueOffset: z.coerce.number().int().nonnegative().default(0),
  valueLimit: z.coerce.number().int().min(1).max(8192).default(2000),
  includeValues: z.boolean().default(true),
  maxValueBytes: z.coerce.number().int().min(1024).max(262144).default(32768),
}).strict();
export type RunInputQuery = z.output<typeof runInputQuery>;
export const runActivityQuery = z.object({
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
