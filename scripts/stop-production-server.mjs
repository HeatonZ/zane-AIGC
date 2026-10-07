import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { root, productionSettings, portIsOpen, verifyProcess, controlRequest } from "./production-runtime.mjs";

try {
  const settings=await productionSettings();
  if(!await portIsOpen(settings.port, settings.probeHost)) {
    console.log(`生产端口 ${settings.port} 当前空闲；没有停止任何进程。`);
    const database=path.join(settings.dataDirectory,"zane.db");
    let exists=false;try{exists=(await stat(database)).isFile();}catch(error){if(error.code!=="ENOENT")throw error;}
    if(exists){
      // For the one-time manual stop of legacy servers, snapshot the closed
      // authoritative database before any build/start can migrate it.
      let staleLease;try{staleLease=JSON.parse(await readFile(settings.leaseFile,"utf8"));}catch{}
      if(staleLease?.pid){try{process.kill(staleLease.pid,0);throw new Error("原工作台进程尚未退出；没有强制关闭，请等待正常关闭完成。");}catch(error){if(error.code!=="ESRCH")throw error;}}
      const operationId=randomUUID(),directory=path.join(settings.dataDirectory,"backups","restart-"+operationId);
      await mkdir(directory,{recursive:true});const source=new DatabaseSync(database,{readOnly:true});
      try{await backup(source,path.join(directory,"zane.db"));}finally{source.close();}
      for(const filename of ["connections.json","workspace.json"]){try{await copyFile(path.join(settings.dataDirectory,filename),path.join(directory,filename));}catch(error){if(error.code!=="ENOENT")throw error;}}
      console.log(`已备份停机后的 SQLite 与配置：${directory}`);
    }
  }
  else {
    let lease;
    try { lease=JSON.parse(await readFile(settings.leaseFile,"utf8")); }
    catch { throw new Error("现有后台尚无正常切换接口。首次升级请在原工作台终端 Ctrl+C 正常关闭，再运行 npm run start:prod；不使用 taskkill。Hermes/ComfyUI 不用重启。"); }
    if(lease.schemaVersion!==1 || !Number.isSafeInteger(lease.pid) || lease.pid<=0 || lease.port!==settings.port || path.resolve(lease.root)!==root || path.resolve(lease.entry)!==path.join(root,"dist-server","index.js") || typeof lease.socket!=="string" || typeof lease.instanceId!=="string" || typeof lease.key!=="string") throw new Error("运行租约与本项目不一致；没有停止任何进程。");
    await verifyProcess(lease);
    const identity=await controlRequest(lease,"inspect");
    if(!identity.ok || identity.pid!==lease.pid || identity.instanceId!==lease.instanceId || path.resolve(identity.root)!==root || path.resolve(identity.entry)!==path.join(root,"dist-server","index.js") || identity.port!==settings.port) throw new Error("当前服务实例身份已变化；没有停止任何进程。");
    await verifyProcess(lease);
    const operationId=randomUUID();
    console.log(`正常切换工作台：PID ${lease.pid} / 端口 ${settings.port} / operationId ${operationId}。`);
    let result;
    try { result=await controlRequest(lease,"shutdown",operationId); }
    catch (error) {
      // Never resubmit a shutdown with a new ID after losing its response.
      try { result=JSON.parse(await readFile(path.join(settings.dataDirectory,"backups","restart-"+operationId,"receipt.json"),"utf8")); }
      catch { throw new Error(`${error.message} 原 operationId=${operationId}；备份/关闭尚未确认，本次不继续构建。`); }
    }
    if(!result.ok) throw new Error(`${result.code}: ${JSON.stringify({unfinished:result.unfinished,metrics:result.metrics,activeRequests:result.activeRequests,message:result.message})}。未强制停止；等待任务/审核处理完再升级。`);
    const expectedBackup=path.join(settings.dataDirectory,"backups","restart-"+operationId);
    if(result.operationId!==operationId || result.pid!==lease.pid || result.instanceId!==lease.instanceId || path.resolve(result.backupDirectory)!==expectedBackup || !(await stat(path.join(expectedBackup,"zane.db"))).isFile()) throw new Error("备份回执不匹配；本次不继续切换。");
    console.log(`权威 SQLite 与配置备份：${expectedBackup}`);
    const deadline=Date.now()+30000;
    let closed=false;
    while(Date.now()<deadline){
      try{const receipt=JSON.parse(await readFile(path.join(expectedBackup,"receipt.json"),"utf8"));closed=Boolean(receipt.closedAt && receipt.instanceId===lease.instanceId && receipt.operationId===operationId);}catch{}
      if(closed && !await portIsOpen(settings.port, settings.probeHost))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!closed || await portIsOpen(settings.port, settings.probeHost)) throw new Error("旧服务未确认完成正常关闭；没有强制结束进程，本次不继续构建。");
    console.log("旧工作台已正常关闭。新后台就绪后将通知本项目 MCP 自动切换；Hermes Gateway/ComfyUI 保持不动。");
  }
} catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }
