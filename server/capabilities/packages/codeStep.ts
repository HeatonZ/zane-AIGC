import type { CapabilityFactory } from "../package.js";
import { executeCodeStep, validateCodeStep } from "../../execution/codeSandbox.js";
/** Custom local code step: data transformation and control flow in an isolated sandbox. */
const factory: CapabilityFactory = () => ({
  definition: {
    id: "core.code", version: "1", usage: { whenToUse: "新场景的数据传递、模板拼装、条件控制、媒体选择/排序/合并或结构化计算；本地沙箱执行，不调用模型或外部服务。场景特有的编排用自定义代码表达，不新增专用步骤。" }, label: "自定义代码", category: "数据",
    description: "在隔离沙箱中执行本地 JavaScript：按声明的输入端口读取数据，return 返回各输出端口的值；媒体端口（image_list/video_list/audio_list）按 filename 从本步骤输入中选择、排序或合并媒体，不产生新媒体文件。不读写文件、不联网、不调用模型，仅做数据变换与控制；死循环和超内存会被强制终止。",
    dependencyMode: "declared", legacy: { kind: "capability" }, inputs: [], outputs: [],
    config: [
      { key: "code", label: "代码", type: "textarea", required: true, placeholder: "// 读取声明的输入，返回各输出端口的值\nconst total = (inputs.items ?? []).length;\nreturn { count: total, summary: \"共 \" + total + \" 项\" };", description: "以 async function 体书写：顶层 return 返回结果对象，键对应下方输出端口；inputs 为声明的输入端口集合。沙箱内只有 JavaScript 内置对象与 console，没有文件、网络、进程、定时器和 Node 模块；媒体输入以只读 [{filename}] 投影进入（可判断数量/顺序/文件名，不暴露路径、URL 与二进制）；媒体输出端口返回文件名数组（字符串或 {filename}），按顺序选择本步骤输入里的媒体，可重复、可重排，引用不存在的文件或类型不符会明确失败；console 输出仅用于失败排查，不计入输出。" },
      { key: "timeoutMs", label: "执行超时（毫秒）", type: "number", defaultValue: 5000, description: "单次执行 200–60000 毫秒；同步死循环和异步失控都会被强制终止并记为失败。" },
    ],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableInputs: true, editableOutputs: true }, result: { renderer: "auto" },
  },
  validate: validateCodeStep,
  async execute(context) { return executeCodeStep(context); },
});
export default factory;
