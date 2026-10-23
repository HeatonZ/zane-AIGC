import assert from "node:assert/strict";
import test from "node:test";
import { collectLocalMediaPaths, isLocalMediaPath, MAX_LOCAL_MEDIA_VALUE_LENGTH } from "./localMediaPaths.js";

test("本地媒体路径只接受整串绝对路径且带媒体扩展名", () => {
  for (const value of [
    "E:\\AI-outsourcing\\二次元抱枕\\11\\1.png",
    "E:/AI-outsourcing/二次元抱枕/11/1.png",
    "C:\\out\\clip.mp4",
    "\\\\server\\share\\voice.wav",
    "/mnt/data/result.webp",
    "e:\\out\\shot.JPEG",
  ]) assert.equal(isLocalMediaPath(value), true, value);

  for (const value of [
    "1.png",                                  // 相对文件名：坐标语义不明，不接受
    "outputs/media/1.png",                    // 相对路径
    "/api/v1/runs/x/media/1.png",              // 工作台自己的路由，另行处理
    "/api/v1/runs/x/output-media?outputKey=i", // 同上
    "//cdn.example.com/a.png",                 // 协议相对
    "https://example.test/a.png",              // 外部地址
    "data:image/png;base64,AAAA",              // 内联数据
    "blob:http://localhost/abc",               // 浏览器对象地址
    "E:\\data\\notes.txt",                     // 非媒体扩展名
    "E:\\data\\noext",                         // 无扩展名
    "角色名 アーモンドアイ(ウマ娘)",              // 普通文本
    "这是一段提示词，没有任何图片",                // 普通文本
    "参考 E:\\AI-outsourcing\\11\\1.png 生成",   // 文本里提到路径：不是整串，不误判
    "", "   ",                                  // 空值
  ]) assert.equal(isLocalMediaPath(value), false, value);

  // 控制字符与超长值一律拒绝。
  assert.equal(isLocalMediaPath("E:\\out\\a\u0000.png"), false);
  assert.equal(isLocalMediaPath("E:\\out\\a\n.png"), false);
  assert.equal(isLocalMediaPath("E:\\" + "a".repeat(MAX_LOCAL_MEDIA_VALUE_LENGTH) + ".png"), false);
  assert.equal(isLocalMediaPath(undefined), false);
  assert.equal(isLocalMediaPath(null), false);
  assert.equal(isLocalMediaPath(1), false);
  assert.equal(isLocalMediaPath({ path: "E:\\a.png" }), false);
});

test("本地媒体路径按出现顺序收集并去重，前后端坐标因此一致", () => {
  const a = "E:\\batch\\11\\1.png";
  const b = "E:\\batch\\11\\角色\\アーモンドアイ(ウマ娘).jpg";
  // 数组按顺序。
  assert.deepEqual(collectLocalMediaPaths([a, b]), [a, b]);
  // 对象按字段顺序深度优先。
  assert.deepEqual(collectLocalMediaPaths({ characterPath: a, info: { reference: b } }), [a, b]);
  // 重复路径只记第一次，保证同一张图有稳定坐标。
  assert.deepEqual(collectLocalMediaPaths([a, b, a, { nested: [b] }]), [a, b]);
  // 嵌套数组展平。
  assert.deepEqual(collectLocalMediaPaths([[a], [[b]]]), [a, b]);
  // 非媒体与普通文本不参与。
  assert.deepEqual(collectLocalMediaPaths({ prompt: "写一段提示词", note: "E:\\data\\notes.txt", images: [a] }), [a]);
  assert.deepEqual(collectLocalMediaPaths("没有图片"), []);
  assert.deepEqual(collectLocalMediaPaths(null), []);
  assert.deepEqual(collectLocalMediaPaths([]), []);
});
