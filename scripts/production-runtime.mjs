import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

export async function productionSettings(environment = process.env) {
  const values = {};
  for (const filename of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    try {
      for (const line of (await readFile(path.join(root, filename), "utf8")).split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        values[match[1]] = value;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const resolved = { ...values, ...Object.fromEntries(Object.entries(environment).filter(([,value]) => value !== undefined)) };
  const port = Number(resolved.API_PORT ?? 8799);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT 无效；没有停止任何进程。");
  const dataDirectory = path.resolve(root, resolved.APP_DATA_DIR?.trim() || "data/production");
  const host = resolved.API_HOST?.trim() || "0.0.0.0";
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return { port, probeHost, dataDirectory, leaseFile: path.join(dataDirectory, "production-runtime.json") };
}
export async function portIsOpen(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const socket = net.createConnection({host,port}); let done=false;
    const finish = open => { if(done)return;done=true;socket.destroy();resolve(open); };
    socket.once("connect",()=>finish(true));socket.once("error",()=>finish(false));socket.setTimeout(500,()=>finish(false));
  });
}
export async function verifyProcess(lease) {
  // Resolve the listening process fresh for every invocation; never stop a saved PID.
  if (process.platform === "win32") {
    const code = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${lease.pid}'; $listens=@(Get-NetTCPConnection -State Listen -LocalPort ${lease.port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); if($p){@{pid=$p.ProcessId; name=$p.Name; command=$p.CommandLine; listening=($listens -contains $p.ProcessId)} | ConvertTo-Json -Compress}`;
    const {stdout}=await exec("powershell.exe",["-NoProfile","-NonInteractive","-Command",code],{windowsHide:true,cwd:root,timeout:15000});
    const processInfo=JSON.parse(stdout.trim() || "null");
    if(!processInfo || processInfo.pid!==lease.pid || processInfo.name?.toLowerCase()!=="node.exe" || !processInfo.listening || !/dist-server[\\/]index\.js/.test(processInfo.command) || !/(^|\s)--production(\s|$)/.test(processInfo.command)) throw new Error("生产进程身份或端口已变化；没有停止任何进程。");
  } else {
    const {stdout}=await exec("ps",["-p",String(lease.pid),"-o","args="],{cwd:root,timeout:5000});
    if(!/dist-server[\\/]index\.js/.test(stdout) || !/(^|\s)--production(\s|$)/.test(stdout)) throw new Error("生产进程身份已变化；没有停止任何进程。");
  }
}
export async function controlRequest(lease, action, operationId) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(lease.socket);let data="";let done=false;
    const fail=error=>{if(done)return;done=true;socket.destroy();reject(error);};
    socket.setTimeout(60000,()=>fail(new Error("正常切换回执超时；仅按原 operationId 对账，不强制停止。")));
    socket.once("error",fail);
    socket.once("connect",()=>socket.write(JSON.stringify({action,operationId,pid:lease.pid,instanceId:lease.instanceId,key:lease.key})+"\n"));
    socket.on("data",chunk=>{data+=chunk.toString("utf8"); if(Buffer.byteLength(data)>1048576){fail(new Error("无效的运维回执"));return;} const end=data.indexOf("\n");if(end<0)return;try{const result=JSON.parse(data.slice(0,end));done=true;socket.end();resolve(result);}catch(error){fail(error);}});
    socket.once("end",()=>{if(!done)fail(new Error("正常切换响应丢失；按原 operationId 对账，不自动重放。"));});
  });
}
