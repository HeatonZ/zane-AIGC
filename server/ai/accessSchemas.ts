import * as z from "zod/v4";
import { id, runId, values } from "./schemas.js";
import { creditLedgerQuery, redeemCodeRequest, createRedeemBatch, redeemCodeKey, redeemBatchKey, adjustUserCredits } from "../domain/creditContracts.js";
import { packagePrepareRequest, packageSubmitRequest, packageConfirmItemRequest, packageDraftDocument } from "../domain/packageContracts.js";
export const accessPage = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(4000).optional() }).strict();
/** 搜索词按字面匹配运行标题、流程名、场景、运行编号、错误与提交人；换关键字必须从第一页重读。 */
export const runSearchText = z.string().trim().min(1).max(200).optional();
export const runListPage = accessPage.extend({ q: runSearchText }).strict();
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
export const ownCreditLedgerQuery = creditLedgerQuery;
export const ownRedeemCode = redeemCodeRequest;
export const adminRedeemBatch = createRedeemBatch;
export const adminRedeemCodeKey = redeemCodeKey;
export const adminRedeemBatchKey = redeemBatchKey;
export const adminCreditAdjust = adjustUserCredits;
export const ownPackageQuery = z.object({ packageId: id, versionId: id.optional() }).strict();
export const ownPackagePrepare = packagePrepareRequest;
export const ownPackageSubmit = packageSubmitRequest;
export const ownPackageConfirmItem = packageConfirmItemRequest;
export const packageRunKey = z.object({ packageRunId: z.uuid() }).strict();
export const packageDraftCreate = packageDraftDocument;
export const packageDraftUpdate = packageDraftDocument.partial().extend({ revision: z.int().nonnegative() }).strict();
export const packagePublish = z.object({ revision: z.int().nonnegative(), publicationId: z.uuid().describe("调用前保存的UUID，即包版本ID") }).strict();
export const packageAccess = z.object({ userId: id, revision: z.int().positive(), packageIds: z.array(id).max(1000) }).strict();
export const signupRegister = z.object({
  userId: id.describe("调用前生成的稳定ID；回执丢失用同一ID对账，不重建账号"),
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(256),
}).strict();

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
