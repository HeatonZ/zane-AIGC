import assert from "node:assert/strict";
import test from "node:test";
import { selectMediaReferences } from "./mediaReferenceService.js";
import { createRuntimeMediaValue, runtimeMediaItems } from "../runtimeValue.js";
const groups = [{ key: "products", kind: "image", tag: "Product" }, { key: "covers", kind: "image", tag: "Cover" }, { key: "music", kind: "audio", tag: "Sound", referenceTag: "Clip" }];
const sources = { products: createRuntimeMediaValue("image", ["product-a.png", "product-b.png"]), covers: ["cover.png"], music: ["sound.wav"] };

test("通用素材选择跨商品/封面/音频复用，排序编号、引用标记和原素材ID保持稳定", () => {
  const before = structuredClone(sources);
  const result = selectMediaReferences(groups, sources, { products: [2, 1], covers: [1], music: [1] }, "<Product 2> 和 <Cover 1> 配 <Sound 1>");
  assert.equal(result.prompt, "<Picture 2> 和 <Picture 3> 配 <Clip 1>");
  assert.deepEqual(result.indices.products, [1, 2]); assert.deepEqual(result.reference_map.map((item) => item.reference), ["<Picture 1>", "<Picture 2>", "<Picture 3>", "<Clip 1>"]);
  assert.deepEqual(runtimeMediaItems(result.selected.products), runtimeMediaItems(sources.products));
  assert.deepEqual(sources, before);
  const empty = selectMediaReferences(groups, sources, { products: [], covers: [], music: [] }); assert.equal(runtimeMediaItems(empty.selected.covers).length, 0);
});

test("基础引用选择不静默丢弃越界/重复/未选中/未知组/错误媒体，标签一次映射无连锁替换", () => {
  const valid = { products: [1], covers: [], music: [] };
  for (const selection of [{ ...valid, products: [3] }, { ...valid, products: [1, 1] }, { ...valid, other: [] }, { products: [1], covers: [] }]) assert.throws(() => selectMediaReferences(groups, sources, selection));
  assert.throws(() => selectMediaReferences(groups, sources, valid, "<Product 2>"), /未选中的/);
  assert.throws(() => selectMediaReferences(groups, { ...sources, products: ["ok.png", {}] }, valid), /不能静默丢弃/);
  assert.throws(() => selectMediaReferences(groups, { ...sources, products: createRuntimeMediaValue("audio", "voice.wav") }, valid), /媒体类型/);
  assert.throws(() => selectMediaReferences([...groups, groups[0]], sources, valid), /不能重复/);
  const once = selectMediaReferences([{ key: "left", kind: "image", tag: "Source" }, { key: "right", kind: "image", tag: "Picture" }], { left: ["left.png"], right: ["right.png"] }, { left: [1], right: [1] }, "<Source 1> / <Picture 1>");
  assert.equal(once.prompt, "<Picture 1> / <Picture 2>");
});


test("业务分类按物理媒体类型合并，空组不占编号，图片/音频/视频各自连续且保留原素材ID", () => {
  const mixedGroups = [{key:"characters",kind:"image",tag:"Character"},{key:"empty",kind:"image",tag:"Empty"},{key:"voices",kind:"audio",tag:"Voice"},{key:"scenes",kind:"image",tag:"Scene"},{key:"clips",kind:"video",tag:"Clip"},{key:"effects",kind:"audio",tag:"Effect"}];
  const mixed = { characters: createRuntimeMediaValue("image",["a.png","b.png"]),empty:[],voices:["voice.wav"],scenes:["scene.png"],clips:["one.mp4","two.mp4"],effects:["effect.wav"] };
  const before = structuredClone(mixed);
  const result = selectMediaReferences(mixedGroups,mixed,{characters:[2,1],empty:[],voices:[1],scenes:[1],clips:[2,1],effects:[1]},"<Character 2> <Scene 1> <Voice 1> <Effect 1> <Clip 2>");
  assert.deepEqual(runtimeMediaItems(result.images).map(item=>item.locator), [...runtimeMediaItems(mixed.characters),...runtimeMediaItems(mixed.scenes,"image")].map(item=>item.locator));
  assert.deepEqual(runtimeMediaItems(result.images).map(item=>item.id), [...runtimeMediaItems(mixed.characters),...runtimeMediaItems(mixed.scenes,"image")].map(item=>item.id));
  assert.deepEqual(runtimeMediaItems(result.audios).map(item=>item.locator),[...runtimeMediaItems(mixed.voices,"audio"),...runtimeMediaItems(mixed.effects,"audio")].map(item=>item.locator));
  assert.deepEqual(runtimeMediaItems(result.videos).map(item=>item.locator),runtimeMediaItems(mixed.clips,"video").map(item=>item.locator));
  assert.equal(result.prompt,"<Picture 2> <Picture 3> <Audio 1> <Audio 2> <Video 2>");
  assert.deepEqual(mixed,before);
  const none=selectMediaReferences(mixedGroups,mixed,{characters:[],empty:[],voices:[],scenes:[],clips:[],effects:[]});
  assert.equal(runtimeMediaItems(none.images).length,0);assert.equal(none.audios.mediaKind,"audio");assert.equal(none.videos.mediaKind,"video");
});

test("相同素材跨分类仍占独立引用位置，不去重或改变Picture编号", () => {
  const shared=createRuntimeMediaValue("image","same.png");
  const result=selectMediaReferences([{key:"person",kind:"image",tag:"Person"},{key:"prop",kind:"image",tag:"Prop"}],{person:shared,prop:shared},{person:[1],prop:[1]},"<Person 1> <Prop 1>");
  assert.equal(result.images.items.length,2);assert.deepEqual(result.images.items[0],result.images.items[1]);assert.equal(result.prompt,"<Picture 1> <Picture 2>");
});
