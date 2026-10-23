import assert from "node:assert/strict";
import test from "node:test";
import { isRunMediaRecord, mediaDownloadName, mediaExtensionForMime, runMediaUrl, runOutputMediaItems } from "./runMedia";
import type { JsonValue } from "../types";
test("手动替换的本地归档媒体通过运行媒体路由预览，外部路径不会误作 URL", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const route = "/api/v1/runs/" + id + "/media/replacement-demo.mp4";
  assert.equal(runMediaUrl("C:\\project\\.zane\\runs\\" + id + "\\outputs\\media\\replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("/project/.zane/runs/" + id + "/outputs/media/replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("/api/workflows/runs/" + id + "/media/replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("C:\\other\\clip.mp4"), undefined);
  assert.equal(runMediaUrl("https://example.invalid/image.png"), "https://example.invalid/image.png");
  assert.equal(runMediaUrl(route), route);
});

test("收藏使用服务端扁平媒体索引，不随不可预览项过滤而错位", () => {
  const values = [null, "", ["F:/external/no-preview.png", "https://example.invalid/a.png"], { url: "https://example.invalid/b.png", filename: "b.png" }];
  const media = runOutputMediaItems(values, "image_list");
  assert.deepEqual(media.map(item => item.mediaIndex), [1, 2]);
  assert.deepEqual(media.map(item => item.url), ["https://example.invalid/a.png", "https://example.invalid/b.png"]);
});
test("固定版本资产对象和归档路径可以作为输出媒体预览，普通JSON不误渲染", () => {
  const asset = { assetId: "asset", assetVersion: 2, assetName: "主角", path: "F:/project/.zane/assets/blobs/a.png", previewUrl: "/api/v1/assets/asset/versions/2/media" };
  assert.deepEqual(runOutputMediaItems([asset], "image_list"), [{url: asset.previewUrl, filename: "主角", isVideo: false, isAudio: false, mediaIndex: 0}]);
  assert.equal(runOutputMediaItems({ url: "https://example.invalid/story", filename: "story" }, "json").length, 0);
  assert.equal(runOutputMediaItems({ url: "https://example.invalid/a.wav", filename: "a.wav" })[0].isAudio, true);
});

test("路径已脱敏且预览地址无扩展名时仍从固定素材名称识别媒体类型", () => {
  const assets = [
    { assetId: "image", assetVersion: 1, assetName: "E.jpg", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/image/versions/1/media" },
    { assetId: "video", assetVersion: 2, assetName: "clip.mp4", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/video/versions/2/media" },
    { assetId: "audio", assetVersion: 3, assetName: "voice.wav", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/audio/versions/3/media" },
  ];
  assert.deepEqual(runOutputMediaItems(assets, "json").map(item => [item.filename, item.isVideo, item.isAudio]), [
    ["E.jpg", false, false], ["clip.mp4", true, false], ["voice.wav", false, true],
  ]);
});

test("已记录的非标准本地媒体通过来源路由预览并保留收藏索引", () => {
  const source = { runId: "12345678-1234-4234-8234-123456789abc", stepId: "video", itemIndex: 2, outputKey: "clips" };
  const items = runOutputMediaItems([{note: "不是媒体"}, "F:/external/video.mp4"], "video_list", source);
  assert.equal(items.length, 1);
  assert.equal(items[0].mediaIndex, 1);
  const url = new URL(items[0].url, "http://localhost");
  assert.equal(url.pathname, "/api/v1/runs/" + source.runId + "/output-media");
  assert.deepEqual(Object.fromEntries(url.searchParams), {outputKey: "clips", mediaIndex: "1", stepId: "video", itemIndex: "2"});
  assert.equal(items[0].isVideo, true);
});

test("通用JSON容器内任意层级的媒体通过运行授权地址直接展示，旧Comfy预览不抢优先级", () => {
  const runId = "12345678-1234-4234-8234-123456789abc";
  const source = { runId, stepId: "references", itemIndex: 3, outputKey: "bundle" };
  const image = {
    assetId: "asset-id", assetVersion: 1, assetName: "E.jpg", filename: "E.jpg",
    file: "outputs/media/E-abcd1234.jpg", path: "F:/project/.zane/assets/blobs/e.jpg",
    previewUrl: "http://127.0.0.1:8188/view?filename=E.jpg", url: `/api/workflows/runs/${runId}/media/E-abcd1234.jpg`,
  };
  const bundle = { images: [image], selected: { product_images: [image] }, audios: [], videos: [] };
  assert.equal(isRunMediaRecord(image), true);
  const media = runOutputMediaItems(bundle, "json", source);
  assert.equal(media.length, 2);
  assert.equal(media[0].url, `/api/v1/runs/${runId}/media/E-abcd1234.jpg`);
  assert.equal(media[1].url, `/api/v1/runs/${runId}/media/E-abcd1234.jpg`);
  assert.deepEqual(media.map(item => item.filename), ["E.jpg", "E.jpg"]);
  assert.ok(media.every(item => !item.isVideo && !item.isAudio));
});

test("通用JSON按媒体扩展名和MIME识别图片/视频/音频，不把普通字段误判为媒体", () => {
  const media = runOutputMediaItems({
    images: [{ filename: "cover.webp", url: "https://example.invalid/cover.webp" }],
    clips: [{ filename: "clip.mp4", previewUrl: "https://example.invalid/clip" }],
    sounds: [{ filename: "sound.bin", mimeType: "audio/wav", url: "https://example.invalid/sound" }],
    title: { filename: "draft" },
  });
  assert.deepEqual(media.map(item => [item.filename, item.isVideo, item.isAudio]), [
    ["cover.webp", false, false], ["clip.mp4", true, false], ["sound.bin", false, true],
  ]);
});

test("core.code 写在 text/json 输出里的本机图片路径经受控 local-media 通道预览", () => {
  // 真实场景：core.code 的 fileAccess 把角色图/参考图的绝对路径写进 characterPath(text) 与
  // reference(json)。这些文件不在运行归档里，以前既解析不出地址、也不被 output-media 接受，
  // 于是界面上完全看不到图——这正是本次修复的缺陷。
  const runId = "e7812983-d90b-41d1-9808-d73c38163e81";
  const source = { runId, stepId: "scan", outputKey: "reference" };
  const reference = "E:\\AI-outsourcing\\二次元抱枕\\11\\1.png";
  const character = "E:\\AI-outsourcing\\二次元抱枕\\11\\角色\\アーモンドアイ(ウマ娘).jpg";

  // text 与 json 两种声明类型都要能预览。
  for (const type of ["text", "json", undefined]) {
    const media = runOutputMediaItems(reference as JsonValue, type, source);
    assert.equal(media.length, 1, String(type));
    assert.equal(media[0].isVideo, false);
    const url = new URL(media[0].url, "http://localhost");
    assert.equal(url.pathname, "/api/v1/runs/" + runId + "/local-media");
    assert.deepEqual(Object.fromEntries(url.searchParams), { outputKey: "reference", mediaIndex: "0", stepId: "scan" });
    assert.equal(media[0].filename, reference);
  }

  // 非图片扩展名按类型推断为视频。
  const video = runOutputMediaItems("E:\\out\\clip.mp4" as JsonValue, "json", source);
  assert.equal(video.length, 1);
  assert.equal(video[0].isVideo, true);

  // 坐标必须与整份输出里本地路径的首次出现顺序一致；重复路径复用同一个坐标。
  const ordered = runOutputMediaItems([reference, character, reference] as JsonValue, "json", source);
  assert.deepEqual(ordered.map(item => new URL(item.url, "http://localhost").searchParams.get("mediaIndex")), ["0", "1", "0"]);
  assert.deepEqual(ordered.map(item => item.filename), [reference, character, reference]);

  // 没有来源坐标（无法定位运行/输出）时不产生地址，避免猜出一个读不到的位置。
  assert.equal(runOutputMediaItems(reference as JsonValue, "json").length, 0);
});

test("本机路径识别不误伤：普通文本、非媒体文件与文本中提及的路径都不当图片", () => {
  const source = { runId: "12345678-1234-4234-8234-123456789abc", stepId: "scan", outputKey: "prompt" };
  for (const value of [
    "这是一段提示词，没有任何图片",
    "E:\\data\\notes.txt",
    "参考 E:\\AI-outsourcing\\11\\1.png 生成",   // 文本里提到路径：不是整串，不得误判
    "outputs/media/1.png",                        // 相对路径：坐标语义不明
    "https://example.invalid/a.png",              // 外部地址
    "/api/v1/runs/x/media/1.png",                 // 工作台自己的路由
    "", "   ",
  ]) assert.equal(runOutputMediaItems(value as JsonValue, "text", source).length, 0, value);
});

test("声明为媒体类型的输出仍走 output-media，不因本机路径改道而丢掉手动替换结果", () => {
  // 手动替换本步结果选中的本地文件通常不在管理员配置的导出根目录里，只能继续走
  // output-media（它按运行归档/替换记录读取）。若改道到带包含性校验的 local-media，
  // 这条既有能力会直接失败。
  const source = { runId: "12345678-1234-4234-8234-123456789abc", stepId: "video", itemIndex: 2, outputKey: "clips" };
  const items = runOutputMediaItems([{ note: "不是媒体" }, "F:/external/video.mp4"], "video_list", source);
  assert.equal(items.length, 1);
  const url = new URL(items[0].url, "http://localhost");
  assert.equal(url.pathname, "/api/v1/runs/" + source.runId + "/output-media");
  assert.deepEqual(Object.fromEntries(url.searchParams), { outputKey: "clips", mediaIndex: "1", stepId: "video", itemIndex: "2" });
  assert.equal(items[0].isVideo, true);
});

test("固定素材引用的展示名没有扩展名时按同一条引用的路径判类型，判不出则不猜", () => {
  // 运行 7eb39d1b-ac66-4d4d-84be-255360b5fb6a 的真实记录：assetName 是「猫主角米酒_四视图_V4」
  // 这类没有扩展名的中文展示名，扩展名只在同一条引用的 path 上。旧实现只取第一个候选判类型，
  // 整条引用因此被判成非媒体，运行记录「查看本次输入」渲染成空白。
  const runId = "7eb39d1b-ac66-4d4d-84be-255360b5fb6a";
  const files = "F:\\project\\zane\\.zane\\runs\\" + runId + "\\inputs\\files\\";
  const image = { assetId: "05f0f5b9-3506-4ab0-ae41-bcfd6b20d57c", assetVersion: 1, path: files + "character_assets-acbaa4a3-1.png", assetName: "猫主角米酒_四视图_V4", previewUrl: "/api/v1/assets/05f0f5b9-3506-4ab0-ae41-bcfd6b20d57c/versions/1/media" };
  const voice = { assetId: "903d4795-37a0-40e9-ad84-ecfda0f7be55", assetVersion: 1, path: files + "voice_reference_audio-85e49569-1.wav", assetName: "男主人_音色参考", previewUrl: "/api/v1/assets/903d4795-37a0-40e9-ad84-ecfda0f7be55/versions/1/media" };
  assert.deepEqual(runOutputMediaItems({ character_assets: [image], voice_reference_audio: [voice] }, "json").map(item => [item.filename, item.isVideo, item.isAudio, item.url]), [
    ["猫主角米酒_四视图_V4", false, false, image.previewUrl],
    ["男主人_音色参考", false, true, voice.previewUrl],
  ]);

  // 用户面投影只剩展示名、没有任何扩展名线索：不猜类型，但按字段声明类型仍渲染同一条引用。
  const bare = { assetId: image.assetId, assetVersion: 1, assetName: "猫主角米酒_四视图_V4" };
  assert.equal(runOutputMediaItems(bare, "json").length, 0);
  assert.equal(runOutputMediaItems(bare, "image_list")[0].url, image.previewUrl);
});

test("单文件下载名优先取带扩展名的真实文件名，没有扩展名时交给调用方补后缀", () => {
  const runId = "12345678-1234-4234-8234-123456789abc";
  const archived = "/api/v1/runs/" + runId + "/media/E-abcd1234.jpg";
  // 归档路由末段带扩展名，即使记录里另有一个没有扩展名的展示名也优先用它。
  assert.deepEqual(mediaDownloadName({ url: archived, filename: "猫主角米酒_四视图_V4" }, "图片"), { name: "E-abcd1234.jpg", extension: true });
  // 固定素材只有中文展示名时保留原名，但标记为缺扩展名，下载前需读响应头补全。
  assert.deepEqual(mediaDownloadName({ url: "/api/v1/assets/a/versions/1/media", filename: "猫主角米酒_四视图_V4" }, "图片"), { name: "猫主角米酒_四视图_V4", extension: false });
  // 没有任何名字线索时用输出标签加序号，避免所有下载都叫同一个文件名。
  assert.deepEqual(mediaDownloadName({ url: "/api/v1/runs/" + runId + "/output-media?outputKey=v&mediaIndex=0" }, "分镜视频", 2), { name: "分镜视频-3", extension: false });
  // 路径分隔符与 Windows 保留字符不能进文件名，避免浏览器改写或落盘失败。
  assert.deepEqual(mediaDownloadName({ url: archived, filename: "E:\\out\\a<b>:c|d?.mp4" }, "视频"), { name: "a-b--c-d-.mp4", extension: true });
  assert.equal(mediaDownloadName({ url: archived, filename: "..\\..\\secret.png" }, "图片").name, "secret.png");
  assert.deepEqual(mediaDownloadName({ url: "/api/v1/runs/" + runId + "/media/%E5%88%86%E9%95%9C.mp4" }, "视频"), { name: "分镜.mp4", extension: true });
});

test("下载扩展名优先按响应 Content-Type 推断，判不出才按媒体类型给常见容器", () => {
  assert.equal(mediaExtensionForMime("image/jpeg", "image"), ".jpg");
  assert.equal(mediaExtensionForMime("video/mp4; charset=binary", "video"), ".mp4");
  assert.equal(mediaExtensionForMime("audio/x-wav", "audio"), ".wav");
  assert.equal(mediaExtensionForMime("application/octet-stream", "video"), ".mp4");
  assert.equal(mediaExtensionForMime("", "audio"), ".mp3");
  assert.equal(mediaExtensionForMime("", "image"), ".png");
});

