import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Keep esbuild's spilled temp files on the project's own volume.
//
// esbuild hands inputs larger than 1 MiB to its Go helper through a temp file,
// which the helper then removes. On this machine that removal fails on the C:
// volume and succeeds on F:, for every esbuild version tested (0.25.12 and
// 0.28.2), independent of file permissions or antivirus exclusions:
//
//   C:\...\Temp\esbuild-<hash>: Access is denied.
//
// The failure is specific to the esbuild helper process: plain Node and plain Go
// both create, read and delete the same >1 MiB files on C: without error, and the
// leaked file is deletable immediately after the call returns.
//
// `vite build` passes each rendered chunk (~1.6 MiB) to esbuild, so the web build
// failed every time. Pointing TEMP at the project volume fixes it: 4/4 consecutive
// builds and a full `npm run check` passed. .local/ is already gitignored.
const projectTemp = path.join(process.cwd(), ".local", "tmp");
try {
  mkdirSync(projectTemp, { recursive: true });
  process.env.TEMP = projectTemp;
  process.env.TMP = projectTemp;
} catch {
  // Fall back to the system default rather than failing the build.
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET ?? `http://127.0.0.1:${env.API_PORT ?? "8798"}`;
  const workbenchRelease = env.VITE_WORKBENCH_RELEASE?.trim() || env.ZANE_RELEASE_ID?.trim() || "unversioned";

  return {
    plugins: [react()],
    define: { __WORKBENCH_RELEASE__: JSON.stringify(workbenchRelease) },
    build: { outDir: env.DIST_DIR ?? "dist" },
    server: {
      host: env.VITE_DEV_HOST ?? "127.0.0.1",
      port: Number(env.VITE_DEV_PORT ?? 5174),
      proxy: {
        "/api": apiProxyTarget,
      },
    },
  };
});
