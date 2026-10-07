import express, { Router } from "express";
import type { Request, Response } from "express";
import { AssetService } from "../services/assetService.js";
import { assetEnvelope, assetSummary, parseAssetInput } from "../services/assetCatalog.js";
import { saveAssetSchema, uploadAssetSchema } from "../domain/assetLibraryContracts.js";
import { HttpError } from "../errors.js";

function query(req: Request) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== "string") throw new HttpError(400, "查询参数必须为单个字符串：" + key, "INVALID_ASSET_REQUEST");
    if (["archived", "includeParameters"].includes(key)) {
      if (value !== "true" && value !== "false") throw new HttpError(400, key + "必须是true或false", "INVALID_ASSET_REQUEST");
      result[key] = value === "true";
    } else if (["limit", "revision", "parametersOffset", "parametersLimit"].includes(key)) result[key] = Number(value);
    else if (key === "tags") {
      try { result[key] = JSON.parse(value); } catch { throw new HttpError(400, "tags必须为JSON字符串数组", "INVALID_ASSET_REQUEST"); }
    } else result[key] = value;
  }
  return result;
}
function authorize(res: Response) { res.locals.authorizeAdmin?.(); }
export function createAssetRouter(service: AssetService) {
  const router = Router();
  router.use("/api/v1/assets", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Owned task-attachment media is authorized by the identity middleware; catalog and all writes are admin-only.
    if (!/^\/[^/]+\/versions\/\d+\/media$/.test(req.path)) authorize(res);
    next();
  });
  router.get("/api/v1/assets", async (req, res) => {
    const { projectDirectory } = await service.loadSettings(); authorize(res);
    res.json(service.catalog(projectDirectory, query(req), res.locals.identity?.id));
  });
  router.post("/api/v1/assets", async (req, res) => {
    const input = parseAssetInput(saveAssetSchema, req.body);
    const saved = await service.save(input, undefined, { ownerUserId: res.locals.identity?.id, authorize: () => authorize(res) });
    res.status(201).json(assetEnvelope(saved.asset, saved.reference));
  });
  router.post("/api/v1/assets/upload", express.raw({ type: "application/octet-stream", limit: "250mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "请选择媒体文件", "INVALID_ASSET_REQUEST");
    let filename: string;
    try { filename = decodeURIComponent(req.get("X-File-Name") ?? "media.bin"); } catch { throw new HttpError(400, "文件名编码无效", "INVALID_ASSET_REQUEST"); }
    const input = parseAssetInput(uploadAssetSchema, { name: filename, ...query(req) });
    const saved = await service.save(input, { bytes: req.body, filename }, { ownerUserId: res.locals.identity?.id, authorize: () => authorize(res) });
    res.status(201).json(assetEnvelope(saved.asset, saved.reference));
  });
  router.get("/api/v1/assets/:assetId", async (req, res) => {
    const { projectDirectory } = await service.loadSettings(); authorize(res);
    res.json(service.detail(projectDirectory, req.params.assetId));
  });
  router.patch("/api/v1/assets/:assetId", async (req, res) => res.json({ asset: assetSummary(await service.update(req.params.assetId, req.body, () => authorize(res))), nextAction: "get_asset" }));
  router.get("/api/v1/assets/:assetId/versions", async (req, res) => {
    const { projectDirectory } = await service.loadSettings(); authorize(res);
    res.json(service.versionsPage(projectDirectory, req.params.assetId, query(req), res.locals.identity?.id));
  });
  router.get("/api/v1/assets/:assetId/versions/:version", async (req, res) => {
    const { projectDirectory } = await service.loadSettings(); authorize(res);
    const version = Number(req.params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(400, "素材版本无效", "INVALID_ASSET_REQUEST");
    res.json(service.versionDetail(projectDirectory, req.params.assetId, version, query(req)));
  });
  router.get("/api/v1/assets/:assetId/versions/:version/media", async (req, res, next) => {
    const { projectDirectory } = await service.loadSettings();
    const version = Number(req.params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(400, "素材版本无效", "INVALID_ASSET_REQUEST");
    // Recheck even for HEAD/Range after asynchronous settings reads.
    if (res.locals.identity?.role === "admin") authorize(res);
    else res.locals.authorizeAssetMedia?.(projectDirectory, req.params.assetId);
    res.sendFile(service.file(projectDirectory, req.params.assetId, version), { dotfiles: "allow", headers: { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } }, error => { if (error) next(error); });
  });
  router.get("/api/v1/runs/:runId/output-media", async (req,res,next) => {
    const { projectDirectory } = await service.loadSettings();
    const selected = await service.source(projectDirectory, { runId:req.params.runId, stepId:req.query.stepId, itemIndex:req.query.itemIndex === undefined ? undefined : Number(req.query.itemIndex), outputKey:req.query.outputKey, mediaIndex:Number(req.query.mediaIndex ?? 0) });
    res.sendFile(service.localMediaFile(projectDirectory, selected.value), { dotfiles:"allow" }, error => { if (error) next(error); });
  });
  return router;
}
