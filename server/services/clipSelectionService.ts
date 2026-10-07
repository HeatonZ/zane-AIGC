import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AssetSource, ClipSelection, ClipCandidate } from "../domain/productionContracts.js";
import type { JsonValue, RunRecord, RunSubmitter, RunWorkflowDefinition } from "../domain/types.js";
import { asRecord, externalizeRuntimeValue, normalizeMediaList, resolveWorkflowReference } from "../domain/workflowValues.js";
import { mediaKindFromWorkflowType } from "../runtimeValue.js";
import { AssetService } from "./assetService.js";
import { RunService } from "./runService.js";
import { HttpError } from "../errors.js";

const terminal = (run: RunRecord) => !["queued", "running", "cancelling", "waiting"].includes(run.status);
export function shotFingerprint(value: unknown) {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b)).map(([key,val]) => [key, stable(val)])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export class ClipSelectionService {
  private readonly busy = new Set<string>();
  constructor(readonly assets: AssetService, readonly runs: RunService) {}
  get(project: string, id: string) { const item = this.assets.store.getDocument<ClipSelection>(project,"clip-selections",id); if (!item) throw new HttpError(404,"选片清单不存在"); return item; }
  put(project: string, selection: ClipSelection, revision: number) { try { return this.assets.store.putDocument(project,"clip-selections",selection,revision); } catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409,"选片清单已变化，请刷新后重试","CLIP_SELECTION_CONFLICT"); throw error; } }
  async allRuns(project: string) { await this.runs.importLegacyProject(project); const all: RunRecord[] = []; let before; do { const page = this.assets.store.listRuns(project,{ limit: 200, before }); all.push(...page.runs); before = page.nextCursor; } while (before); return all; }
  familyRoot(id: string, all: Map<string,RunRecord>) { const seen = new Set<string>(); let current = id; while (!seen.has(current)) { seen.add(current); const run = all.get(current); const parent = run?.rerunFromRunId ?? run?.resumedFromRunId; if (!parent) return current; current = parent; } return current; }
  async list(project: string, runId?: string) { const lists = this.assets.store.listDocuments<ClipSelection>(project,"clip-selections"); if (!runId) return lists; const all = new Map((await this.allRuns(project)).map(run => [run.runId,run])); const root = this.familyRoot(runId,all); return lists.filter(list => this.familyRoot(list.sourceRunId,all) === root); }
  preview(value: JsonValue, source?: AssetSource) { const row = asRecord(value); const text = typeof value === "string" ? value : typeof row?.previewUrl === "string" ? row.previewUrl : typeof row?.url === "string" ? row.url : typeof row?.path === "string" ? row.path : "";
    const normalized = text.replace(/\\/g,"/"); const archived = /(?:^|\/)\.zane\/runs\/([a-f0-9-]{36})\/outputs\/media\/([^/]+)$/i.exec(normalized);
    return archived ? "/api/v1/runs/" + archived[1] + "/media/" + encodeURIComponent(archived[2]) : /^(https?:|data:|\/api\/)/.test(text) ? text : text && source ? "/api/v1/runs/" + source.runId + "/output-media?" + new URLSearchParams(Object.entries(source).filter(([key])=>key!=="runId").map(([key,value])=>[key,String(value)])) : "";
  }
  async candidates(project: string, selection: ClipSelection) {
    const all = await this.allRuns(project); const byId = new Map(all.map(run => [run.runId,run])); const root = this.familyRoot(selection.sourceRunId,byId);
    return selection.shots.map(shot => {
      const candidates: ClipCandidate[] = [];
      for (const run of all) {
        if (!terminal(run) || this.familyRoot(run.runId,byId) !== root) continue;
        const step = run.steps.find(step => step.stepId === selection.generationStepId);
        const definition = run.workflow.steps.find(step => step.id === selection.generationStepId);
        if (mediaKindFromWorkflowType(definition?.outputs?.find(output => output.key === selection.outputKey)?.type) !== "video") continue;
        const matches = step?.items?.filter(item => item.status === "completed" && isDeepStrictEqual(item.value,shot.value)) ?? [];
        const target = matches.length === 1 ? matches[0] : matches.find(item => item.index === shot.index);
        const clips = normalizeMediaList(target?.outputs?.[selection.outputKey]);
        for (let mediaIndex = 0; target && mediaIndex < clips.length; mediaIndex++) { const previewUrl = this.preview(clips[mediaIndex], { runId: run.runId, stepId: selection.generationStepId, itemIndex: target.index, outputKey: selection.outputKey, mediaIndex }); if (!previewUrl) continue; candidates.push({ source: { runId: run.runId, stepId: selection.generationStepId, itemIndex: target.index, outputKey: selection.outputKey, mediaIndex }, previewUrl, runTitle: run.runTitle ?? run.workflowName, createdAt: run.createdAt }); }
      }
      return { shotId: shot.shotId, candidates };
    });
  }
  async pin(source: AssetSource, name: string, group: string) { const result = await this.assets.save({ source, name, category: "material", group, tags: ["选片"] }); if (result.asset.kind !== "video") throw new HttpError(400,"选片只支持视频"); return { assetId: result.asset.id, assetVersion: result.asset.currentVersion }; }
  async create(raw: unknown) {
    const body = asRecord(raw); const { projectDirectory } = await this.assets.loadSettings();
    if (!body || typeof body.sourceRunId !== "string" || typeof body.stepId !== "string" || typeof body.outputKey !== "string" || typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400,"请填写清单名称和视频步骤");
    const run = await this.runs.getRun(projectDirectory,body.sourceRunId); if (!run || !terminal(run)) throw new HttpError(409,"请等待运行结束后创建选片清单");
    const step = run.workflow.steps.find(step => step.id === body.stepId);
    if (!step || step.execution?.mode !== "for_each" || mediaKindFromWorkflowType(step.outputs?.find(output => output.key === body.outputKey)?.type) !== "video") throw new HttpError(400,"需要选择逐项生成视频的步骤输出");
    const values = new Map(run.steps.filter(step => step.outputs).map(step => [step.stepId,step.outputs!]));
    const items = externalizeRuntimeValue(resolveWorkflowReference(step.execution.sourceRef ?? "",run.inputValues,values));
    if (!Array.isArray(items) || !items.length || items.length > 360) throw new HttpError(400,"无法恢复完整镜头列表");
    const now = new Date().toISOString();
    let selection: ClipSelection = { id: randomUUID(), revision: 0, name: body.name.trim().slice(0,160), sourceRunId: run.runId, sceneId: run.sceneId, generationStepId: step.id, outputKey: body.outputKey, createdAt: now, updatedAt: now, shots: items.map((value,index) => ({ shotId: shotFingerprint(value) + "-" + index, index, value })) };
    const candidates = await this.candidates(projectDirectory,selection);
    for (const shot of selection.shots) { const choice = candidates.find(row => row.shotId === shot.shotId)?.candidates.find(item => item.source.runId === run.runId); if (choice) shot.choice = { shotId: shot.shotId, source: choice.source, ...await this.pin(choice.source,selection.name + " · 镜头 " + (shot.index+1),selection.name) }; }
    selection = this.put(projectDirectory,selection,0); return selection;
  }
  async locked<T>(project: string, id: string, revision: unknown, operation: (selection: ClipSelection) => Promise<T>) {
    const key = project + "\n" + id; if (this.busy.has(key)) throw new HttpError(409,"正在保存或合成此清单，请稍后重试"); this.busy.add(key);
    try { const selection = this.get(project,id); if (revision !== selection.revision) throw new HttpError(409,"选片清单已变化，请刷新后重试","CLIP_SELECTION_CONFLICT"); return await operation(selection); } finally { this.busy.delete(key); }
  }
  async update(id: string, raw: unknown) { const body = asRecord(raw) ?? {}; const { projectDirectory } = await this.assets.loadSettings(); return this.locked(projectDirectory,id,body.revision,async selection => {
    if (body.name !== undefined) { if (typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400,"清单名称不能为空"); selection.name = body.name.trim().slice(0,160); }
    if (body.shotOrder !== undefined) { if (!Array.isArray(body.shotOrder) || body.shotOrder.length !== selection.shots.length || new Set(body.shotOrder).size !== selection.shots.length || body.shotOrder.some(id => !selection.shots.some(shot => shot.shotId === id))) throw new HttpError(400,"镜头顺序必须包含全部镜头且不能重复"); selection.shots = body.shotOrder.map(id => selection.shots.find(shot => shot.shotId === id)!); }
    if (body.shotId !== undefined) { const shot = selection.shots.find(shot => shot.shotId === body.shotId); if (!shot) throw new HttpError(400,"镜头不存在");
      if (body.source === null) shot.choice = undefined;
      else { const candidates = await this.candidates(projectDirectory,selection); const candidate = candidates.find(item => item.shotId === shot.shotId)?.candidates.find(item => isDeepStrictEqual(item.source,body.source)); if (!candidate) throw new HttpError(409,"候选不属于当前分镜或来源不可用，请刷新候选"); shot.choice = { shotId: shot.shotId, source: candidate.source, ...await this.pin(candidate.source,selection.name + " · 镜头 " + (shot.index+1),selection.name) }; }
    }
    selection.updatedAt = new Date().toISOString(); return this.put(projectDirectory,selection,selection.revision);
  }); }
  async compose(id: string, raw: unknown, access?: { ownerUserId: string; submitter?: RunSubmitter; authorize(): void }) { const body = asRecord(raw) ?? {}; const { projectDirectory } = await this.assets.loadSettings(); return this.locked(projectDirectory,id,body.revision,async selection => {
    if (selection.shots.some(shot => !shot.choice?.assetId || !shot.choice?.assetVersion)) throw new HttpError(400,"每个镜头都需要选定一个版本才能合成");
    const clips = selection.shots.map(shot => ({ assetId: shot.choice!.assetId!, assetVersion: shot.choice!.assetVersion! }));
    const shots = selection.shots.map((shot,index) => ({ ...(asRecord(shot.value) ?? {}), index: index+1, selection_shot_id: shot.shotId }));
    const workflow: RunWorkflowDefinition = { sceneId: selection.sceneId, name: "选片合成", inputs: [{ key:"clips",type:"video_list",required:true },{ key:"shots",type:"json",required:true },{ key:"selection",type:"json",required:true }], steps: [{ id:"concat",name:"按选片清单本地合成",kind:"comfyui",capabilityId:"media.video_concat",capabilityVersion:"1",comfyui:{ workflowFile:"local.ffmpeg",adapter:"video_concat",bindings:[] },inputs:[{ key:"clips",sourceRef:"input.clips" },{ key:"shots",sourceRef:"input.shots" }],outputs:[{key:"video",type:"video_list",label:"成片"},{key:"download",type:"text",label:"下载地址"},{key:"manifest",type:"json",label:"合成清单"}] }], outputs:[{key:"video",type:"video_list",label:"成片",sourceRef:"step.concat.outputs.video"},{key:"manifest",type:"json",label:"合成清单",sourceRef:"step.concat.outputs.manifest"}] };
    const run = await this.runs.submit({ runId:body.runId,workflow,inputValues:{ clips,shots,selection:structuredClone(selection) },runTitle: (selection.name + " · 选片合成").slice(0,120) }, access);
    const saved = this.put(projectDirectory,{ ...selection,lastRunId:run.runId,updatedAt:new Date().toISOString() },selection.revision);
    return { runId:run.runId,status:run.status,selection:saved };
  }); }
}
