import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ExecutorRegistry } from "../execution/executorRegistry.js";
import type { CapabilityFactory, CapabilityRuntime } from "./package.js";
/** One package module is the extension unit. Dev loads .ts; the build loads the corresponding .js files. */
export async function loadCapabilityPackages(runtime: CapabilityRuntime, directory: URL | string = new URL("./packages/", import.meta.url)) {
  const registry = new ExecutorRegistry();
  const files = (await readdir(directory)).filter((name) => /\.(?:js|ts)$/.test(name) && !/\.(?:test|d)\.(?:ts|js)$/.test(name)).sort();
  for (const filename of files) {
    const url = directory instanceof URL ? new URL(filename, directory) : pathToFileURL(path.resolve(directory, filename));
    const module = await import(url.href) as { default?: CapabilityFactory };
    if (typeof module.default !== "function") throw new Error("能力包缺少 default 工厂：" + filename);
    const result = await module.default(runtime);
    for (const capability of Array.isArray(result) ? result : [result]) registry.registerCapability(capability);
  }
  return registry;
}
