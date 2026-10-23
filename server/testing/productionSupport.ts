import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { SavedSettings } from "../domain/types.js";
import type { StepExecutor } from "../execution/executorRegistry.js";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import type { CapabilityRuntime } from "../capabilities/package.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { RunService, type RunCreditHooks } from "../services/runService.js";
import { AssetService } from "../services/assetService.js";
import { ClipSelectionService } from "../services/clipSelectionService.js";
import { temporaryDirectory } from "./testSupport.js";
export async function productionHarness(t: TestContext, executor?: StepExecutor, workbenchBaseUrl?: () => string, thirdPartyRequest?: CapabilityRuntime["thirdPartyRequest"], getLocalExportRoot?: () => string, comfyui?: CapabilityRuntime["comfyui"], hermes?: CapabilityRuntime["hermes"]) {
  let store: SqliteStore, service: RunService, assets: AssetService, clips: ClipSelectionService;
  const root = await temporaryDirectory(t, async () => { await service.shutdown(100); store.close(); });
  const settings: SavedSettings = { projectDirectory:path.join(root,"project"),comfyuiBaseUrl:"http://127.0.0.1:1",workflowTimeoutMinutes:1,enabledHermesProfiles:[] }; await mkdir(settings.projectDirectory);
  const executors = await loadCapabilityPackages({ hermes: hermes ?? (async () => { throw new Error("测试禁止调用 Hermes"); }), comfyui: comfyui ?? (async () => { throw new Error("测试禁止调用 ComfyUI"); }), async condition() { return { result:true }; }, thirdPartyRequest: thirdPartyRequest ?? (async () => { throw new Error("测试禁止调用第三方接口"); }) });
  executors.register(executor ?? {kind:"fake",async execute(){return {value:"ok"};}});
  // 积分钩子默认不接；需要计费闭环的测试显式传 credits（与生产 index.ts 同一装配方式）。
  // 积分钩子延迟绑定：useCredits 可在 open() 之后调用，RunService 在提交/结算时读取。
  let credits: RunCreditHooks | undefined;
  const creditHooks: RunCreditHooks = {
    reserve: (...args) => { if (!credits) throw new Error("积分钩子未接线"); return credits.reserve(...args); },
    release: (...args) => { if (!credits) throw new Error("积分钩子未接线"); return credits.release(...args); },
    settle: (...args) => credits ? credits.settle(...args) : undefined,
  };
  function open() { store = new SqliteStore(path.join(root,"metadata.db")); assets = new AssetService(store,async()=>settings,(project,id)=>service.getRun(project,id),workbenchBaseUrl); service = new RunService({ store,executors,loadSettings:async()=>settings,maxActiveRuns:1,getLocalExportRoot,resolveAssets:(project,workflow,values)=>assets.resolveInputs(project,workflow,values),credits:creditHooks }); clips = new ClipSelectionService(assets,service); }
  open();
  return {root,settings,executors,get store(){return store;},get service(){return service;},get assets(){return assets;},get clips(){return clips;},useCredits(hooks: RunCreditHooks){credits = hooks;},async restart(start=true){await service.shutdown(0);store.close();open();if(start)await service.start();}};
}
