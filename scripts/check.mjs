// Acceptance pipeline for `npm run check`, with the same gates and the same
// guarantees as the former serial chain, but without paying for the three fast
// static gates one after another.
//
// Former chain (serial):  typecheck && lint && docs:ai:check && test && build && test:smokes
//
// Dependencies that constrain the schedule:
//   - typecheck and build both invoke `tsc -b`, which writes the same
//     *.tsbuildinfo files, so they must not run concurrently.
//   - test:smokes loads dist-server, so it must run after build.
//   - test is source-only under tsx and does not read dist-server, but it does
//     launch HTTP servers plus stdio MCP/tsx children; the project deliberately
//     bounds its fan-out to keep startup budgets from CPU contention, so it is
//     kept serial with test:smokes rather than overlapped.
//
// Schedule: [typecheck | lint | docs:ai:check] -> test -> build -> test:smokes
//
// --fast stops after the static gates. That is the inner loop for editing
// (about 2s); it is a pre-flight check, NOT the acceptance gate. Only the full
// run satisfies the "npm run check passes" completion condition.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fast = process.argv.slice(2).includes("--fast");

// On Windows npm is a .cmd shim, which Node refuses to spawn without a shell.
// Passing the whole command as one string (instead of args + shell: true) keeps
// it working without triggering DEP0190.
const npmCommand = (script) => process.platform === "win32" ? `npm run ${script}` : null;
function spawnScript(script, stdio) {
  if (process.platform === "win32") return spawn(npmCommand(script), { cwd: root, stdio, shell: true });
  return spawn("npm", ["run", script], { cwd: root, stdio });
}

/** Run one npm script, streaming its output. Resolves to the exit code. */
function run(label, script) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnScript(script, "inherit");
    child.on("close", (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\n[${code === 0 ? "ok" : "FAIL"}] ${label} (${seconds}s)`);
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      console.error(`\n[FAIL] ${label}: ${error.message}`);
      resolve(1);
    });
  });
}

/**
 * Run independent gates concurrently, buffering their output so interleaved
 * logs stay readable. Output is printed only when a gate fails, or when
 * --verbose is passed.
 */
function runParallel(gates) {
  const verbose = process.argv.slice(2).includes("--verbose");
  return Promise.all(gates.map(({ label, script }) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawnScript(script, ["ignore", "pipe", "pipe"]);
    let output = "";
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      if (!ok || verbose) {
        console.log(`\n--- ${label} ${ok ? "output" : "failed"} (${seconds}s) ---\n${output.trimEnd()}\n--- end ${label} ---`);
      }
      console.log(`[${ok ? "ok" : "FAIL"}] ${label} (${seconds}s)`);
      resolve({ label, code: code ?? 1 });
    });
    child.on("error", (error) => {
      console.error(`[FAIL] ${label}: ${error.message}`);
      resolve({ label, code: 1 });
    });
  })));
}

const started = Date.now();
console.log(fast
  ? "Running static gates (typecheck | lint | docs:ai:check). This is a pre-flight check, not the acceptance gate.\n"
  : "Running acceptance pipeline: [typecheck | lint | docs:ai:check] -> test -> build -> test:smokes\n");

const staticGates = await runParallel([
  { label: "typecheck", script: "typecheck" },
  { label: "lint", script: "lint" },
  { label: "docs:ai:check", script: "docs:ai:check" },
]);
const failedStatic = staticGates.filter((gate) => gate.code !== 0);
if (failedStatic.length) {
  console.error(`\nStatic gates failed: ${failedStatic.map((gate) => gate.label).join(", ")}`);
  console.error(`Total ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(1);
}

if (fast) {
  console.log(`\nStatic gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s. Run ` + "`npm run check`" + " for the full acceptance pipeline.");
  process.exit(0);
}

for (const [label, script] of [["test", "test"], ["build", "build"], ["test:smokes", "test:smokes"]]) {
  const code = await run(label, script);
  if (code !== 0) {
    console.error(`\n${label} failed; stopping. Later gates were not run.`);
    console.error(`Total ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(1);
  }
}

console.log(`\nAll gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
