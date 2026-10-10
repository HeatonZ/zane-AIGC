import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Director-console ComfyUI workflow patch: bridge runtime voice references into the
 * Easy-Media editor through the generic `easy makeAudioList` node.
 *
 * The editor exposes a single AUDIO socket, while the workbench binds one audio per
 * reference. `easy makeAudioList` is an existing ComfyUI-Easy-Media primitive that turns
 * its audio1..audio10 inputs into one audio list, so the workbench can address every
 * voice reference by slot. No new node type, no ComfyUI source change, no adapter.
 *
 * Dry-run by default. --apply writes the workflow file. Never submits a run.
 */
const WORKFLOW = "Zane/MiniMaxH3-极简导演台+.json";
const WORKFLOW_PATH = path.resolve("D:/project/comfyui/new/ComfyUI/user/default/workflows", WORKFLOW);
const BACKUP_DIR = path.resolve("backups/comfyui-workflows");
const EDITOR_ID = 14;
const EDITOR_TYPE = "easy multiTrackEditor";
const AUDIO_LIST_TYPE = "easy makeAudioList";
const AUDIO_INPUT_INDEX = 2;
const AUDIO_SLOTS = ["audio1", "audio2", "audio3", "audio4", "audio5", "audio6", "audio7", "audio8", "audio9", "audio10"];

function audioListNode(id, slotLinks) {
  return {
    id,
    type: AUDIO_LIST_TYPE,
    pos: [1150, 2150],
    size: [280, 320],
    flags: {},
    order: 5,
    mode: 0,
    inputs: [
      { label: "skip_empty", localized_name: "跳过空输入", name: "skip_empty", type: "BOOLEAN", widget: { name: "skip_empty" }, link: null },
      ...AUDIO_SLOTS.map((name, index) => ({
        label: `音频 ${index + 1}`,
        localized_name: `音频 ${index + 1}`,
        name,
        shape: 7,
        type: "AUDIO",
        link: slotLinks[name] ?? null,
      })),
    ],
    outputs: [{ label: "音频列表", localized_name: "音频列表", name: "AUDIO", type: "AUDIO", links: [] }],
    properties: { "Node name for S&R": AUDIO_LIST_TYPE, cnr_id: "comfyui-easy-media", aux_id: "yolain/ComfyUI-Easy-Media" },
    title: "Make Audio List",
    widgets_values: [true],
    widgets_values_named: { skip_empty: true },
  };
}

function numeric(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : Number(value);
}

function patchDirectorConsoleWorkflow(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const links = (Array.isArray(workflow.links) ? workflow.links : []).filter((link) => Array.isArray(link));
  workflow.links = links;
  const editor = nodes.find((node) => numeric(node.id) === EDITOR_ID);
  if (!editor || editor.type !== EDITOR_TYPE) throw new Error(`导演台工作流必须包含 id 为 ${EDITOR_ID} 的 ${EDITOR_TYPE} 节点`);
  if (nodes.filter((node) => node.type === EDITOR_TYPE).length !== 1) throw new Error(`导演台工作流只能有一个 ${EDITOR_TYPE} 节点`);
  const audioInput = (Array.isArray(editor.inputs) ? editor.inputs : []).find((input) => input?.name === "audio");
  if (!audioInput) throw new Error(`编辑器节点 ${EDITOR_ID} 缺少 audio 输入`);
  if (audioInput.type !== "AUDIO") throw new Error(`编辑器节点 ${EDITOR_ID} 的 audio 输入类型已变为 ${audioInput.type}`);

  const notes = [];
  const existing = nodes.filter((node) => node.type === AUDIO_LIST_TYPE);
  if (existing.length > 1) throw new Error(`导演台工作流包含 ${existing.length} 个 ${AUDIO_LIST_TYPE} 节点，无法确定桥接目标`);
  let bridge = existing[0];
  if (!bridge) {
    const usedNodeIds = new Set(nodes.map((node) => numeric(node.id)));
    let nodeId = Math.max(0, ...usedNodeIds) + 1;
    while (usedNodeIds.has(nodeId)) nodeId += 1;
    bridge = audioListNode(nodeId, {});
    nodes.push(bridge);
    workflow.last_node_id = Math.max(numeric(workflow.last_node_id) || 0, nodeId);
    notes.push(`已插入通用音频列表节点 ${nodeId}`);
  }

  const output = (Array.isArray(bridge.outputs) ? bridge.outputs : []).find((entry) => entry?.name === "AUDIO");
  if (!output) throw new Error(`音频列表节点 ${bridge.id} 缺少 AUDIO 输出`);

  if (audioInput.link !== null && audioInput.link !== undefined) {
    const link = links.find((entry) => numeric(entry[0]) === numeric(audioInput.link));
    if (!link) throw new Error(`编辑器 audio 输入的 link ${audioInput.link} 已失效，请先在 ComfyUI 中重连`);
    if (numeric(link[1]) !== numeric(bridge.id) || numeric(link[3]) !== EDITOR_ID) throw new Error(`编辑器 audio 输入已连接到节点 ${link[1]}，不是通用音频列表桥接节点`);
    if (!output.links?.includes(numeric(audioInput.link))) output.links = [...new Set([...(output.links ?? []), numeric(audioInput.link)])];
    notes.push("audio 链接已存在");
    return { changed: false, bridgeId: numeric(bridge.id), linkId: numeric(audioInput.link), notes };
  }

  const usedLinkIds = new Set(links.map((entry) => numeric(entry[0])));
  let linkId = Math.max(0, ...usedLinkIds) + 1;
  while (usedLinkIds.has(linkId)) linkId += 1;
  links.push([linkId, numeric(bridge.id), 0, EDITOR_ID, AUDIO_INPUT_INDEX, "AUDIO"]);
  audioInput.link = linkId;
  output.links = [linkId];
  workflow.last_link_id = Math.max(numeric(workflow.last_link_id) || 0, linkId);
  workflow.last_node_id = Math.max(numeric(workflow.last_node_id) || 0, ...nodes.map((node) => numeric(node.id)));
  notes.push(`已把音频列表节点 ${bridge.id} 连到编辑器 ${EDITOR_ID} 的 audio 输入`);
  return { changed: true, bridgeId: numeric(bridge.id), linkId, notes };
}

export async function main(args = process.argv.slice(2)) {
  const apply = args.includes("--apply");
  const original = await readFile(WORKFLOW_PATH, "utf8");
  const workflow = JSON.parse(original);
  const probe = patchDirectorConsoleWorkflow(structuredClone(workflow));
  const patched = structuredClone(workflow);
  const patch = patchDirectorConsoleWorkflow(patched);
  const report = {
    format: "zane-director-console-comfyui-patch/v1",
    workflowFile: WORKFLOW,
    apply,
    changed: patch.changed,
    stable: probe.changed === patch.changed && probe.linkId === patch.linkId,
    nodeCount: [workflow.nodes.length, patched.nodes.length],
    linkCount: [workflow.links.length, patched.links.length],
    bridgeNodeId: patch.bridgeId,
    linkId: patch.linkId,
    notes: patch.notes,
    comfyGraphsModified: false,
    modelJobsSubmitted: 0,
  };
  if (apply) {
    await mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(BACKUP_DIR, `MiniMaxH3-director-console-${stamp}.json`);
    await copyFile(WORKFLOW_PATH, backup);
    await writeFile(WORKFLOW_PATH, `${JSON.stringify(patched, null, 2)}\n`, "utf8");
    report.backup = backup;
    report.comfyGraphsModified = true;
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main().catch((error) => { console.error(error); process.exitCode = 1; });
