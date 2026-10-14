import type { CapabilityFactory } from "../package.js";
import { executeCodeStep, validateCodeStep } from "../../execution/codeSandbox.js";
/** Custom local code step: data transformation and control flow in an isolated sandbox. */
const factory: CapabilityFactory = () => ({
  definition: {
    id: "core.code", version: "1", usage: { whenToUse: "新场景的数据传递、模板拼装、条件控制、媒体选择/排序/合并、按文件名读取批次目录（fileAccess）后计算生成计划、或结构化计算；本地沙箱执行，不调用模型或外部服务。场景特有的编排用自定义代码表达，不新增专用步骤。" }, label: "自定义代码", category: "数据",
    description: "在隔离沙箱中执行本地 JavaScript：按声明的输入端口读取数据，return 返回各输出端口的值；媒体端口（image_list/video_list/audio_list）按 filename 从本步骤输入中选择、排序或合并媒体，不产生新媒体文件。沙箱自身不读写文件、不联网、不调用模型，仅做数据变换与控制；沙箱不向用户代码暴露宿主对象，无法逃逸到宿主进程、文件系统或子进程；死循环和超内存会被强制终止。两个可选开关都由宿主在沙箱之外代为执行，且都以管理员配置的同一个本地根目录为唯一边界：localExport 只提交导出计划后由宿主写入；fileAccess 只允许按相对路径 zane.fs.list/zane.fs.stat 读取该根目录内的文件名与元数据，并用 zane.fs.readText 读取文本内容。不配置时既不写也不读任何文件。",
    dependencyMode: "declared", legacy: { kind: "capability" }, inputs: [], outputs: [],
    config: [
      { key: "code", label: "代码", type: "textarea", required: true, placeholder: "// 读取声明的输入，返回各输出端口的值\nconst total = (inputs.items ?? []).length;\nreturn { count: total, summary: \"共 \" + total + \" 项\" };", description: "以 async function 体书写：顶层 return 返回结果对象，键对应下方输出端口；inputs 为声明的输入端口集合。沙箱内只有 JavaScript 内置对象、console 与（仅在开启 fileAccess 时）只读的 zane.fs，没有文件、网络、进程、定时器和 Node 模块；上下文不暴露宿主函数对象，用户代码无法经 constructor/原型链逃逸到宿主进程（因此也不能读写宿主文件或执行命令），eval 与 new Function 不可用；媒体输入以只读 [{filename}] 投影进入（可判断数量/顺序/文件名，不暴露路径、URL 与二进制）；媒体输出端口返回文件名数组（字符串或 {filename}），按顺序选择本步骤输入里的媒体，可重复、可重排，引用不存在的文件或类型不符会明确失败；console 输出仅用于失败排查，不计入输出。" },
      { key: "timeoutMs", label: "执行超时（毫秒）", type: "number", defaultValue: 5000, description: "单次执行 200–60000 毫秒；同步死循环和异步失控都会被强制终止并记为失败。" },
      { key: "localExport", label: "本地导出（可选）", type: "json", description: "可选。形如 {enabled:true,planKey:\"plan\",onConflict:\"overwrite\"}：代码返回 {items:[{source,target}]} 计划，真正写盘由宿主在沙箱之外完成，沙箱仍无文件系统访问。target 可用相对路径（相对管理员在「集成连接 → 本地导出」配置的根目录，未配置则整步失败 LOCAL_EXPORT_DISABLED），归一化后必须仍在根目录内，越界报 LOCAL_EXPORT_OUTSIDE_ROOT；source 必须是本步骤声明输入里真实存在的媒体文件名。planKey 指定承载计划的输出端口，省略时要求恰好一个 json 候选端口。onConflict 默认 overwrite（重跑取最新），可选 skip/fail。步骤声明 local_export(json) 输出端口时记录逐项 bytes/sha256/status（由宿主填写，用户代码不必返回）。配置、校验与预检都不写文件，仅提交执行时落盘，不调用模型、不计费。source 既可以是本运行/来源运行归档里的媒体，也可以是本运行内刚由 ComfyUI 生成、尚未归档的媒体（归档发生在流程末尾，此时宿主按配置的 comfyuiBaseUrl 取回该产物）。" },
      { key: "fileAccess", label: "本地文件读取（可选）", type: "json", description: "可选。形如 {enabled:true}：开启后沙箱内出现只读对象 zane.fs，可 zane.fs.list(相对路径) 列出目录、zane.fs.stat(相对路径) 查看文件元数据、zane.fs.readText(相对路径) 读取文本内容；路径相对管理员配置的同一个本地导出根目录，未配置根目录则整步失败 FILE_ACCESS_DISABLED，越界报 FILE_OUTSIDE_ROOT。list/stat 只返回文件名、绝对路径（根内）、类型与字节数；readText 返回 UTF-8 文本（用于从动作/提示词这类多行文本里挑一行），单次上限 1 MB、超出报 FILE_TOO_LARGE。读取不写入、不删除、不重命名，读到的文本不会被执行或解析。目录最多 500 项，超出报 FILE_LIST_TOO_LARGE；每次调用都是宿主的真实读取，沙箱自身仍然没有文件系统、网络与进程访问。关闭（默认）时 zane 不存在，代码里的任何文件读取都会失败。" },
    ],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableInputs: true, editableOutputs: true }, result: { renderer: "auto" },
  },
  validate: validateCodeStep,
  async execute(context) { return executeCodeStep(context); },
});
export default factory;
