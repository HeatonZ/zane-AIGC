/**
 * 安装第一个对外服务：「GPT Image 生图」。
 *
 * 直接复用生产已有的 `gpt image` 场景（scene_d6393e30…）作为组件：
 * 该场景自带两条 HTTP 步骤——上传参考图时走 /v1/images/edits，未上传时走
 * /v1/images/generations，再由 core.code 合并成最终结果。包不再另建精简场景，
 * 对外暴露场景原生的三个输入：提示词、参考图（可选）、模型。
 *
 * 定价跟随组件场景自身的 pricing（发布快照固化）；场景没有 pricing 时不收费。
 * 幂等：已存在同 ID 的包时按当前 revision 更新草稿，不覆盖用户已改的内容。
 */
const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const TOKEN = process.env.ZANE_ADMIN_TOKEN ?? "";

const PACKAGE_ID = "ai_image";
const SCENE_ID = "scene_d6393e30-d8e0-4591-a033-02c586d8c0f8";

async function request(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    const code = typeof data === "object" && data ? data.code : "";
    const error = new Error(method + " " + route + " -> " + response.status + " " + code + " " + (typeof data === "object" && data ? data.error : text.slice(0, 200)));
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return data;
}

const read = (route) => request("GET", route);
const post = (route, body) => request("POST", route, body);
const patch = (route, body) => request("PATCH", route, body);

async function main() {
  if (!TOKEN) throw new Error("需要 ZANE_ADMIN_TOKEN");

  // 1. 读取组件的当前发布版：包只引用已发布快照，不读草稿。
  const workspace = await read("/api/v1/scenes?limit=200");
  const source = workspace.scenes?.find(scene => scene.sceneId === SCENE_ID);
  if (!source) throw new Error("生产里没有找到 gpt image 场景：" + SCENE_ID);
  if (!source.publishedVersionId) throw new Error("gpt image 场景还没有发布版本：" + SCENE_ID);
  const published = await read("/api/v1/scenes/" + encodeURIComponent(SCENE_ID) + "?versionId=" + encodeURIComponent(source.publishedVersionId));
  const sceneInputs = published.workflow.inputs;
  for (const key of ["prompt", "images", "model"]) {
    if (!sceneInputs.some(field => field.key === key)) throw new Error("gpt image 场景缺少输入：" + key);
  }
  console.log("组件场景已发布 versionId=" + source.publishedVersionId + "，输入：" + sceneInputs.map(field => field.key).join(", "));

  // 2. 对外只暴露场景原生输入；参考图留空时场景自己走文生图分支。
  const modelField = sceneInputs.find(field => field.key === "model");
  const packageBody = {
    id: PACKAGE_ID,
    title: "生图",
    summary: "写描述出图，也可以传参考图改图",
    description: "写一段描述生成图片；上传参考图时按描述编辑这张图。",
    inputs: [
      { key: "prompt", type: "textarea", label: "描述", required: true, placeholder: "例如：一只橘猫坐在窗台上，午后阳光，浅景深" },
      { key: "images", type: "image_list", label: "参考图", required: false },
      {
        key: "model", type: "select", label: "模型", required: true,
        options: modelField?.options ?? ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5", "gpt-image-2"],
        ...(modelField?.defaultValue !== undefined ? { defaultValue: modelField.defaultValue } : {}),
      },
    ],
    items: [
      {
        id: "generate",
        name: "gpt image",
        sceneId: SCENE_ID,
        versionId: source.publishedVersionId,
        inputs: [
          { key: "prompt", valueSource: "input", sourceRef: "input.prompt" },
          { key: "images", valueSource: "input", sourceRef: "input.images" },
          { key: "model", valueSource: "input", sourceRef: "input.model" },
        ],
      },
    ],
    // 服务自己的定价：价格属于这个 SaaS 服务，不跟随内部场景改价（场景可替换/可无定价）。
    pricing: { version: 1, base: 0, items: { generate: { unit: "per_call", credits: 0.1 } } },
    // 呈现层：生图是高频反复用的工具，用工作台布局（左调参、右出图），而不是营销页。
    presentation: {
      layout: "workspace",
      theme: { accent: "#0f766e", accentSoft: "#e6fffb", heroFrom: "#0b3b3a", heroTo: "#0f766e", dark: true },
      workspace: {
        title: "生图",
        subtitle: "写一句描述，或传一张参考图按描述改它。",
        resultTitle: "生成结果",
        emptyHint: "填好左侧描述后点「生成图片」，结果会直接出现在这里，不用跳页。",
        history: true,
      },
      // 工作台里灵感与风格都以 chips 形式贴在输入框上方，仍需保留给 ServiceQuickStarts。
      promptIdeas: [
        { label: "产品主视觉", value: "极简产品主视觉：一只白色陶瓷马克杯放在浅灰石材台面上，柔和侧光，背景干净，商业摄影质感，浅景深" },
        { label: "人像氛围", value: "黄昏街头的人像，侧脸逆光，发丝有轮廓光，背景虚化的城市灯光，电影感色调" },
        { label: "插画封面", value: "扁平插画风格的科技封面：抽象几何图形与渐变光晕，深蓝紫配色，留出大量文字空间" },
        { label: "空间场景", value: "现代极简客厅，大面积落地窗，午后阳光斜射，原木与白色墙面，室内设计摄影" },
      ],
      presets: [
        { label: "商业摄影", description: "干净、可商用", values: { prompt: "商业摄影风格，柔光，干净背景，产品居中，高清细节，浅景深" } },
        { label: "电影感", description: "强氛围与调色", values: { prompt: "电影感画面，宽银幕构图，戏剧性布光，青橙色调，颗粒质感" } },
        { label: "插画", description: "扁平与手绘", values: { prompt: "现代扁平插画，简洁几何造型，柔和渐变配色，干净留白" } },
        { label: "3D 渲染", description: "立体与材质", values: { prompt: "3D 渲染风格，柔和棚拍光，磨砂与金属材质对比，浅色背景，超清" } },
      ],
      resultLabels: { sectionTitle: "生成结果", emptyHint: "第一次生成通常需要几十秒", cta: "生成图片" },
    },
  };

  // 3. 建或更新包草稿（幂等）。
  let packageDraft;
  try {
    packageDraft = (await read("/api/v1/packages/" + encodeURIComponent(PACKAGE_ID))).package;
    console.log("服务已存在，按当前 revision 更新草稿");
    packageDraft = (await patch("/api/v1/packages/" + encodeURIComponent(PACKAGE_ID), { ...packageBody, revision: packageDraft.revision })).package;
  } catch (error) {
    if (error.status !== 404) throw error;
    packageDraft = (await post("/api/v1/packages", packageBody)).package;
    console.log("已创建服务草稿");
  }

  // 4. 发布（幂等：同一 publicationId 重复调用返回既有版本）。
  const packagePublication = await post("/api/v1/packages/" + encodeURIComponent(PACKAGE_ID) + "/publish", {
    revision: packageDraft.revision,
    publicationId: process.env.ZANE_PACKAGE_PUBLICATION_ID ?? crypto.randomUUID(),
  });
  console.log("服务已发布 versionId=" + packagePublication.version.versionId + " version=" + packagePublication.version.version);
  console.log("完成：用户端「服务」应出现「生图」，组件为 gpt image 场景");
}

main().catch(error => { console.error("安装失败：" + error.message); process.exit(1); });
