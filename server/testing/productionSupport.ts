import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { SavedSettings } from "../domain/types.js";
import type { StepExecutor } from "../execution/executorRegistry.js";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { RunService } from "../services/runService.js";
import { AssetService } from "../services/assetService.js";
import { ClipSelectionService } from "../services/clipSelectionService.js";
import { temporaryDirectory } from "./testSupport.js";
export async function productionHarness(t: TestContext, executor?: StepExecutor, workbenchBaseUrl?: () => string) {
  let store: SqliteStore, service: RunService, assets: AssetService, clips: ClipSelectionService;
  const root = await temporaryDirectory(t, async () => { await service.shutdown(100); store.close(); });
  const settings: SavedSettings = { projectDirectory:path.join(root,"project"),comfyuiBaseUrl:"http://127.0.0.1:1",workflowTimeoutMinutes:1,enabledHermesProfiles:[] }; await mkdir(settings.projectDirectory);
  const executors = await loadCapabilityPackages({ async hermes() { throw new Error("测试禁止调用 Hermes"); }, async comfyui() { throw new Error("测试禁止调用 ComfyUI"); }, async condition() { return { result:true }; } });
  executors.register(executor ?? {kind:"fake",async execute(){return {value:"ok"};}});
  function open() { store = new SqliteStore(path.join(root,"metadata.db")); assets = new AssetService(store,async()=>settings,(project,id)=>service.getRun(project,id),workbenchBaseUrl); service = new RunService({ store,executors,loadSettings:async()=>settings,maxActiveRuns:1,resolveAssets:(project,workflow,values)=>assets.resolveInputs(project,workflow,values) }); clips = new ClipSelectionService(assets,service); }
  open();
  return {root,settings,executors,get store(){return store;},get service(){return service;},get assets(){return assets;},get clips(){return clips;},async restart(start=true){await service.shutdown(0);store.close();open();if(start)await service.start();}};
}
