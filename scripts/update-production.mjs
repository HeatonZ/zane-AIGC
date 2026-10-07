import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProductionUpdater, launchUpgradeWorker, portOpen } from "../server/runtime/productionUpdater.ts";
import { readUpgradeStatus } from "../server/services/workbenchUpdateService.ts";
import { root, productionSettings, verifyProcess, controlRequest } from "./production-runtime.mjs";

const args=process.argv.slice(2), command=args.shift() ?? "run";
const allowed=new Set(["--id","--revision","--background"]);
const values={};
for (let i=0;i<args.length;i++) {
  const key=args[i]; if (!allowed.has(key) || key in values) throw new Error("仅支持 --id UUID / --revision 整数 / --background");
  values[key]=key === "--background" ? true : args[++i];
  if (values[key] === undefined) throw new Error("缺少参数值："+key);
}
const settings={...await productionSettings(),root,environment:process.env};
const updater=new ProductionUpdater(settings,{verifyProcess,control:controlRequest});
const id=values["--id"];
try {
  if (command === "status") console.log(JSON.stringify(await readUpgradeStatus(settings.dataDirectory,id),null,2));
  else if (command === "cancel") {
    if (!id || !/^\d+$/.test(values["--revision"] ?? "")) throw new Error("cancel需要原 --id 与 --revision");
    await updater.cancel(id,Number(values["--revision"])); console.log(JSON.stringify({operationId:id,cancellationRequested:true,nextAction:"read_same_id"}));
  } else if (command === "recover") {
    if (!id) throw new Error("recover必须指定原 --id");
    console.log(JSON.stringify(await updater.recover(id),null,2));
  } else if (command === "apply") {
    if (!id) throw new Error("apply必须指定已验收的原 --id");
    console.log(JSON.stringify(await updater.apply(id),null,2));
  } else if (["run","prepare"].includes(command)) {
    const operationId=id ?? randomUUID();
    console.log(JSON.stringify({operationId,nextAction:"read_upgrade_status_same_id"}));
    if (values["--background"]) {
      if (command !== "run") throw new Error("仅run支持后台执行");
      console.log(JSON.stringify(await launchUpgradeWorker(fileURLToPath(import.meta.url),operationId,settings)));
    } else {
      console.log(JSON.stringify(await updater.prepare(operationId),null,2));
      if (command === "run") console.log(JSON.stringify(await (await portOpen(settings.port,settings.probeHost) ? updater.apply(operationId) : updater.install(operationId)),null,2));
    }
  } else throw new Error("命令只支持 run / prepare / apply / status / cancel / recover");
} catch(error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1;
}
