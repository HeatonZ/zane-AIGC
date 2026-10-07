import assert from "node:assert/strict";
import test from "node:test";
import { canonicalOrigin, localBackendUrl, readMcpGeneration, atomicJson } from "./mcpReload.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import os from "node:os";
import { temporaryDirectory } from "../testing/testSupport.js";
import path from "node:path";

test("MCP 代次按实际监听地址隔离，通配主机只在通知中转为可连接的 loopback", async()=>{
  assert.equal(localBackendUrl("0.0.0.0",8799),"http://127.0.0.1:8799");
  assert.equal(localBackendUrl("::",8799),"http://[::1]:8799");
  assert.equal(localBackendUrl("::1",8799),"http://[::1]:8799");
  assert.equal(localBackendUrl("192.0.2.12",8799),"http://192.0.2.12:8799");
  assert.equal(canonicalOrigin("http://localhost:8799"),"http://127.0.0.1:8799");
  const directory=await mkdtemp(path.join(os.tmpdir(),"zane-mcp-generation-"));const file=path.join(directory,"marker.json");
  const generation=randomUUID();await atomicJson(file,{schemaVersion:1,generation,baseUrl:"http://localhost:61234",contractVersion:"test"});
  assert.equal((await readMcpGeneration(file,"http://127.0.0.1:61234"))?.generation,generation);
  assert.equal(await readMcpGeneration(file,"http://127.0.0.1:61235"),undefined);
});


test("Windows原子写入短暂占用时只重试同一替换，保留旧回执且清理临时文件", async t => {
  const directory = await temporaryDirectory(t), file = path.join(directory, "receipt.json"); await atomicJson(file, { revision: 1 });
  let attempts = 0; const delays: number[] = [];
  await atomicJson(file, { revision: 2 }, { platform: "win32", pause: async milliseconds => { delays.push(milliseconds); }, replace: async (from, to) => {
    assert.equal(String(to), file); assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { revision: 1 });
    if (++attempts < 4) throw Object.assign(new Error("temporary sharing violation"), { code: "EPERM" });
    await rename(from, to);
  } });
  assert.equal(attempts, 4); assert.deepEqual(delays, [25, 50, 100]); assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { revision: 2 }); assert.deepEqual(await readdir(directory), ["receipt.json"]);
});

test("原子替换重试有界，非Windows或永久错误不重试、不删除旧文件", async t => {
  const directory = await temporaryDirectory(t), file = path.join(directory, "receipt.json"); await atomicJson(file, { revision: 1 });
  for (const [platform, code, expected] of [["win32", "EPERM", 10], ["win32", "ENOSPC", 1], ["linux", "EPERM", 1]] as const) {
    let attempts = 0; await assert.rejects(atomicJson(file, { revision: 2 }, { platform, pause: async () => {}, replace: async () => { attempts++; throw Object.assign(new Error("replace failed"), { code }); } }), /replace failed/);
    assert.equal(attempts, expected); assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { revision: 1 }); assert.deepEqual(await readdir(directory), ["receipt.json"]);
  }
});
