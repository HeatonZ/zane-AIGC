import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ClipboardPaste, FileDown, FileUp, Layers, ListChecks, Plus, RefreshCw, RotateCcw, Trash2, Wand2, X } from "lucide-react";
import { AccessApiError, accessApi } from "../lib/accessApi";
import { cancelTask, confirmTask, createTask, deleteTask, getTask, isActiveTask, isEditableTask, listTasks, rerunTaskItem, taskItemStateLabels, taskStatusLabels, updateTask, type Task, type TaskItemInput } from "../lib/taskApi";
import { cleanTaskItemInputs, parseTaskItemsPaste, PasteImportError } from "../lib/taskImport";
import { buildTaskTemplateCsv, parseTaskItemsCsv, serializeTaskItemsCsv, toCsvFieldSpec, type CsvSceneSpec } from "../lib/taskCsv";
import { applyExampleValues, contractState, isMediaField, isMultipleMedia, mediaKindOf, prefillInputValues, rowBlockReason, rowMissingInputs, rowsOfTaskItems } from "../lib/taskInput";
import { AssetPickerDialog } from "../components/AssetBrowser";
import ObjectArrayInput from "../components/ObjectArrayInput";
import { mediaInputLabel, mediaItemsOf, removeMediaInputValue } from "../lib/mediaInput";
import type { JsonValue, WorkflowInputField } from "../types";

interface SceneChoice { sceneId: string; title: string; versionId: string }

/** 发布版输入契约：任务页必须用服务端同一份默认值/示例/必填，不自己再猜。 */
interface InputRequirement { key: string; label?: string; required: boolean; hidden: boolean; needsValue: boolean; options?: string[]; inputMode?: "object_array"; itemFields?: WorkflowInputField["itemFields"] }
interface PublishedContract {
  fields: WorkflowInputField[];
  titles: Record<string, string>;
  example?: Record<string, JsonValue>;
  missingRequiredInputs: string[];
  needsValue: string[];
  /** 读取失败的原因。缓存失败结果，避免表格永远停在「正在读取」而看不出真实原因。 */
  error?: string;
}
const EMPTY_CONTRACT: PublishedContract = { fields: [], titles: {}, missingRequiredInputs: [], needsValue: [] };

/** 已发布场景目录：任务项只能引用发布版，草稿不作为可执行目标。 */
async function loadSceneChoices(): Promise<SceneChoice[]> {
  const page = await accessApi<{ scenes: Array<{ sceneId: string; title: string; publishedVersionId?: string | null }> }>("/api/v1/scenes?limit=200", { cache: "no-store" });
  return page.scenes.filter(scene => Boolean(scene.publishedVersionId)).map(scene => ({ sceneId: scene.sceneId, title: scene.title, versionId: scene.publishedVersionId! }));
}

/** 每行按该场景的发布版默认值起步，而不是空对象——否则表里看不出服务端会用什么。 */
function emptyRow(scene: SceneChoice | undefined, contract?: PublishedContract): TaskItemInput {
  return { label: "", sceneId: scene?.sceneId ?? "", versionId: scene?.versionId ?? "", inputValues: contract ? prefillInputValues(contract.fields) : {} };
}

export default function Tasks({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [total, setTotal] = useState(0);
  const [scenes, setScenes] = useState<SceneChoice[]>([]);
  const [selected, setSelected] = useState<Task>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // 新建表单：先创建中间态草稿，确认前可反复编辑。
  const [taskId, setTaskId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<TaskItemInput[]>([]);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [activeSceneId, setActiveSceneId] = useState("");
  /** CSV 模板默认行数：几十行是常见批量，给个合理起点又允许调整。 */
  const [templateRows, setTemplateRows] = useState(10);
  /** 正在为哪一行的哪个媒体字段选素材；null 表示没有打开选择器。 */
  const [pickingMedia, setPickingMedia] = useState<{ index: number; key: string; kind: "image" | "video" | "audio"; multiple: boolean } | null>(null);
  const pollRef = useRef<number | undefined>(undefined);
  /** 契约的同步镜像：ensureContract 需要在不依赖重渲染的情况下读到已缓存值。 */
  const contractsRef = useRef<Record<string, PublishedContract>>({});

  const activeScene = useMemo(() => scenes.find(scene => scene.sceneId === activeSceneId), [scenes, activeSceneId]);

  const load = useCallback(async (next?: string) => {
    try {
      const page = await listTasks(next ? { cursor: next } : {});
      setTasks(current => next ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
      setTotal(page.total ?? page.items.length);
    } catch (reason) { setError((reason as Error).message); }
  }, []);
  const refreshSelected = useCallback(async (id: string) => {
    try { setSelected(await getTask(id)); }
    catch (reason) {
      // 任务被删除后详情 404：清空选中而不是保留过期快照。
      if (reason instanceof AccessApiError && reason.status === 404) setSelected(undefined);
      else setError((reason as Error).message);
    }
  }, []);

  // 每个出现过的场景都要有自己的发布版输入契约：行可以指向不同场景，
  // 只加载「默认场景」会让其他行无法填写。按 sceneId+versionId 缓存，避免重复请求。
  const [contracts, setContracts] = useState<Record<string, PublishedContract>>({});
  /** 缓存「进行中」的 promise 而不是一个 Set：并发调用同一个契约时必须一起等结果，
   *  否则后到的调用会拿到 EMPTY_CONTRACT，导出/导入就会静默少列。 */
  const pendingContracts = useRef(new Map<string, Promise<PublishedContract>>());
  const contractKey = (sceneId: string, versionId: string) => sceneId + "@" + versionId;
  const ensureContract = useCallback((sceneId: string, versionId: string): Promise<PublishedContract> => {
    const key = contractKey(sceneId, versionId);
    const cached = contractsRef.current[key];
    if (cached) return Promise.resolve(cached);
    const inflight = pendingContracts.current.get(key);
    if (inflight) return inflight;
    const request = (async () => {
      let contract: PublishedContract;
      try {
        const envelope = await accessApi<{ workflow?: { inputs?: WorkflowInputField[] }; inputSchema?: { properties?: Record<string, { title?: string }> }; inputRequirements?: InputRequirement[]; inputExamples?: Array<{ inputValues?: Record<string, JsonValue> }>; missingRequiredInputs?: string[] }>(
          "/api/v1/scenes/" + encodeURIComponent(sceneId) + "?versionId=" + encodeURIComponent(versionId), { cache: "no-store" });
        const fields = envelope.workflow?.inputs ?? [];
        const requirements = envelope.inputRequirements ?? [];
        contract = {
          fields,
          titles: Object.fromEntries(Object.entries(envelope.inputSchema?.properties ?? {}).map(([fieldKey, value]) => [fieldKey, value.title ?? fieldKey])),
          example: envelope.inputExamples?.[0]?.inputValues,
          missingRequiredInputs: envelope.missingRequiredInputs ?? [],
          // needsValue 是服务端算好的「必填但没默认值」，比前端自己推更准。
          needsValue: requirements.filter(item => item.needsValue).map(item => item.key),
        };
      } catch (reason) {
        // 失败也要落进缓存：否则表格一直显示「正在读取」，用户只能反复刷新。
        contract = { ...EMPTY_CONTRACT, error: reason instanceof Error ? reason.message : "读取发布版输入契约失败" };
      } finally { pendingContracts.current.delete(key); }
      contractsRef.current = { ...contractsRef.current, [key]: contract };
      setContracts(contractsRef.current);
      return contract;
    })();
    pendingContracts.current.set(key, request);
    return request;
  }, []);
  /** 所有已发布场景的契约都要就位：CSV 表头是跨场景列的并集，缺一个就会少列。 */
  const ensureAllContracts = useCallback(async () => {
    await Promise.all(scenes.map(scene => ensureContract(scene.sceneId, scene.versionId)));
  }, [scenes, ensureContract]);

  /**
   * 丢弃读取失败的缓存并重读。失败结果被缓存是为了让表格显示真实原因，
   * 但它不能变成永久状态——重试必须真的丢掉旧结果，否则点多少次都还是同一个错误。
   */
  const retryFailedContracts = useCallback(async () => {
    const failedKeys = Object.entries(contractsRef.current).filter(([, contract]) => contract.error).map(([key]) => key);
    if (!failedKeys.length) return;
    contractsRef.current = Object.fromEntries(Object.entries(contractsRef.current).filter(([key]) => !failedKeys.includes(key)));
    setContracts(contractsRef.current);
    await Promise.all(scenes.map(scene => ensureContract(scene.sceneId, scene.versionId)));
  }, [scenes, ensureContract]);

  useEffect(() => {
    void (async () => {
      try {
        const choices = await loadSceneChoices();
        setScenes(choices);
        const first = choices[0];
        setActiveSceneId(current => current || first?.sceneId || "");
        // 第一行直接带出发布版默认值，让人一眼看到服务端会用什么。
        const contract = first ? await ensureContract(first.sceneId, first.versionId) : EMPTY_CONTRACT;
        setRows(current => current.length ? current : [emptyRow(first, contract)]);
      } catch (reason) { setError((reason as Error).message); }
    })();
    void load();
  }, [load, ensureContract]);

  // 默认场景切换时，把新场景的契约准备好（表格要按它的字段渲染）。
  useEffect(() => { if (activeScene) void ensureContract(activeScene.sceneId, activeScene.versionId); }, [activeScene, ensureContract]);

  const activeKey = activeScene ? contractKey(activeScene.sceneId, activeScene.versionId) : "";
  const activeContract = (activeKey ? contracts[activeKey] : undefined) ?? EMPTY_CONTRACT;

  // 有未结束的项时轮询：进度来自运行状态投影，刷新即最新，不额外维护本地状态机。
  useEffect(() => {
    if (!selected || !isActiveTask(selected.status)) { if (pollRef.current) window.clearTimeout(pollRef.current); pollRef.current = undefined; return; }
    pollRef.current = window.setTimeout(() => { void refreshSelected(selected.taskId); }, 2500);
    return () => { if (pollRef.current) window.clearTimeout(pollRef.current); };
  }, [selected, refreshSelected]);

  async function attempt(action: () => Promise<void>, fallback: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : fallback); }
    finally { setBusy(false); }
  }

  /**
   * 确认接口只发 revision，提交的是服务端已冻结的任务项——form 里的改动不会被带上。
   * 所以草稿上「改了没保存就点确认」会静默丢掉改动并按旧输入付费提交；这里显式跟踪脏状态，
   * 确认前先落盘，避免这类静默数据丢失。
   */
  const [dirty, setDirty] = useState(false);
  // rowErrors 按行下标存，行增删/内容变化后下标会错位；统一走 changeRows 清理，
  // 避免遗漏。逐行缺项提示本身由 rowGaps 实时渲染，不依赖这份快照。
  function changeRows(update: (current: TaskItemInput[]) => TaskItemInput[]) { setRowErrors({}); setDirty(true); setRows(update); }
  function setRow(index: number, patch: Partial<TaskItemInput>) { changeRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row)); }
  /** value 为 undefined 表示「沿用发布版默认值」：直接移除该键，而不是提交显式 null。 */
  function setRowInput(index: number, key: string, value: JsonValue | undefined) {
    changeRows(current => current.map((row, at) => {
      if (at !== index) return row;
      const inputValues = { ...row.inputValues };
      if (value === undefined) delete inputValues[key]; else inputValues[key] = value;
      return { ...row, inputValues };
    }));
  }
  /** 空键/空值不提交：避免把表单里没填的字段当成显式 null 覆盖发布版默认值。 */
  function cleanedItems(): TaskItemInput[] { return cleanTaskItemInputs(rows); }

  /** 切换某一行的场景：换成该场景发布版的默认值，而不是把上一个场景的输入带过去。 */
  async function selectRowScene(index: number, sceneId: string) {
    const scene = scenes.find(candidate => candidate.sceneId === sceneId);
    if (!scene) { setRow(index, { sceneId: "", versionId: "", inputValues: {} }); return; }
    const contract = await ensureContract(scene.sceneId, scene.versionId);
    setRow(index, { sceneId: scene.sceneId, versionId: scene.versionId, inputValues: prefillInputValues(contract.fields) });
  }
  /** 一键把服务端给的 inputExamples 填进这一行，省掉逐字段抄默认值。 */
  async function fillRowFromExample(index: number) {
    const row = rows[index];
    const scene = scenes.find(candidate => candidate.sceneId === row?.sceneId);
    if (!scene) return;
    const contract = await ensureContract(scene.sceneId, scene.versionId);
    const example = applyExampleValues(contract.fields, contract.example);
    if (!Object.keys(example).length) { setNotice("该发布版没有可填充的示例值（必填项多为媒体，需要从素材库选择）。"); return; }
    // 示例只补「当前没填」的键，不覆盖已经手工填过的值。
    changeRows(current => current.map((item, at) => at === index ? { ...item, inputValues: { ...example, ...item.inputValues } } : item));
    setNotice("已按发布版示例填充第 " + (index + 1) + " 项（不覆盖已填写的值）。");
  }
  /** 这一行还差什么：创建/确认前直接说清楚，不用等服务端逐个报错。 */
  function rowGaps(row: TaskItemInput): string[] {
    const scene = scenes.find(candidate => candidate.sceneId === row.sceneId);
    const key = scene ? contractKey(scene.sceneId, scene.versionId) : "";
    const contract = (key ? contracts[key] : undefined) ?? EMPTY_CONTRACT;
    if (!contract.fields.length) return [];
    // 以服务端 needsValue 为准，隐藏字段不参与提示。
    return rowMissingInputs(contract.fields, row.inputValues, { hiddenKeys: contract.fields.filter(field => field.hidden).map(field => field.key), needsValueKeys: contract.needsValue });
  }
  function applyPaste() {
    setRowErrors({});
    try {
      const imported = parseTaskItemsPaste(paste, { defaultSceneId: activeScene?.sceneId ?? "", defaultVersionId: activeScene?.versionId ?? "", knownSceneIds: scenes.map(scene => scene.sceneId) });
      changeRows(() => imported as TaskItemInput[]);
      // 导入的行可能引用尚未加载契约的场景，先补齐，否则字段无法渲染。
      for (const scene of scenes) if (imported.some(item => item.sceneId === scene.sceneId)) void ensureContract(scene.sceneId, scene.versionId);
      setShowPaste(false);
      setNotice("已导入 " + imported.length + " 项，请核对后创建任务");
    } catch (reason) {
      setError(reason instanceof PasteImportError ? reason.message : "粘贴内容无法解析");
    }
  }

  /**
   * 把已加载的发布版契约转成 CSV 列规格。模板/导出都基于它，
   * 所以「表里有哪一列」和「服务端要哪些输入」永远来自同一份契约，不会各写一遍。
   * 走 contractsRef 而不是 contracts：exportTemplate 里 await ensureContract 之后
   * 同一次闭包中的 state 还是旧值，读 state 会得到空列。
   */
  function csvScenes(): CsvSceneSpec[] {
    return scenes.map(scene => {
      const contract = contractsRef.current[contractKey(scene.sceneId, scene.versionId)];
      return {
        sceneId: scene.sceneId,
        versionId: scene.versionId,
        title: scene.title,
        // 字段 → 列规格的映射放在 taskCsv 里单测，避免这里漏掉某个约束。
        fields: (contract?.fields ?? []).map(field => toCsvFieldSpec(field, contract?.titles[field.key])),
      };
    });
  }
  /** 下载：用 Blob + BOM 写 UTF-8，Excel 打开中文不乱码。 */
  function downloadCsv(filename: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    // 立刻回收，避免几十次导出后堆积 Blob。
    URL.revokeObjectURL(url);
  }
  /**
   * 导出模板。只给「当前选定场景」的列：把所有已发布场景的字段并起来会写进几十个
   * 当前用不到的列，表格根本没法填。所以这里只备齐这一个场景的契约，不做 ensureAllContracts。
   */
  async function exportTemplate(sceneId: string, rowCount: number) {
    await attempt(async () => {
      const scene = scenes.find(candidate => candidate.sceneId === sceneId);
      if (!scene) throw new Error("请先选择场景，再导出模板");
      await ensureContract(scene.sceneId, scene.versionId);
      const contract = contractsRef.current[contractKey(scene.sceneId, scene.versionId)];
      const spec: CsvSceneSpec = { sceneId: scene.sceneId, versionId: scene.versionId, title: scene.title, fields: (contract?.fields ?? []).map(field => toCsvFieldSpec(field, contract?.titles[field.key])) };
      const csv = buildTaskTemplateCsv({ scenes: [spec], sceneId: scene.sceneId, rowCount });
      downloadCsv("任务模板-" + scene.title + ".csv", csv);
      setNotice("已下载模板：" + rowCount + " 行，仅含「" + scene.title + "」的输入列（" + spec.fields.length + " 列）。媒体列留空，请从素材库复制固定版本引用（{\"assetId\":\"…\",\"assetVersion\":N}）填进去。");
    }, "模板导出失败");
  }
  /** 导出当前表格里已填的内容，便于存档或在 Excel 里批量改完再导回。列只取这些行用到的场景。 */
  function exportCurrent() {
    try {
      const csv = serializeTaskItemsCsv(cleanedItems() as Array<{ label?: string; sceneId: string; versionId: string; inputValues?: Record<string, JsonValue> }>, csvScenes());
      downloadCsv("任务项-" + (name.trim() || taskId.slice(0, 8)) + ".csv", csv);
      setNotice("已导出 " + rows.length + " 项；改完可用「导入 CSV」原样导回。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导出失败"); }
  }
  /** 导入 CSV：整表替换任务项，与粘贴导入语义一致。 */
  async function importCsv(file: File) {
    await attempt(async () => {
      const text = await file.text();
      // 导入要按列名匹配字段，契约不齐会误判成「不是该场景的输入字段」。
      await ensureAllContracts();
      const imported = parseTaskItemsCsv(text, {
        scenes: csvScenes(),
        defaultSceneId: activeScene?.sceneId ?? "",
        defaultVersionId: activeScene?.versionId ?? "",
      });
      changeRows(() => imported as TaskItemInput[]);
      // 导入的行可能引用尚未加载契约的场景，先补齐，否则字段渲染不出来。
      for (const scene of scenes) if (imported.some(item => item.sceneId === scene.sceneId)) void ensureContract(scene.sceneId, scene.versionId);
      if (!name.trim()) setName(file.name.replace(/\.csv$/i, ""));
      setNotice("已从 CSV 导入 " + imported.length + " 项，请核对后创建任务。");
    }, "CSV 导入失败");
  }

  /**
   * 提交前把本地已知的缺项按行标出并拦下：服务端报错是「第 N 项（label）：…」，
   * 但几十行时用户还得自己数行号；这里直接标在对应行上，也省掉一次服务器往返。
   * 只拦「本地能确定」的缺项——服务端仍会按发布快照复核，这里不替代服务端校验。
   *
   * requireInputs 区分两个动作：保存草稿只拦结构性缺项（没选场景、契约还没读出），
   * 必填留到确认提交前才拦——「一个项目连续出几十张图」时先存进度、后补素材是常态，
   * 存草稿不该因为还没挑图就被拦住。
   */
  function localBlockers(requireInputs: boolean, action: string): boolean {
    const found: Record<number, string> = {};
    rows.forEach((row, index) => {
      // 契约没读出来时 rowGaps 会是空的，看起来「不需要输入」；不能把读取失败当成没有必填项，
      // 否则会拿一份用户根本没看过的输入去保存。这里明确拦下并要求重试。
      const scene = scenes.find(candidate => candidate.sceneId === row.sceneId);
      const contract = scene ? contracts[contractKey(scene.sceneId, scene.versionId)] : undefined;
      if (scene && !contract) { found[index] = "正在读取该发布版的输入契约，请稍候再试。"; return; }
      if (contract?.error) { found[index] = "读取该发布版的输入契约失败：" + contract.error + "；请点「刷新任务」重试。"; return; }
      const reason = rowBlockReason(row, rowGaps(row), { requireInputs });
      if (reason) found[index] = reason;
    });
    setRowErrors(found);
    const blocked = Object.keys(found);
    if (blocked.length) {
      setNotice("");
      setError("有 " + blocked.length + " 项还不能" + action + "，已在对应行标出；按行内提示处理后继续。");
      return true;
    }
    return false;
  }

  async function submitCreate() {
    if (localBlockers(false, "保存")) return;
    await attempt(async () => {
      const task = await createTask({ taskId, name: name.trim(), ...(note.trim() ? { note: note.trim() } : {}), items: cleanedItems() });
      setTaskId(crypto.randomUUID());
      setName(task.name); setNote(task.note ?? "");
      // 用服务端回执里的项回填表格，而不是重置成一行默认值：
      // 创建后仍是可编辑草稿、表格直接进入编辑态，重置会让人以为刚填的内容被丢掉了。
      // 回执里的 inputValues 是「发布版默认值 + 用户输入」合并后的结果，与服务端实际执行一致。
      changeRows(() => rowsOfTaskItems(task.items ?? []));
      // 「添加一项」用的默认场景跟随刚创建的任务，而不是停留在模板下拉上。
      if (task.items?.length) setActiveSceneId(task.items[0].sceneId);
      // 这次改动已经落库，且表格内容就是服务端快照；不清脏标记会误判成「有未保存修改」而拦住确认。
      setDirty(false);
      setSelected(task);
      setNotice("任务已创建为待确认草稿（缺必填的项已一并保存，确认前补齐即可）；确认后才会批量提交运行。下面显示的是服务端已保存的 " + (task.itemCount || 0) + " 项输入。");
      await load();
    }, "任务创建失败");
  }
  async function saveEdit() {
    if (!selected) return;
    if (localBlockers(false, "保存")) return;
    await attempt(async () => {
      // 用表单状态而不是 selected.name：输入框改的是本地状态，selected 还是打开时的旧快照。
      const task = await updateTask(selected.taskId, { revision: selected.revision, name: name.trim(), note: note.trim(), items: cleanedItems() });
      setSelected(task); setDirty(false); setNotice("已保存到服务端 · r" + task.revision); await load();
    }, "任务保存失败");
  }
  async function confirm() {
    if (!selected) return;
    // 草稿上有未保存的改动时先落盘：confirm 不带 items，直接确认会静默丢弃这些改动
    // 并按服务端旧输入批量提交（付费）。这里不静默替用户决定，而是明确要求先保存。
    if (editable && dirty) {
      setNotice("");
      setError("有未保存的修改。确认提交的是服务端已保存的任务项，请先点「保存修改」，否则这些改动不会生效。");
      return;
    }
    // 保存草稿不校验必填，确认必须校验：服务端同样会在冻结前整体判一次并拒绝，
    // 这里先在对应行标出来，省掉一次往返。
    if (editable && localBlockers(true, "确认提交")) return;
    await attempt(async () => {
      // 响应丢失时用同一 taskId 重新确认即可对账；alreadyConfirmed 说明没有重复提交。
      const result = await confirmTask(selected.taskId, selected.revision);
      setSelected(result.task);
      setNotice(result.alreadyConfirmed
        ? "这次调用没有重复提交，已按原任务对账。"
        : "已提交 " + result.submitted.length + " 项" + (result.failures.length ? "，" + result.failures.length + " 项失败，可单项重跑。" : "。"));
      await load();
    }, "确认失败");
  }
  async function rerun(itemId: string) {
    if (!selected) return;
    await attempt(async () => { setSelected(await rerunTaskItem(selected.taskId, itemId, selected.revision)); setNotice("已重跑该任务项；旧运行记录保留在历史里。"); await load(); }, "重跑失败");
  }
  async function cancel() {
    if (!selected) return;
    await attempt(async () => { setSelected(await cancelTask(selected.taskId, selected.revision)); setNotice("任务已取消；已完成的项保留结果。"); await load(); }, "取消失败");
  }
  async function remove() {
    if (!selected) return;
    await attempt(async () => {
      await deleteTask(selected.taskId, selected.revision);
      setSelected(undefined); setNotice("任务记录已删除；历史运行、媒体和素材仍然保留。"); await load();
    }, "删除失败");
  }

  function openEditor(task: Task) {
    setSelected(task);
    setName(task.name); setNote(task.note ?? "");
    changeRows(() => rowsOfTaskItems(task.items ?? []));
    // 刚载入的就是服务端快照，此时没有未保存改动。
    setDirty(false);
    if (task.items?.length) setActiveSceneId(task.items[0].sceneId);
    // 草稿的每项可能指向不同场景：补齐各自的发布版契约，否则字段渲染不出来。
    for (const scene of scenes) if ((task.items ?? []).some(item => item.sceneId === scene.sceneId)) void ensureContract(scene.sceneId, scene.versionId);
  }
  /** 打开一个任务：待确认的草稿连表格一起载入继续编辑，已确认的只读跟踪。 */
  async function openTask(taskId: string) {
    setError("");
    try {
      const task = await getTask(taskId);
      if (task.status === "draft") openEditor(task); else setSelected(task);
    } catch (reason) { setError((reason as Error).message); }
  }

  const editable = isEditableTask(selected);
  /**
   * 可编辑的任务项表格。新建和「确认前的草稿」共用同一份：草稿打开后要能继续改输入，
   * 否则「确认前可反复编辑」只体现在接口上、页面上做不到。
   */
  const itemsTable = (
    <table className="task-table">
      <thead><tr><th>名称</th><th>场景 / 发布版</th><th>输入</th><th /></tr></thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <td><input className="text-input" aria-label={"第 " + (index + 1) + " 项名称"} value={row.label ?? ""} placeholder={"第 " + (index + 1) + " 项"} onChange={event => setRow(index, { label: event.target.value })} /></td>
            <td>
              <select className="text-input" aria-label={"第 " + (index + 1) + " 项场景"} value={row.sceneId} onChange={event => void selectRowScene(index, event.target.value)}>
                <option value="">选择场景</option>
                {scenes.map(scene => <option key={scene.sceneId} value={scene.sceneId}>{scene.title}</option>)}
              </select>
              <small>{row.versionId || "未固定发布版"}</small>
            </td>
            <td>
              {(() => {
                const scene = scenes.find(candidate => candidate.sceneId === row.sceneId);
                const key = scene ? contractKey(scene.sceneId, scene.versionId) : "";
                const cached = key ? contracts[key] : undefined;
                const state = contractState({ hasScene: Boolean(scene), ...(cached ? { contract: cached } : {}) });
                // 没有输入字段的发布版是合法配置：必须明确说「无需填写」并放行，
                // 不能一直显示「正在读取」——那看起来就是页面卡住了，创建按钮也点不了。
                if (state.phase === "no_scene") return <small>请先选择场景。</small>;
                if (state.phase === "loading") return <small>正在读取该发布版的输入契约…</small>;
                if (state.phase === "failed") return <small className="task-item-error">读取该发布版的输入契约失败：{state.error}；请点「刷新任务」重试。</small>;
                if (state.phase === "empty") return <small className="access-muted">该发布版没有输入字段，这一项直接提交即可。</small>;
                const contract = state.contract;
                const gaps = rowGaps(row);
                return <>
                  <div className="task-fields">
                    {contract.fields.filter(field => !field.hidden).map(field => (
                      <label className="task-field" key={field.key}>
                        <span>{contract.titles[field.key] || field.label || field.key}{field.required ? " *" : ""}</span>
                        {isMediaField(field)
                          // 媒体输入用管理端素材库选择器（与 Studio 一致）：几十行时手写 assetId/assetVersion 的 JSON 根本填不动。
                          ? <span className="task-media-field">
                              <button type="button" className="text-button" disabled={busy} onClick={() => setPickingMedia({ index, key: field.key, kind: mediaKindOf(field), multiple: isMultipleMedia(field) })}>从素材库选择</button>
                              <span className="task-media-list">
                                {mediaItemsOf(row.inputValues[field.key]).length
                                  ? mediaItemsOf(row.inputValues[field.key]).map((item, at) => <span className="task-media-item" key={at}>
                                      {mediaInputLabel(item, contract.titles[field.key] || field.key)}
                                      <button type="button" className="text-button" aria-label={"移除 " + mediaInputLabel(item)} onClick={() => setRowInput(index, field.key, removeMediaInputValue(mediaItemsOf(row.inputValues[field.key]), at) as unknown as JsonValue)}>移除</button>
                                    </span>)
                                  : <small className="access-muted">必填媒体需要选择固定版本素材。</small>}
                              </span>
                            </span>
                          : field.inputMode === "object_array"
                            ? <ObjectArrayInput field={field} value={row.inputValues[field.key]} onChange={value => setRowInput(index, field.key, value)} />
                            : field.type === "boolean"
                            // 布尔用三态选择：未勾选的复选框无法区分「显式 false」和「沿用发布版默认值」，
                            // 必填布尔没有默认值时就会永远提交不上去。
                            ? <select className="text-input" aria-label={field.key} value={row.inputValues[field.key] === undefined ? "" : String(row.inputValues[field.key])} onChange={event => setRowInput(index, field.key, event.target.value === "" ? undefined : event.target.value === "true")}><option value="">（使用发布版默认值）</option><option value="true">是</option><option value="false">否</option></select>
                            : field.type === "select"
                              ? <select className="text-input" aria-label={field.key} value={String(row.inputValues[field.key] ?? "")} onChange={event => setRowInput(index, field.key, event.target.value === "" ? undefined : event.target.value)}><option value="">（使用发布版默认值）</option>{(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}</select>
                              : field.type === "textarea" || field.type === "json"
                                ? <textarea className="text-input" rows={2} aria-label={field.key} value={typeof row.inputValues[field.key] === "string" ? String(row.inputValues[field.key]) : row.inputValues[field.key] === undefined ? "" : JSON.stringify(row.inputValues[field.key])} placeholder={field.placeholder} onChange={event => setRowInput(index, field.key, event.target.value === "" ? undefined : event.target.value)} />
                                : <input className="text-input" aria-label={field.key} value={String(row.inputValues[field.key] ?? "")} placeholder={field.placeholder} onChange={event => setRowInput(index, field.key, field.type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value)} />}
                      </label>
                    ))}
                  </div>
                  <div className="access-inline">
                    <button type="button" className="text-button" onClick={() => void fillRowFromExample(index)} disabled={busy}><Wand2 size={13} />按发布版示例填充</button>
                  </div>
                  {gaps.length > 0 ? <small className="task-item-error">还缺必填：{gaps.join("、")}</small> : <small className="access-muted">必填项已齐。</small>}
                </>;
              })()}
              {rowErrors[index] && <small className="task-item-error">{rowErrors[index]}</small>}
            </td>
            <td>
              <button className="button button-small" onClick={() => changeRows(current => current.filter((_, at) => at !== index))} disabled={busy || rows.length <= 1} aria-label={"删除第 " + (index + 1) + " 项"}><Trash2 size={13} /></button>
              {/* 深拷贝再清空名称：共享 inputValues 引用时，下游任何原地修改都会连带改到原件。 */}
              <button className="button button-small" onClick={() => changeRows(current => [...current.slice(0, index + 1), { ...structuredClone(current[index]), label: "" }, ...current.slice(index + 1)])} disabled={busy} aria-label={"复制第 " + (index + 1) + " 项"} title="复制这一项（含已填输入），便于连续出几十张">复制</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );  const itemCount = rows.length;
  // 缺少必填输入的行数：创建前就让人看到，而不是等确认提交后被服务端逐项拒绝。
  const gapCount = rows.filter(row => row.sceneId && rowGaps(row).length > 0).length;

  return (
    <div className="access-stack">
      <header className="access-heading">
        <div><h1>任务</h1><p>一个任务包含多个任务项，每项各自指定已发布场景与输入；确认后全自动批量提交，进度按运行状态汇总。适合「一个项目连续出几十张图」而不必塞进一个场景。</p></div>
        <button className="button button-outline" onClick={() => void attempt(async () => { await retryFailedContracts(); await load(); }, "刷新失败")} disabled={busy}><RefreshCw size={15} />刷新任务</button>
      </header>
      {/* 用法步骤：任务是个新概念，不写清楚只能靠猜。 */}
      <ol className="task-steps">
        <li><strong>1 添加项</strong>：点「添加一项」或「粘贴导入」（从表格里一次粘几十行）。</li>
        <li><strong>2 每项选场景</strong>：可在同一任务里混用多个场景，各选自己的发布版。</li>
        <li><strong>3 填输入</strong>：默认值已自动带出；媒体点「从素材库选择」选固定版本，没有示例可造素材。</li>
        <li><strong>4 创建</strong>：只存草稿，不提交、不生成、不计费；缺必填也能先存，之后再补。</li>
        <li><strong>5 确认</strong>：缺必填会被拦下并标在对应行；补齐后单向冻结并批量提交，之后按项跟踪进度，失败项可单独重跑。</li>
      </ol>
      {error && <p role="alert" className="access-error">{error}</p>}
      {notice && <p role="status" className="access-success">{notice}</p>}

      <div className="task-layout">
        <section className="access-card">
          <h2>{selected ? "任务详情" : "新建任务"}</h2>
          {selected ? (
            <>
              <div className="access-inline">
                <strong>{selected.name}</strong>
                <span className={`draft-status ${selected.status === "completed" ? "completed" : selected.status === "failed" ? "failed" : "draft"}`}>{taskStatusLabels[selected.status]}</span>
                <small>r{selected.revision} · {selected.itemCount} 项 · 完成 {selected.progress.completed} · 失败 {selected.progress.failed} · 执行中 {selected.progress.active} · 等待确认 {selected.progress.waiting}</small>
              </div>
              {selected.note && <p>{selected.note}</p>}
              <div className="access-inline">
                {editable && <button className="button button-dark" onClick={() => void saveEdit()} disabled={busy || !name.trim()}>保存修改</button>}
                {editable && dirty && <small className="task-item-error">有未保存的修改；确认提交的是服务端已保存的版本。</small>}
                {selected.status === "draft" && <button className="button button-dark" onClick={() => void confirm()} disabled={busy}><Layers size={15} />确认并批量提交</button>}
                {isActiveTask(selected.status) && <button className="button button-outline" onClick={() => void cancel()} disabled={busy}><X size={15} />取消任务</button>}
                <button className="button button-outline" onClick={() => void remove()} disabled={busy || isActiveTask(selected.status)}><Trash2 size={15} />删除任务</button>
                <button className="button button-outline" onClick={() => { setSelected(undefined); setName(""); setNote(""); changeRows(() => [emptyRow(scenes[0], activeContract)]); }} disabled={busy}>返回新建</button>
              </div>
              {selected.status === "draft" && <label>任务名称<input className="text-input" value={name} onChange={event => { setName(event.target.value); setDirty(true); }} /></label>}
              {selected.status === "draft" && <label>说明<textarea className="text-input" rows={2} value={note} onChange={event => { setNote(event.target.value); setDirty(true); }} /></label>}
              {editable ? <>
                {/* 确认前可继续改输入：草稿走可编辑表格，与新建共用同一份。 */}
                <div className="access-inline">
                  <button className="button button-outline" onClick={() => changeRows(current => [...current, emptyRow(activeScene, activeContract)])} disabled={busy}><Plus size={15} />添加一项</button>
                  <button className="button button-outline" onClick={exportCurrent} disabled={busy || !rows.length}><FileDown size={15} />导出当前 {rows.length} 项</button>
                  <label className="button button-outline task-file-button"><FileUp size={15} />导入 CSV<input type="file" accept=".csv,text/csv" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importCsv(file); }} /></label>
                  {gapCount > 0 && <small className="task-item-error">还有 {gapCount} 项缺必填输入，补齐后再确认提交。</small>}
                </div>
                {itemsTable}
              </> : (
                <table className="task-table">
                  <thead><tr><th>项</th><th>场景</th><th>状态</th><th>运行</th><th>操作</th></tr></thead>
                  <tbody>
                    {(selected.items ?? []).map(item => (
                      <tr key={item.itemId}>
                        <td>{item.label}<small>尝试 {item.attemptCount} 次</small></td>
                        <td>{item.sceneId}<small>{item.versionId}</small></td>
                        <td>{taskItemStateLabels[item.state] ?? item.state}{item.lastError && <small className="task-item-error">{item.lastError}</small>}</td>
                        <td>{item.runId ? <button className="text-button" onClick={() => onOpenRun?.(item.runId!)} disabled={!onOpenRun}>{item.runId.slice(0, 8)} <ArrowRight size={13} /></button> : <small>—</small>}{item.reviewId && <small>待确认 {item.reviewId.slice(0, 8)}</small>}</td>
                        <td>{selected.confirmedAt && !isActiveTask(selected.status) && !selected.cancelledAt && item.state !== "waiting" && <button className="button button-small" onClick={() => void rerun(item.itemId)} disabled={busy}><RotateCcw size={13} />重跑</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <>
              <label>任务名称<input className="text-input" value={name} onChange={event => setName(event.target.value)} placeholder="例如：商品图 A 系列 40 张" /></label>
              <label>说明（可选）<textarea className="text-input" rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="记录这一批的用途、客户或约束" /></label>
              <div className="access-inline">
                <label>模板场景<select className="text-input" value={activeSceneId} onChange={event => setActiveSceneId(event.target.value)}>{scenes.map(scene => <option key={scene.sceneId} value={scene.sceneId}>{scene.title}（{scene.sceneId}）</option>)}</select></label>
                <button className="button button-outline" onClick={() => changeRows(current => [...current, emptyRow(activeScene, activeContract)])} disabled={busy}><Plus size={15} />添加一项</button>
              </div>
              {/* CSV 是几十行的主要录入方式：模板 → Excel 填 → 导回。粘贴导入保留给少量行。 */}
              <div className="access-inline task-csv-bar">
                <label>行数<input className="text-input task-rowcount" type="number" min={1} max={200} value={templateRows} onChange={event => setTemplateRows(Math.max(1, Math.min(200, Number(event.target.value) || 1)))} /></label>
                <button className="button button-dark" onClick={() => void exportTemplate(activeScene?.sceneId ?? "", templateRows)} disabled={busy || !scenes.length}><FileDown size={15} />导出该场景模板</button>
                <label className="button button-outline task-file-button"><FileUp size={15} />导入 CSV<input type="file" accept=".csv,text/csv" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importCsv(file); }} /></label>
                <button className="button button-outline" onClick={exportCurrent} disabled={busy || !rows.length}><FileDown size={15} />导出当前 {rows.length} 项</button>
                <button className="button button-outline" onClick={() => setShowPaste(current => !current)} disabled={busy}><ClipboardPaste size={15} />粘贴导入</button>
              </div>
              <p className="task-hint">一个任务可以混合多个场景：每一项在表格里各自选场景与发布版，互不影响。上面的下拉决定「导出模板用哪个场景」和「新增行的初始场景」。已发布场景共 {scenes.length} 个。</p>
              <p className="task-hint">模板只含所选场景的输入列；要一次填多个场景，就分别导出各自模板，或先建好行再「导出当前 N 项」（列按用到的场景合并）。CSV 是宽表，表头形如「商品主图 [product_images]」，用 Excel/WPS 填完导回即可，中文不会乱码（已带 BOM）。媒体列不要手写文件名，要从素材库复制固定版本引用。</p>
              <small>新项自动带出该场景发布版的默认值；必填媒体请从素材库选择，示例不会伪造素材引用。</small>
              {!scenes.length && <p className="access-error" role="alert">当前没有已发布场景。任务项只能引用已发布版本，请先在流程配置里发布场景。</p>}
              {showPaste && (
                <div className="access-card">
                  <h3>粘贴导入</h3>
                  <p>每行一项，用 Tab 分隔列。可用列：名称、场景、发布版本、输入（JSON 对象）；中文或英文表头都行，第一行是表头时自动识别。留空的场景与发布版本使用上面的默认场景。</p>
                  <textarea className="text-input" rows={6} value={paste} onChange={event => setPaste(event.target.value)} placeholder={"名称\t场景\t输入\n第 1 张\tdemo\t{\"flag\":true}"} />
                  <div className="access-inline"><button className="button button-dark" onClick={applyPaste} disabled={busy || !paste.trim()}>导入</button><button className="button button-outline" onClick={() => setShowPaste(false)}>取消</button></div>
                </div>
              )}
              {itemsTable}
              <div className="access-inline">
                <button className="button button-dark" onClick={() => void submitCreate()} disabled={busy || !name.trim() || !itemCount || rows.some(row => !row.sceneId || !row.versionId)}><ListChecks size={15} />创建任务（待确认）</button>
                <small>创建只保存中间态草稿，不提交运行、不生成、不计费；缺必填可以先存，确认前补齐即可。</small>
              </div>
              {/* 缺必填不再是拦路虎：草稿就是用来先存进度、后补素材的。这里如实说明「存储不校验、确认才校验」，
                  避免让人以为创建时会漏掉校验，或以为确认时也会放过。 */}
              {gapCount > 0 && <p className="task-hint" role="status">还有 {gapCount} 项缺必填输入：现在可以创建草稿保存进度；确认并批量提交前必须补齐（媒体从素材库选固定版本）。</p>}
              <small>待创建ID：{taskId}</small>
            </>
          )}
        </section>

        {pickingMedia && <AssetPickerDialog
          kind={pickingMedia.kind}
          onClose={() => setPickingMedia(null)}
          onPick={reference => {
            const target = pickingMedia;
            if (!target) return;
            // 单值字段替换，多值字段追加：与 UserPortal 的媒体语义保持一致。
            const current = target.multiple ? mediaItemsOf(rows[target.index]?.inputValues[target.key]) : [];
            setRowInput(target.index, target.key, [...current, reference] as unknown as JsonValue);
          }}
        />}

        <section className="access-card">
          <h2>任务列表</h2>
          <ul className="access-list">
            {tasks.map(task => (
              <li key={task.taskId}>
                <button className="access-link" onClick={() => void openTask(task.taskId)}>
                  {task.name}
                  <small>{taskStatusLabels[task.status]} · {task.itemCount} 项 · 完成 {task.progress.completed} / 失败 {task.progress.failed} / 执行中 {task.progress.active} · {task.sceneIds.join("、")}</small>
                </button>
              </li>
            ))}
          </ul>
          {!tasks.length && <p>还没有任务。先在上方「新建任务」里添加任务项并创建，确认后才会批量提交运行。</p>}
          {cursor && <button className="button button-outline" onClick={() => void load(cursor)} disabled={busy}>加载更多</button>}
          <small>共 {total} 个任务</small>
        </section>
      </div>
    </div>
  );
}
