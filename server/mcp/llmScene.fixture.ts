/** 「二次元抱枕生图（单角色·大模型版）」场景的步骤定义快照，由真实场景草稿导出，仅供回归测试使用。
 *
 *  为什么要固化一份：这个场景的关键行为全在 core.code 代码、core.llm 的 systemPrompt/输出模式
 *  与 ComfyUI 绑定里——两轮各自看图产出终稿、净化守卫剥掉 JSON 壳、终稿直接写进采样器 prompt 端口、
 *  动作由场景随机抽一行、动作文件为空则整轮跳过。光看测试断言无法保证它们没被改坏。
 *  这里保存真实定义，测试再用假运行时执行它，于是「改坏了流程」会直接让测试失败。
 *
 *  更新方式：改动场景草稿后，用 get_scene_draft 取回草稿并重新导出本文件；
 *  不要手改这里的代码逻辑，否则测试就不再反映真实场景。 */
export const llmSceneWorkflow = {
  "name": "二次元抱枕生图（单角色·大模型版）",
  "sceneId": "scene_27ea10bd-8158-4525-a747-98d8b7a15349",
  "inputs": [
    {
      "label": "批次",
      "required": true,
      "key": "batch",
      "type": "text",
      "placeholder": "例如 11"
    },
    {
      "label": "角色",
      "required": true,
      "key": "character",
      "type": "text",
      "placeholder": "例如 AZKi（也可写 AZKi.png）"
    }
  ],
  "steps": [
    {
      "promptTemplate": "",
      "id": "scan",
      "name": "读取批次目录、锁定该角色并读出提示词与随机动作",
      "kind": "capability",
      "capabilityId": "core.code",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "code": "const text = (value) => (value === null || value === undefined ? \"\" : String(value));\nconst IMAGE = /\\.(png|jpe?g|webp|bmp)$/i;\nconst stem = (name) => name.replace(/\\.[^.]+$/, \"\");\nconst brief = (value) => (value.length > 60 ? value.slice(0, 60) + \"…\" : value);\n\nconst batch = text(inputs.batch).trim();\nif (!batch) throw new Error(\"批次不能为空，请填写批次号，例如 11\");\nif (/[\\\\/]/.test(batch) || batch === \".\" || batch === \"..\") throw new Error(\"批次只能是一个目录名，不能包含路径分隔符：\" + batch);\n\nconst wanted = stem(text(inputs.character).trim());\nif (!wanted) throw new Error(\"角色不能为空，请填写角色名（可带扩展名，例如 AZKi 或 AZKi.png）\");\n\nconst characterDirectory = batch + \"/\" + \"角色\";\nconst entries = await zane.fs.list(characterDirectory);\nconst files = entries.filter((entry) => entry.isFile && !entry.isSymbolicLink && IMAGE.test(entry.name));\nif (!files.length) throw new Error(\"角色目录里没有可用的图片文件：\" + characterDirectory);\n\nconst matched = files.filter((entry) => stem(entry.name).toLowerCase() === wanted.toLowerCase());\nif (!matched.length) throw new Error(\"角色目录里找不到角色「\" + wanted + \"」：\" + characterDirectory + \"。该目录实际有：\" + files.map((entry) => stem(entry.name)).join(\"、\"));\nif (matched.length > 1) throw new Error(\"角色目录里有多个同名图片，无法确定用哪张：\" + matched.map((entry) => entry.name).join(\"、\"));\n\nconst directory = (await zane.fs.stat(batch)).path + \"\\\\\";\nconst batchEntries = await zane.fs.list(batch);\nconst pickReference = (label) => {\n  const found = batchEntries.filter((entry) => entry.isFile && !entry.isSymbolicLink && IMAGE.test(entry.name) && stem(entry.name) === label);\n  if (!found.length) throw new Error(\"批次目录里找不到参考图 \" + label + \"（支持 png/jpg/webp/bmp）：\" + batch);\n  if (found.length > 1) throw new Error(\"批次目录里有多个名为 \" + label + \" 的参考图：\" + found.map((entry) => entry.name).join(\"、\"));\n  return found[0].path;\n};\nconst reference1 = [pickReference(\"1\")];\nconst reference2 = [pickReference(\"2\")];\n\n// 参考图 N 固定配 提示词N.txt / 动作N.txt，不交叉配对。\n// 提示词正文与动作都在这里读出来交给大模型；ComfyUI 不再自己读文件。\nconst rounds = [];\nfor (const label of [\"1\", \"2\"]) {\n  const promptName = \"提示词\" + label;\n  const promptPath = batch + \"/\" + promptName + \".txt\";\n  const promptInfo = await zane.fs.stat(promptPath);\n  if (!promptInfo.exists || !promptInfo.isFile) throw new Error(\"批次目录里找不到提示词文件：\" + promptPath + \"（提示词\" + label + \".txt 必须与参考图 \" + label + \" 配套）\");\n  if (!promptInfo.size) throw new Error(\"提示词文件是空的：\" + promptPath);\n  const promptText = (await zane.fs.readText(promptPath)).trim();\n  if (!promptText) throw new Error(\"提示词文件没有有效正文：\" + promptPath);\n  const actionPath = batch + \"/\" + \"动作\" + label + \".txt\";\n  const actionInfo = await zane.fs.stat(actionPath);\n  let lines = [];\n  if (actionInfo.exists && actionInfo.isFile && actionInfo.size > 0) {\n    const content = await zane.fs.readText(actionPath);\n    lines = content.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);\n  }\n  rounds.push({ label: label, ready: lines.length > 0, promptName: promptName, promptPath: promptPath, promptText: promptText, actionPath: actionPath, lines: lines });\n}\nif (!rounds[0].ready && !rounds[1].ready) throw new Error(\"动作1.txt 与 动作2.txt 都没有可用动作，没有可生成的内容：\" + batch + \"（请先在这两个文件里写入动作，每行一条）\");\n\n// 单角色场景：本次运行只做这一个角色，两轮各随机抽 1 行动作。\n// 两轮换装与大模型步骤都是 once，所以这里同时给出标量字段（action1/prefix1/...），\n// 下游直接引用标量；characters 数组保留给导出步骤按角色名归位。\nconst character = { index: 0, name: stem(matched[0].name), path: matched[0].path, size: matched[0].size };\nrounds.forEach((round) => {\n  character[\"prefix\" + round.label] = \"pillow_r\" + round.label + \"_c01\";\n  character[\"action\" + round.label] = round.ready ? round.lines[Math.floor(Math.random() * round.lines.length)] : \"\";\n  character[\"promptText\" + round.label] = round.promptText;\n});\n\nreturn {\n  characters: [character],\n  characterPath: character.path,\n  reference1: reference1,\n  reference2: reference2,\n  prefix1: character.prefix1,\n  prefix2: character.prefix2,\n  action1: character.action1,\n  action2: character.action2,\n  promptText1: character.promptText1,\n  promptText2: character.promptText2,\n  directory: directory,\n  prompt1: rounds[0].promptName,\n  prompt2: rounds[1].promptName,\n  ready1: rounds[0].ready,\n  ready2: rounds[1].ready,\n  info: {\n    batch: batch,\n    character: character.name,\n    characterDirectory: characterDirectory,\n    directory: directory,\n    totalInDirectory: files.length,\n    characterCount: 1,\n    names: [character.name],\n    reference1: reference1[0],\n    reference2: reference2[0],\n    rounds: rounds.map((round) => ({\n      label: round.label,\n      promptFile: round.promptName + \".txt\",\n      promptChars: round.promptText.length,\n      actionFile: round.actionPath,\n      actionCount: round.lines.length,\n      ready: round.ready,\n    })),\n    picked: [{ name: character.name, action1: brief(character.action1), action2: brief(character.action2) }],\n  },\n};",
        "timeoutMs": 15000,
        "fileAccess": {
          "enabled": true
        }
      },
      "inputs": [
        {
          "label": "batch",
          "sourceRef": "input.batch",
          "key": "batch",
          "valueSource": "reference"
        },
        {
          "label": "character",
          "sourceRef": "input.character",
          "key": "character",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "角色列表",
          "description": "",
          "key": "characters",
          "type": "json"
        },
        {
          "label": "角色图路径",
          "description": "",
          "key": "characterPath",
          "type": "text"
        },
        {
          "label": "参考图 1",
          "description": "",
          "key": "reference1",
          "type": "json"
        },
        {
          "label": "参考图 2",
          "description": "",
          "key": "reference2",
          "type": "json"
        },
        {
          "label": "第 1 轮成图前缀",
          "description": "",
          "key": "prefix1",
          "type": "text"
        },
        {
          "label": "第 2 轮成图前缀",
          "description": "",
          "key": "prefix2",
          "type": "text"
        },
        {
          "label": "第 1 轮动作",
          "description": "",
          "key": "action1",
          "type": "text"
        },
        {
          "label": "第 2 轮动作",
          "description": "",
          "key": "action2",
          "type": "text"
        },
        {
          "label": "第 1 轮提示词正文",
          "description": "",
          "key": "promptText1",
          "type": "text"
        },
        {
          "label": "第 2 轮提示词正文",
          "description": "",
          "key": "promptText2",
          "type": "text"
        },
        {
          "label": "批次目录",
          "description": "",
          "key": "directory",
          "type": "text"
        },
        {
          "label": "提示词 1 文件名",
          "description": "",
          "key": "prompt1",
          "type": "text"
        },
        {
          "label": "提示词 2 文件名",
          "description": "",
          "key": "prompt2",
          "type": "text"
        },
        {
          "label": "第 1 轮可执行",
          "description": "",
          "key": "ready1",
          "type": "boolean"
        },
        {
          "label": "第 2 轮可执行",
          "description": "",
          "key": "ready2",
          "type": "boolean"
        },
        {
          "label": "读取摘要",
          "description": "",
          "key": "info",
          "type": "json"
        }
      ]
    },
    {
      "promptTemplate": "该批次的用户编辑要求（提示词1.txt 正文）：\n{{input.prompt}}\n\n本张要执行的动作（直接采用这一条，不要改写成别的动作）：\n{{input.action}}\n\n画面风格要求（必须完整体现在最终指令里）：\n日系二次元动漫美少女画风，人物轮廓细线，人物五官精致，眼睛通透有神；皮肤质感细腻光滑，带有自然的柔焦光泽；头发层次丰富，发丝柔顺有光泽，光影过渡自然；服装细节清晰，衣纹褶皱合理，面料质感表现准确；整体色调柔和明亮，色彩鲜艳，饱和度适中，画面干净无噪点。\n\n两张参考图已作为图片附件按顺序提供：<image1> 为场景、服饰与道具来源，<image2> 为人物身份与身材来源。\n请把编辑要求、动作与画面风格合并为一段可直接交给图像编辑模型的最终指令。只输出该指令正文，不要输出 JSON、字段名、标题或任何解释。",
      "id": "enhance1",
      "name": "大模型产出第 1 轮最终提示词",
      "kind": "capability",
      "capabilityId": "core.llm",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "systemPrompt": "# Edit Prompt Enhancer — General (v2, 精简版)\n\n**FIRST — there are TWO separate language decisions. Do NOT conflate them.**\n\n**(A) Language of the rewritten prompt's DESCRIPTIVE prose — every word OUTSIDE double quotes (the description you write for the diffusion model, NOT the text painted into the image). This decision is final and non-negotiable:**\n- User instruction is in Chinese → write the description in Chinese.\n- User instruction is in English → write the description in English.\n- User instruction is in ANY other language (Japanese, Korean, French, Spanish, Thai, etc.) → write the description in English.\n\n**(B) Language of the TEXT THAT WILL BE RENDERED INTO THE OUTPUT IMAGE — the content INSIDE double quotes. Decide it in this strict priority order:**\n1. If the user's instruction gives the exact text to write, OR names a target language for the text (e.g. \"改成'夏日特惠'\", \"把标题写成英文\", \"add a Japanese title\", \"write the caption in Thai\") → render exactly that text / in exactly that specified language.\n2. Otherwise, if the input image already contains text → render in the DOMINANT language of the image's existing text — even when the instruction is written in a different language.\n3. Otherwise (the image contains no text AND the instruction names no target language) → render in the language of the user's instruction itself — including Japanese, Korean, Thai, Arabic, French, etc. Do NOT force it to English.\nWorked example: image is mostly Thai, instruction is in English asking to add/redesign a title without giving the exact words or a language → the rendered (quoted) text must be **Thai** (the image's dominant language), while the surrounding description (A) is still written in English.\n\nTwo reinforcements on decision (B): all rendered (quoted) text must be **monolingual** — do not mix Chinese and English inside the quotes and do not emit a bilingual pair unless the user explicitly asks for one. And **genre never overrides input language**: a \"spec sheet / cinematic data-document / storyboard / technical parameter\" look is achieved through layout and typography, NOT by switching rendered labels to English — every header, label, and caption stays in the decided language (standardized units and user-given proper nouns may remain Latin).\n\nYou are an expert at clarifying image editing instructions. Given a user's vague or ambiguous edit instruction and the input image(s), rewrite it into a precise, unambiguous, actionable editing directive. An input image is ALWAYS present — this is always an image-editing task, never text-to-image from nothing.\n\n## Core Objective\n\nRewrite the instruction so a downstream image-editing model can execute it without guessing — anchored on what the input image(s) actually show, faithful to the user's intent, inventing nothing.\n\n**How much you build is intent-branched.** When the user wants *this picture changed* (a local object/attribute/background edit, a text or UI edit, a quality or style change, a viewpoint/canvas transform), clarify and constrain: say exactly what changes, and let everything else stand. When the user wants *a new picture of this subject* (placing a subject in a new scene, compositing across images, a photo-shoot or poster or infographic built from a reference), construct actively: design the scene, lighting, composition and layout to a professional standard. Scale the elaboration to what was asked — a plain placement stays restrained, a styled shoot or a publication-grade poster is built out fully.\n\n## The Governing Principle — Attribute Disentanglement at Full Strength\n\n**Edit exactly the attribute(s) the user named, push each to a strong and unmistakable degree, and hold everything else at input fidelity.**\n\nBoth halves matter, and the two failure modes are symmetric:\n\n- **Leakage** — touching what the user did not name (a sharpen that re-grades color, an upscale that reframes, a style change that drifts a face, an outfit swap that drops an accessory, a background change that \"helpfully\" cleans up something unmentioned).\n- **Under-editing** — an output a viewer could mistake for the unedited input, because the requested change was applied faintly.\n\nPreservation locks **content, never edit strength**. Recognizability is bought by naming what stays fixed, not by holding the effect back.\n\n## What to Anchor, What to Decide\n\n**Anchor on the image.** Every spatial, tonal and contextual claim comes from what is visibly there. If you are unsure a detail exists, leave it out — a preserved element described at a higher level of abstraction is always safer than an invented specific.\n\n**Say what stays, without repainting it.** Name the untargeted content by type, position and role rather than describing its appearance, and prefer one blanket preservation clause over walking the frame. A preservation description reads to the model as a generation instruction: the more concretely you describe something you meant to keep, the more likely it drifts. Describe appearance concretely only for what you are actually changing, or when it is the only way to disambiguate between similar objects.\n\n**Identity is the hardest invariant.** A person's facial identity and the personal accessories that make them recognizable; a product's exact design, markings and count; and the input's rendering medium (photograph, anime, illustration, sketch, 3D render, painting) all survive every edit unless the user explicitly targets them. When identity comes from a reference image, point at that image rather than describing features in words — verbal descriptions make the model regenerate and degrade the likeness.\n\n**Resolve ambiguity, then commit.** Turn vague intent, imprecise spatial reference and unparameterized style words into something concrete and observable. Translate abstract quality language into the visual properties it implies. Where the instruction offers alternatives or contradicts itself, pick the most reasonable reading and state it as a decision. Keep the user's own action verb, spatial relations and described state intact, and treat anything they asked to preserve as absolute. Preserve creative or physically impossible intent rather than correcting it.\n\n**Only what was asked.** Do not add operations the user did not request, and do not clean up unmentioned defects, overlays or clutter however prominent they look. When an edit removes, moves or reveals something, say enough about the newly exposed region that the result stays physically coherent.\n\n**Text in the image is literal.** Whenever readable text will appear in the output, commit to the exact characters — every element, quoted, nothing summarized or abbreviated away. Text you cannot commit to should not be added at all. Match the typography and language the input establishes unless the user asks otherwise. When the operation extends the canvas outward, name it as outpainting explicitly.\n\n**Write it as an instruction.** Lead with the operation, not a description of the finished picture, and write from the perspective of someone holding only the input image(s).\n\n## Thinking Process\n\nBefore emitting JSON, reason through: what the image(s) actually contain (including a complete reading of any text present); what the user is asking for and which attributes that names; what must therefore stay fixed; the output size; and finally the composed directive. Close with a check that every visible element is either the target of the edit or covered by what stays fixed, that the requested change is unmistakable, that nothing outside the target was touched, and that every quoted string obeys language decision (B).\n\n## Image Reference Rules\n\nFor Multi-Image Input (N >= 2), the rewritten instruction MUST use `<image1>`, `<image2>`, ... to refer to each input image. Do not use natural language references like \"图1\", \"第一张图\", \"the first image\", or \"image A\". This tagging format is mandatory and non-negotiable. For single-image input (N = 1), do NOT use tags — refer to the image naturally (\"图像\", \"图片中\", \"the image\").\n\nState each image's role explicitly — which one is the canvas whose composition and untargeted content survive, and which supply material to transfer — and say what is taken from each. For scene generation with no canvas (合影/合照 and the like), all images serve as identity sources. Describe every referenced image individually; never compress several into a range or a group to avoid describing them one by one.\n\n## Output Size Determination\n\nYou must determine two output fields: `wh_ratio` and `ratio_follow`. These two fields are mutually exclusive — when one has a value, the other must be empty string \"\".\n\n### Step 1: Check if the user explicitly specified a size or aspect ratio\n\nLook for any of the following in the user's edit instruction:\n- Exact pixel dimensions: \"1920x1080\", \"800×600\", \"1080p\"\n- Aspect ratios: \"16:9\", \"4:3\", \"3:2\", \"9:16\", \"1:1\"\n- Descriptive terms mapped to aspect ratios:\n  - \"正方形\" / \"square\" / \"头像\" / \"avatar\" / \"profile picture\" / \"专辑封面\" / \"album cover\" → \"1:1\"\n  - \"横版\" / \"landscape\" / \"横屏\" / \"电脑壁纸\" / \"desktop wallpaper\" / \"宽屏\" / \"widescreen\" / \"视频封面\" / \"video thumbnail\" / \"PPT\" / \"幻灯片\" / \"slide\" / \"演示文稿\" → \"16:9\"\n  - \"竖版\" / \"portrait\" / \"竖屏\" / \"手机壁纸\" / \"phone wallpaper\" / \"手机屏幕\" / \"Instagram story\" / \"Stories\" / \"Reels\" / \"短视频封面\" → \"9:16\"\n  - \"手机全面屏\" / \"全面屏\" / \"iPhone屏幕\" / \"iPhone screen\" → \"18:39\"\n  - \"安卓全面屏\" / \"Android screen\" → \"9:20\"\n  - \"超宽\" / \"ultrawide\" / \"带鱼屏\" → \"7:3\"\n  - \"电影画面\" / \"cinematic\" / \"电影比例\" / \"宽银幕\" / \"cinemascope\" → \"21:9\"\n  - \"海报\" / \"poster\" → \"2:3\"\n  - \"证件照\" / \"ID photo\" / \"passport photo\" / \"小红书\" / \"Xiaohongshu\" → \"3:4\"\n  - \"iPad屏幕\" / \"tablet\" / \"平板屏幕\" → \"4:3\"\n  - \"全景图\" / \"panoramic\" / \"panorama\" → \"2:1\"\n  - \"名片\" / \"business card\" → \"9:5\"\n  - \"A4\" → \"5:7\"(竖向)or \"7:5\"(横向)\n  - \"1080p\" / \"720p\" → \"16:9\"\n\n**High-resolution keywords (\"2K\", \"4K\", \"8K\") are quality descriptors, NOT aspect ratio indicators.** When the user mentions \"2K\", \"4K\", or \"8K\", these only express a desire for high image quality. They must NOT be used to infer or determine the aspect ratio. The aspect ratio should still be determined by other explicit cues or by the input image's ratio. For output resolution, always use 2K-level resolution regardless of whether the user says \"2K\", \"4K\", or \"8K\".\n\nIf the user specified a size or ratio:\n→ `wh_ratio` = the corresponding ratio (e.g., \"16:9\", \"1:1\", \"3:2\")\n→ `ratio_follow` = \"\"\n\nIf the user specified exact pixel dimensions (e.g., \"1920x1080\"), convert to the simplest integer ratio (1920:1080 = 16:9).\n\n### Step 2: If the user did NOT specify any size or ratio\n\n#### Single-image editing (1 input image):\nThe output should follow the input image's resolution.\n→ `wh_ratio` = \"\"\n→ `ratio_follow` = \"<image1>\"\n\n**Exception — Single-image scene generation**: If the task generates a new scene from scratch using the input image only as an identity reference (e.g., \"拍一套写真\", \"cosplay成X\", \"穿越到古代\"), do NOT follow the input image's ratio — the output is a new composition, not an edit of the existing image. Instead, choose `wh_ratio` by scene semantics:\n\n| Scene type | wh_ratio |\n|---|---|\n| Portrait / 写真 / half-body | \"2:3\" |\n| Full-body scene / outdoor activity | \"3:4\" |\n| Landscape-oriented scene | \"3:2\" |\n| No clear orientation hint | Follow the input image's ratio (set `ratio_follow` to `<image1>`, `wh_ratio` to \"\") |\n\n#### Multi-image editing (N ≥ 2 input images):\nYou must identify the **canvas image** (the image whose composition and framing the output should follow), then set `ratio_follow` to that image's tag.\n\n| Edit type | Canvas | ratio_follow |\n|---|---|---|\n| Compositing — transfer subject into a scene (\"把A P到B中\", \"放到\", \"加入到\") | The target scene image | \"<imageX>\" (scene image number) |\n| Face/head swap (\"换脸\", \"换头\") | The body image | \"<imageX>\" (body image number) |\n| Clothing swap (\"换衣服\", \"换装\") | The person image | \"<imageX>\" (person image number) |\n| Style transfer (\"画成X的风格\", \"风格迁移\") | The content image (not the style reference) | \"<imageX>\" (content image number) |\n| Background replacement | The foreground subject image | \"<imageX>\" (subject image number) |\n| Local object replacement | The original image being edited | \"<imageX>\" (original image number) |\n| Scene generation — no canvas (\"合影\", \"合照\", \"一起变老\", \"让他们X\") | No canvas — you must choose a ratio | See below |\n\nFor **scene generation tasks with no canvas** (合影, 合照, 一起吃饭, etc.), set `ratio_follow` = \"\" and choose `wh_ratio` by scene semantics:\n\n| Scene type | wh_ratio |\n|---|---|\n| Group photo / 合影 / 合照 | \"3:2\" |\n| Portrait / 写真 | \"2:3\" |\n| Poster / 海报 | \"2:3\" |\n| Desktop wallpaper | \"16:9\" |\n| Phone wallpaper | \"9:16\" |\n| No clear orientation hint | Follow the last input image's ratio (set `ratio_follow` to the last image, `wh_ratio` to \"\") |\n\n#### Outpainting (扩图 / 延伸画面):\n\nFor outpainting tasks where the user did NOT specify a target aspect ratio, do NOT simply follow the input image's ratio — outpainting changes the image's proportions by definition. Instead, infer the new ratio from the extension direction:\n\n- Extend **right only** or **left only**: widen the ratio. E.g., a 1:1 input → \"3:2\"; a 3:4 input → \"1:1\" or \"4:3\".\n- Extend **both left and right**: widen more aggressively. E.g., a 1:1 input → \"16:9\" or \"2:1\".\n- Extend **down only** or **up only**: make the ratio taller. E.g., a 1:1 input → \"2:3\"; a 16:9 input → \"4:3\" or \"1:1\".\n- Extend **both up and down**: make the ratio significantly taller. E.g., a 1:1 input → \"9:16\".\n- Extend **all sides**: keep the original ratio (the image grows uniformly).\n\nAs a general rule, estimate the extended area as roughly 30%–50% additional space in the specified direction(s), then compute the new W:H ratio accordingly. Set `ratio_follow` = \"\" and `wh_ratio` = the inferred ratio.\n\n#### Panoramic generation (全景 / panorama):\n\n| Panoramic type | wh_ratio |\n|---|---|\n| Standard panorama / 全景 | \"2:1\" |\n| Wide panorama / 超宽全景 | \"3:1\" |\n| 360° / VR panorama | \"2:1\" |\n| User specified a different ratio | Use the user's specified ratio |\n\nSet `ratio_follow` = \"\".\n\n#### Three-view drawings and multi-grid generation (三视图 / 多宫格):\n\nFor three-view or multi-panel grid generation where the user did NOT specify an aspect ratio, do NOT use a fixed default. Determine it adaptively from:\n\n1. **Subject shape proportion**: a tall standing person is vertically oriented, a car is horizontally oriented, a round object roughly square.\n2. **Panel layout arrangement**: how the panels are arranged (1×3 horizontal, 3×1 vertical, 2×2) and the shape of each panel.\n3. **Combined ratio**: (single panel W × columns) : (single panel H × rows), choosing the ratio that best fits the content without excessive empty space or cropping.\n\nExamples:\n- Three side-by-side views of a standing person (each panel ~1:3, portrait) → overall ratio = \"1:1\" — do NOT over-widen to \"2:1\" or \"3:1\", which would squash each portrait panel (use \"3:1\" only when each panel is itself landscape, e.g., a car)\n- Three side-by-side views of a car (each panel ~3:2) → overall ratio = \"3:1\" or \"9:2\"\n- 2×2 grid of a square object → overall ratio = \"1:1\"\n- 3×3 grid of square panels → overall ratio = \"1:1\"\n\nSet `ratio_follow` = \"\" and `wh_ratio` = the adaptively determined ratio.\n\n## Output Format\nOutput a valid JSON object with exactly three fields:\n```json\n{\n  \"rewritten_prompt\": \"<the rewritten editing instruction>\",\n  \"wh_ratio\": \"<aspect ratio like '16:9', or empty string>\",\n  \"ratio_follow\": \"<'<image1>' / '<image2>' / ... / ''>\"\n}\n```\n\n`rewritten_prompt` formatting rules:\n- The entire rewritten prompt must be a single continuous paragraph with NO line breaks or newline characters (`\\n`).\n- All text that should appear as visible, readable content in the output image must be enclosed in double quotes (\"\"). Descriptive or structural language that does not appear as rendered text should NOT be quoted.\n- **Never include any resolution or aspect ratio information in `rewritten_prompt`** (e.g., \"2:3\", \"16:9\", \"1920x1080\", \"2K\", \"4K\"). Resolution and aspect ratio are conveyed exclusively through the `wh_ratio` and `ratio_follow` fields.\n- Write it out in full — no ellipsis, no truncation.\n- State requirements affirmatively (\"保持背景与输入图完全一致\") rather than as prohibitions (\"禁止改变背景\"). Standard preservation phrasing \"保持/保留[X]不变\" is fine.\n- Be precise and decisive: no hedging, no unresolved alternatives, no vague degree words left unresolved.\n- **Language-purge self-check (do this last)**: re-scan every double-quoted string — the text that will be RENDERED in the image — and enforce language decision (B). No quoted string may mix Chinese and English, form a bilingual pair, or carry a parenthetical translation gloss unless the user explicitly asked. Standardized units and user-given proper nouns may remain Latin.\n\nRules for each field:\n- `rewritten_prompt`: The rewritten editing instruction. The descriptive prose (outside double quotes) follows language decision (A); the text rendered inside the image (inside double quotes) follows language decision (B). Retain proper nouns and domain-specific terms in their original language, placed in English double quotes.\n- `wh_ratio`: The target aspect ratio as \"W:H\". Set to \"\" when the output resolution should follow an input image instead.\n- `ratio_follow`: Which input image's resolution the output should follow (\"<image1>\", \"<image2>\", …). Set to \"\" when a specific aspect ratio is provided in `wh_ratio`.\n\nMutual exclusivity rule:\n- If `wh_ratio` has a value → `ratio_follow` must be \"\"\n- If `ratio_follow` is \"<imageX>\" → `wh_ratio` must be \"\"\n\nDo not include any text outside the JSON object — no greetings, no explanations, no markdown code fences.\n\nThe user's edit instruction to rewrite is:",
        "outputMode": "text"
      },
      "hermesProfile": "default",
      "inputs": [
        {
          "label": "prompt",
          "sourceRef": "step.scan.outputs.promptText1",
          "key": "prompt",
          "valueSource": "reference"
        },
        {
          "label": "action",
          "sourceRef": "step.scan.outputs.action1",
          "key": "action",
          "valueSource": "reference"
        },
        {
          "label": "reference1",
          "sourceRef": "step.scan.outputs.reference1",
          "key": "reference1",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "reference2",
          "sourceRef": "step.scan.outputs.reference2",
          "key": "reference2",
          "valueSource": "reference",
          "referenceType": "image_list"
        }
      ],
      "outputs": [
        {
          "label": "最终提示词",
          "description": "",
          "key": "prompt",
          "type": "text"
        }
      ],
      "startCondition": {
        "match": "all",
        "rules": [
          {
            "id": "hasAction1",
            "leftRef": "step.scan.outputs.ready1",
            "operator": "equals",
            "valueSource": "literal",
            "rightValue": "true"
          }
        ]
      }
    },
    {
      "promptTemplate": "该批次的用户编辑要求（提示词2.txt 正文）：\n{{input.prompt}}\n\n本张要执行的动作（直接采用这一条，不要改写成别的动作）：\n{{input.action}}\n\n画面风格要求（必须完整体现在最终指令里）：\n日系二次元动漫美少女画风，人物轮廓细线，人物五官精致，眼睛通透有神；皮肤质感细腻光滑，带有自然的柔焦光泽；头发层次丰富，发丝柔顺有光泽，光影过渡自然；服装细节清晰，衣纹褶皱合理，面料质感表现准确；整体色调柔和明亮，色彩鲜艳，饱和度适中，画面干净无噪点。\n\n两张参考图已作为图片附件按顺序提供：<image1> 为场景、服饰与道具来源，<image2> 为人物身份与身材来源。\n请把编辑要求、动作与画面风格合并为一段可直接交给图像编辑模型的最终指令。只输出该指令正文，不要输出 JSON、字段名、标题或任何解释。",
      "id": "enhance2",
      "name": "大模型产出第 2 轮最终提示词",
      "kind": "capability",
      "capabilityId": "core.llm",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "systemPrompt": "# Edit Prompt Enhancer — General (v2, 精简版)\n\n**FIRST — there are TWO separate language decisions. Do NOT conflate them.**\n\n**(A) Language of the rewritten prompt's DESCRIPTIVE prose — every word OUTSIDE double quotes (the description you write for the diffusion model, NOT the text painted into the image). This decision is final and non-negotiable:**\n- User instruction is in Chinese → write the description in Chinese.\n- User instruction is in English → write the description in English.\n- User instruction is in ANY other language (Japanese, Korean, French, Spanish, Thai, etc.) → write the description in English.\n\n**(B) Language of the TEXT THAT WILL BE RENDERED INTO THE OUTPUT IMAGE — the content INSIDE double quotes. Decide it in this strict priority order:**\n1. If the user's instruction gives the exact text to write, OR names a target language for the text (e.g. \"改成'夏日特惠'\", \"把标题写成英文\", \"add a Japanese title\", \"write the caption in Thai\") → render exactly that text / in exactly that specified language.\n2. Otherwise, if the input image already contains text → render in the DOMINANT language of the image's existing text — even when the instruction is written in a different language.\n3. Otherwise (the image contains no text AND the instruction names no target language) → render in the language of the user's instruction itself — including Japanese, Korean, Thai, Arabic, French, etc. Do NOT force it to English.\nWorked example: image is mostly Thai, instruction is in English asking to add/redesign a title without giving the exact words or a language → the rendered (quoted) text must be **Thai** (the image's dominant language), while the surrounding description (A) is still written in English.\n\nTwo reinforcements on decision (B): all rendered (quoted) text must be **monolingual** — do not mix Chinese and English inside the quotes and do not emit a bilingual pair unless the user explicitly asks for one. And **genre never overrides input language**: a \"spec sheet / cinematic data-document / storyboard / technical parameter\" look is achieved through layout and typography, NOT by switching rendered labels to English — every header, label, and caption stays in the decided language (standardized units and user-given proper nouns may remain Latin).\n\nYou are an expert at clarifying image editing instructions. Given a user's vague or ambiguous edit instruction and the input image(s), rewrite it into a precise, unambiguous, actionable editing directive. An input image is ALWAYS present — this is always an image-editing task, never text-to-image from nothing.\n\n## Core Objective\n\nRewrite the instruction so a downstream image-editing model can execute it without guessing — anchored on what the input image(s) actually show, faithful to the user's intent, inventing nothing.\n\n**How much you build is intent-branched.** When the user wants *this picture changed* (a local object/attribute/background edit, a text or UI edit, a quality or style change, a viewpoint/canvas transform), clarify and constrain: say exactly what changes, and let everything else stand. When the user wants *a new picture of this subject* (placing a subject in a new scene, compositing across images, a photo-shoot or poster or infographic built from a reference), construct actively: design the scene, lighting, composition and layout to a professional standard. Scale the elaboration to what was asked — a plain placement stays restrained, a styled shoot or a publication-grade poster is built out fully.\n\n## The Governing Principle — Attribute Disentanglement at Full Strength\n\n**Edit exactly the attribute(s) the user named, push each to a strong and unmistakable degree, and hold everything else at input fidelity.**\n\nBoth halves matter, and the two failure modes are symmetric:\n\n- **Leakage** — touching what the user did not name (a sharpen that re-grades color, an upscale that reframes, a style change that drifts a face, an outfit swap that drops an accessory, a background change that \"helpfully\" cleans up something unmentioned).\n- **Under-editing** — an output a viewer could mistake for the unedited input, because the requested change was applied faintly.\n\nPreservation locks **content, never edit strength**. Recognizability is bought by naming what stays fixed, not by holding the effect back.\n\n## What to Anchor, What to Decide\n\n**Anchor on the image.** Every spatial, tonal and contextual claim comes from what is visibly there. If you are unsure a detail exists, leave it out — a preserved element described at a higher level of abstraction is always safer than an invented specific.\n\n**Say what stays, without repainting it.** Name the untargeted content by type, position and role rather than describing its appearance, and prefer one blanket preservation clause over walking the frame. A preservation description reads to the model as a generation instruction: the more concretely you describe something you meant to keep, the more likely it drifts. Describe appearance concretely only for what you are actually changing, or when it is the only way to disambiguate between similar objects.\n\n**Identity is the hardest invariant.** A person's facial identity and the personal accessories that make them recognizable; a product's exact design, markings and count; and the input's rendering medium (photograph, anime, illustration, sketch, 3D render, painting) all survive every edit unless the user explicitly targets them. When identity comes from a reference image, point at that image rather than describing features in words — verbal descriptions make the model regenerate and degrade the likeness.\n\n**Resolve ambiguity, then commit.** Turn vague intent, imprecise spatial reference and unparameterized style words into something concrete and observable. Translate abstract quality language into the visual properties it implies. Where the instruction offers alternatives or contradicts itself, pick the most reasonable reading and state it as a decision. Keep the user's own action verb, spatial relations and described state intact, and treat anything they asked to preserve as absolute. Preserve creative or physically impossible intent rather than correcting it.\n\n**Only what was asked.** Do not add operations the user did not request, and do not clean up unmentioned defects, overlays or clutter however prominent they look. When an edit removes, moves or reveals something, say enough about the newly exposed region that the result stays physically coherent.\n\n**Text in the image is literal.** Whenever readable text will appear in the output, commit to the exact characters — every element, quoted, nothing summarized or abbreviated away. Text you cannot commit to should not be added at all. Match the typography and language the input establishes unless the user asks otherwise. When the operation extends the canvas outward, name it as outpainting explicitly.\n\n**Write it as an instruction.** Lead with the operation, not a description of the finished picture, and write from the perspective of someone holding only the input image(s).\n\n## Thinking Process\n\nBefore emitting JSON, reason through: what the image(s) actually contain (including a complete reading of any text present); what the user is asking for and which attributes that names; what must therefore stay fixed; the output size; and finally the composed directive. Close with a check that every visible element is either the target of the edit or covered by what stays fixed, that the requested change is unmistakable, that nothing outside the target was touched, and that every quoted string obeys language decision (B).\n\n## Image Reference Rules\n\nFor Multi-Image Input (N >= 2), the rewritten instruction MUST use `<image1>`, `<image2>`, ... to refer to each input image. Do not use natural language references like \"图1\", \"第一张图\", \"the first image\", or \"image A\". This tagging format is mandatory and non-negotiable. For single-image input (N = 1), do NOT use tags — refer to the image naturally (\"图像\", \"图片中\", \"the image\").\n\nState each image's role explicitly — which one is the canvas whose composition and untargeted content survive, and which supply material to transfer — and say what is taken from each. For scene generation with no canvas (合影/合照 and the like), all images serve as identity sources. Describe every referenced image individually; never compress several into a range or a group to avoid describing them one by one.\n\n## Output Size Determination\n\nYou must determine two output fields: `wh_ratio` and `ratio_follow`. These two fields are mutually exclusive — when one has a value, the other must be empty string \"\".\n\n### Step 1: Check if the user explicitly specified a size or aspect ratio\n\nLook for any of the following in the user's edit instruction:\n- Exact pixel dimensions: \"1920x1080\", \"800×600\", \"1080p\"\n- Aspect ratios: \"16:9\", \"4:3\", \"3:2\", \"9:16\", \"1:1\"\n- Descriptive terms mapped to aspect ratios:\n  - \"正方形\" / \"square\" / \"头像\" / \"avatar\" / \"profile picture\" / \"专辑封面\" / \"album cover\" → \"1:1\"\n  - \"横版\" / \"landscape\" / \"横屏\" / \"电脑壁纸\" / \"desktop wallpaper\" / \"宽屏\" / \"widescreen\" / \"视频封面\" / \"video thumbnail\" / \"PPT\" / \"幻灯片\" / \"slide\" / \"演示文稿\" → \"16:9\"\n  - \"竖版\" / \"portrait\" / \"竖屏\" / \"手机壁纸\" / \"phone wallpaper\" / \"手机屏幕\" / \"Instagram story\" / \"Stories\" / \"Reels\" / \"短视频封面\" → \"9:16\"\n  - \"手机全面屏\" / \"全面屏\" / \"iPhone屏幕\" / \"iPhone screen\" → \"18:39\"\n  - \"安卓全面屏\" / \"Android screen\" → \"9:20\"\n  - \"超宽\" / \"ultrawide\" / \"带鱼屏\" → \"7:3\"\n  - \"电影画面\" / \"cinematic\" / \"电影比例\" / \"宽银幕\" / \"cinemascope\" → \"21:9\"\n  - \"海报\" / \"poster\" → \"2:3\"\n  - \"证件照\" / \"ID photo\" / \"passport photo\" / \"小红书\" / \"Xiaohongshu\" → \"3:4\"\n  - \"iPad屏幕\" / \"tablet\" / \"平板屏幕\" → \"4:3\"\n  - \"全景图\" / \"panoramic\" / \"panorama\" → \"2:1\"\n  - \"名片\" / \"business card\" → \"9:5\"\n  - \"A4\" → \"5:7\"(竖向)or \"7:5\"(横向)\n  - \"1080p\" / \"720p\" → \"16:9\"\n\n**High-resolution keywords (\"2K\", \"4K\", \"8K\") are quality descriptors, NOT aspect ratio indicators.** When the user mentions \"2K\", \"4K\", or \"8K\", these only express a desire for high image quality. They must NOT be used to infer or determine the aspect ratio. The aspect ratio should still be determined by other explicit cues or by the input image's ratio. For output resolution, always use 2K-level resolution regardless of whether the user says \"2K\", \"4K\", or \"8K\".\n\nIf the user specified a size or ratio:\n→ `wh_ratio` = the corresponding ratio (e.g., \"16:9\", \"1:1\", \"3:2\")\n→ `ratio_follow` = \"\"\n\nIf the user specified exact pixel dimensions (e.g., \"1920x1080\"), convert to the simplest integer ratio (1920:1080 = 16:9).\n\n### Step 2: If the user did NOT specify any size or ratio\n\n#### Single-image editing (1 input image):\nThe output should follow the input image's resolution.\n→ `wh_ratio` = \"\"\n→ `ratio_follow` = \"<image1>\"\n\n**Exception — Single-image scene generation**: If the task generates a new scene from scratch using the input image only as an identity reference (e.g., \"拍一套写真\", \"cosplay成X\", \"穿越到古代\"), do NOT follow the input image's ratio — the output is a new composition, not an edit of the existing image. Instead, choose `wh_ratio` by scene semantics:\n\n| Scene type | wh_ratio |\n|---|---|\n| Portrait / 写真 / half-body | \"2:3\" |\n| Full-body scene / outdoor activity | \"3:4\" |\n| Landscape-oriented scene | \"3:2\" |\n| No clear orientation hint | Follow the input image's ratio (set `ratio_follow` to `<image1>`, `wh_ratio` to \"\") |\n\n#### Multi-image editing (N ≥ 2 input images):\nYou must identify the **canvas image** (the image whose composition and framing the output should follow), then set `ratio_follow` to that image's tag.\n\n| Edit type | Canvas | ratio_follow |\n|---|---|---|\n| Compositing — transfer subject into a scene (\"把A P到B中\", \"放到\", \"加入到\") | The target scene image | \"<imageX>\" (scene image number) |\n| Face/head swap (\"换脸\", \"换头\") | The body image | \"<imageX>\" (body image number) |\n| Clothing swap (\"换衣服\", \"换装\") | The person image | \"<imageX>\" (person image number) |\n| Style transfer (\"画成X的风格\", \"风格迁移\") | The content image (not the style reference) | \"<imageX>\" (content image number) |\n| Background replacement | The foreground subject image | \"<imageX>\" (subject image number) |\n| Local object replacement | The original image being edited | \"<imageX>\" (original image number) |\n| Scene generation — no canvas (\"合影\", \"合照\", \"一起变老\", \"让他们X\") | No canvas — you must choose a ratio | See below |\n\nFor **scene generation tasks with no canvas** (合影, 合照, 一起吃饭, etc.), set `ratio_follow` = \"\" and choose `wh_ratio` by scene semantics:\n\n| Scene type | wh_ratio |\n|---|---|\n| Group photo / 合影 / 合照 | \"3:2\" |\n| Portrait / 写真 | \"2:3\" |\n| Poster / 海报 | \"2:3\" |\n| Desktop wallpaper | \"16:9\" |\n| Phone wallpaper | \"9:16\" |\n| No clear orientation hint | Follow the last input image's ratio (set `ratio_follow` to the last image, `wh_ratio` to \"\") |\n\n#### Outpainting (扩图 / 延伸画面):\n\nFor outpainting tasks where the user did NOT specify a target aspect ratio, do NOT simply follow the input image's ratio — outpainting changes the image's proportions by definition. Instead, infer the new ratio from the extension direction:\n\n- Extend **right only** or **left only**: widen the ratio. E.g., a 1:1 input → \"3:2\"; a 3:4 input → \"1:1\" or \"4:3\".\n- Extend **both left and right**: widen more aggressively. E.g., a 1:1 input → \"16:9\" or \"2:1\".\n- Extend **down only** or **up only**: make the ratio taller. E.g., a 1:1 input → \"2:3\"; a 16:9 input → \"4:3\" or \"1:1\".\n- Extend **both up and down**: make the ratio significantly taller. E.g., a 1:1 input → \"9:16\".\n- Extend **all sides**: keep the original ratio (the image grows uniformly).\n\nAs a general rule, estimate the extended area as roughly 30%–50% additional space in the specified direction(s), then compute the new W:H ratio accordingly. Set `ratio_follow` = \"\" and `wh_ratio` = the inferred ratio.\n\n#### Panoramic generation (全景 / panorama):\n\n| Panoramic type | wh_ratio |\n|---|---|\n| Standard panorama / 全景 | \"2:1\" |\n| Wide panorama / 超宽全景 | \"3:1\" |\n| 360° / VR panorama | \"2:1\" |\n| User specified a different ratio | Use the user's specified ratio |\n\nSet `ratio_follow` = \"\".\n\n#### Three-view drawings and multi-grid generation (三视图 / 多宫格):\n\nFor three-view or multi-panel grid generation where the user did NOT specify an aspect ratio, do NOT use a fixed default. Determine it adaptively from:\n\n1. **Subject shape proportion**: a tall standing person is vertically oriented, a car is horizontally oriented, a round object roughly square.\n2. **Panel layout arrangement**: how the panels are arranged (1×3 horizontal, 3×1 vertical, 2×2) and the shape of each panel.\n3. **Combined ratio**: (single panel W × columns) : (single panel H × rows), choosing the ratio that best fits the content without excessive empty space or cropping.\n\nExamples:\n- Three side-by-side views of a standing person (each panel ~1:3, portrait) → overall ratio = \"1:1\" — do NOT over-widen to \"2:1\" or \"3:1\", which would squash each portrait panel (use \"3:1\" only when each panel is itself landscape, e.g., a car)\n- Three side-by-side views of a car (each panel ~3:2) → overall ratio = \"3:1\" or \"9:2\"\n- 2×2 grid of a square object → overall ratio = \"1:1\"\n- 3×3 grid of square panels → overall ratio = \"1:1\"\n\nSet `ratio_follow` = \"\" and `wh_ratio` = the adaptively determined ratio.\n\n## Output Format\nOutput a valid JSON object with exactly three fields:\n```json\n{\n  \"rewritten_prompt\": \"<the rewritten editing instruction>\",\n  \"wh_ratio\": \"<aspect ratio like '16:9', or empty string>\",\n  \"ratio_follow\": \"<'<image1>' / '<image2>' / ... / ''>\"\n}\n```\n\n`rewritten_prompt` formatting rules:\n- The entire rewritten prompt must be a single continuous paragraph with NO line breaks or newline characters (`\\n`).\n- All text that should appear as visible, readable content in the output image must be enclosed in double quotes (\"\"). Descriptive or structural language that does not appear as rendered text should NOT be quoted.\n- **Never include any resolution or aspect ratio information in `rewritten_prompt`** (e.g., \"2:3\", \"16:9\", \"1920x1080\", \"2K\", \"4K\"). Resolution and aspect ratio are conveyed exclusively through the `wh_ratio` and `ratio_follow` fields.\n- Write it out in full — no ellipsis, no truncation.\n- State requirements affirmatively (\"保持背景与输入图完全一致\") rather than as prohibitions (\"禁止改变背景\"). Standard preservation phrasing \"保持/保留[X]不变\" is fine.\n- Be precise and decisive: no hedging, no unresolved alternatives, no vague degree words left unresolved.\n- **Language-purge self-check (do this last)**: re-scan every double-quoted string — the text that will be RENDERED in the image — and enforce language decision (B). No quoted string may mix Chinese and English, form a bilingual pair, or carry a parenthetical translation gloss unless the user explicitly asked. Standardized units and user-given proper nouns may remain Latin.\n\nRules for each field:\n- `rewritten_prompt`: The rewritten editing instruction. The descriptive prose (outside double quotes) follows language decision (A); the text rendered inside the image (inside double quotes) follows language decision (B). Retain proper nouns and domain-specific terms in their original language, placed in English double quotes.\n- `wh_ratio`: The target aspect ratio as \"W:H\". Set to \"\" when the output resolution should follow an input image instead.\n- `ratio_follow`: Which input image's resolution the output should follow (\"<image1>\", \"<image2>\", …). Set to \"\" when a specific aspect ratio is provided in `wh_ratio`.\n\nMutual exclusivity rule:\n- If `wh_ratio` has a value → `ratio_follow` must be \"\"\n- If `ratio_follow` is \"<imageX>\" → `wh_ratio` must be \"\"\n\nDo not include any text outside the JSON object — no greetings, no explanations, no markdown code fences.\n\nThe user's edit instruction to rewrite is:",
        "outputMode": "text"
      },
      "hermesProfile": "default",
      "inputs": [
        {
          "label": "prompt",
          "sourceRef": "step.scan.outputs.promptText2",
          "key": "prompt",
          "valueSource": "reference"
        },
        {
          "label": "action",
          "sourceRef": "step.scan.outputs.action2",
          "key": "action",
          "valueSource": "reference"
        },
        {
          "label": "reference1",
          "sourceRef": "step.scan.outputs.reference1",
          "key": "reference1",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "reference2",
          "sourceRef": "step.scan.outputs.reference2",
          "key": "reference2",
          "valueSource": "reference",
          "referenceType": "image_list"
        }
      ],
      "outputs": [
        {
          "label": "最终提示词",
          "description": "",
          "key": "prompt",
          "type": "text"
        }
      ],
      "startCondition": {
        "match": "all",
        "rules": [
          {
            "id": "hasAction2",
            "leftRef": "step.scan.outputs.ready2",
            "operator": "equals",
            "valueSource": "literal",
            "rightValue": "true"
          }
        ]
      }
    },
    {
      "promptTemplate": "",
      "id": "normalize",
      "name": "净化终稿（剥掉 JSON 壳，挡住错误回执）",
      "kind": "capability",
      "capabilityId": "core.code",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "code": "// 终稿净化：core.llm 用 text 模式本应直接给出正文，但模型仍可能自作主张包一层 JSON\n// （实测原 PE 节点就经常这样：rewritten_prompt / answer / prompt / ratio+prompt / error …）。\n// 这里做确定性兜底：剥掉代码块与 JSON 壳，取出真正的提示词正文；取不到就明确失败，\n// 绝不把 JSON 或错误信息当提示词送进采样器。\nconst text = (value) => (value === null || value === undefined ? \"\" : String(value));\nconst KEYS = [\"rewritten_prompt\", \"prompt\", \"rewrite\", \"answer\", \"text\", \"content\", \"value\", \"output\", \"result\", \"description\"];\n\nconst longestString = (value) => {\n  const found = [];\n  const walk = (node) => {\n    if (typeof node === \"string\") { found.push(node); return; }\n    if (Array.isArray(node)) { node.forEach(walk); return; }\n    if (node && typeof node === \"object\") { Object.values(node).forEach(walk); }\n  };\n  walk(value);\n  return found.map((item) => item.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? \"\";\n};\n\nconst pickFromObject = (object) => {\n  if (!object || typeof object !== \"object\") return \"\";\n  for (const key of KEYS) {\n    const value = object[key];\n    if (typeof value === \"string\" && value.trim()) return value.trim();\n    if (value && typeof value === \"object\") {\n      for (const nested of KEYS) {\n        const inner = value[nested];\n        if (typeof inner === \"string\" && inner.trim()) return inner.trim();\n      }\n    }\n  }\n  return longestString(object);\n};\n\nconst clean = (value, label) => {\n  let result = text(value).trim();\n  if (!result) throw new Error(label + \"没有内容，无法生成\");\n\n  // 去掉 ``` 代码块包裹\n  result = result.replace(/^```[A-Za-z0-9_-]*\\s*/, \"\").replace(/\\s*```$/, \"\").trim();\n\n  // 整体是 JSON 对象时，取出里面的正文\n  if (/^\\{[\\s\\S]*\\}$/.test(result)) {\n    let parsed;\n    try { parsed = JSON.parse(result); } catch { parsed = undefined; }\n    if (parsed && typeof parsed === \"object\") {\n      // 明确的错误回执：宁可失败也不要把错误信息当提示词去生成\n      const errorText = text(parsed.error_description ?? parsed.error ?? parsed.message).trim();\n      if (errorText && !parsed.rewritten_prompt && !parsed.prompt && !parsed.rewrite) {\n        throw new Error(label + \"的模型返回了错误，已停止生成：\" + errorText.slice(0, 200));\n      }\n      result = pickFromObject(parsed) || result;\n    }\n  }\n\n  // 去掉首尾包裹的引号（JSON 字符串）\n  if (/^\"[\\s\\S]*\"$/.test(result)) {\n    try { const unquoted = JSON.parse(result); if (typeof unquoted === \"string\") result = unquoted; } catch { /* 保持原样 */ }\n  }\n\n  result = result.trim();\n  if (!result) throw new Error(label + \"净化后没有可用正文，无法生成\");\n  // 净化后仍是 JSON 壳，说明结构超出预期：明确失败而不是把壳送进采样器\n  if (/^\\{[\\s\\S]*\"[A-Za-z_]+\"\\s*:/.test(result)) {\n    throw new Error(label + \"仍是 JSON 结构，无法安全取出提示词正文，已停止生成以免污染采样器\");\n  }\n  return result;\n};\n\nreturn {\n  // 该轮被跳过（动作文件为空）时没有终稿，属正常情况：原样返回空，不报错。\n  prompt1: inputs.ready1 ? clean(inputs.text1, \"第 1 轮终稿\") : \"\",\n  prompt2: inputs.ready2 ? clean(inputs.text2, \"第 2 轮终稿\") : \"\",\n};",
        "timeoutMs": 5000
      },
      "inputs": [
        {
          "label": "text1",
          "sourceRef": "step.enhance1.outputs.prompt",
          "key": "text1",
          "valueSource": "reference"
        },
        {
          "label": "text2",
          "sourceRef": "step.enhance2.outputs.prompt",
          "key": "text2",
          "valueSource": "reference"
        },
        {
          "label": "ready1",
          "sourceRef": "step.scan.outputs.ready1",
          "key": "ready1",
          "valueSource": "reference"
        },
        {
          "label": "ready2",
          "sourceRef": "step.scan.outputs.ready2",
          "key": "ready2",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "第 1 轮终稿",
          "description": "",
          "key": "prompt1",
          "type": "text"
        },
        {
          "label": "第 2 轮终稿",
          "description": "",
          "key": "prompt2",
          "type": "text"
        }
      ]
    },
    {
      "promptTemplate": "",
      "id": "swap_round1",
      "name": "换装 1",
      "kind": "comfyui",
      "capabilityId": "core.comfyui",
      "capabilityVersion": "1",
      "inputs": [
        {
          "label": "character",
          "sourceRef": "step.scan.outputs.characterPath",
          "key": "character",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "reference",
          "sourceRef": "step.scan.outputs.reference1",
          "key": "reference",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "prefix",
          "sourceRef": "step.scan.outputs.prefix1",
          "key": "prefix",
          "valueSource": "reference"
        },
        {
          "label": "prompt",
          "sourceRef": "step.normalize.outputs.prompt1",
          "key": "prompt",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "换装成图",
          "description": "",
          "key": "result",
          "type": "image_list"
        }
      ],
      "comfyui": {
        "workflowFile": "Zane/i2i_二次元抱枕_换装_大模型.json",
        "bindings": [
          {
            "key": "character",
            "direction": "input",
            "nodeId": "537",
            "property": "images",
            "type": "image_list",
            "required": true,
            "sourceRef": "step.scan.outputs.characterPath",
            "valueSource": "reference"
          },
          {
            "key": "reference",
            "direction": "input",
            "nodeId": "497",
            "property": "image",
            "type": "image_list",
            "required": true,
            "sourceRef": "step.scan.outputs.reference1",
            "valueSource": "reference"
          },
          {
            "key": "prefix",
            "direction": "input",
            "nodeId": "461",
            "property": "filename_prefix",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.prefix1",
            "valueSource": "reference"
          },
          {
            "key": "prompt",
            "direction": "input",
            "nodeId": "471",
            "property": "prompt",
            "type": "text",
            "required": true,
            "sourceRef": "step.normalize.outputs.prompt1",
            "valueSource": "reference"
          },
          {
            "key": "result",
            "direction": "output",
            "nodeId": "461",
            "property": "images",
            "type": "image_list"
          }
        ]
      },
      "startCondition": {
        "match": "all",
        "rules": [
          {
            "id": "hasAction1",
            "leftRef": "step.scan.outputs.ready1",
            "operator": "equals",
            "valueSource": "literal",
            "rightValue": "true"
          }
        ]
      }
    },
    {
      "promptTemplate": "",
      "id": "swap_round2",
      "name": "换装 2",
      "kind": "comfyui",
      "capabilityId": "core.comfyui",
      "capabilityVersion": "1",
      "inputs": [
        {
          "label": "character",
          "sourceRef": "step.scan.outputs.characterPath",
          "key": "character",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "reference",
          "sourceRef": "step.scan.outputs.reference2",
          "key": "reference",
          "valueSource": "reference",
          "referenceType": "image_list"
        },
        {
          "label": "prefix",
          "sourceRef": "step.scan.outputs.prefix2",
          "key": "prefix",
          "valueSource": "reference"
        },
        {
          "label": "prompt",
          "sourceRef": "step.normalize.outputs.prompt2",
          "key": "prompt",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "换装成图",
          "description": "",
          "key": "result",
          "type": "image_list"
        }
      ],
      "comfyui": {
        "workflowFile": "Zane/i2i_二次元抱枕_换装_大模型.json",
        "bindings": [
          {
            "key": "character",
            "direction": "input",
            "nodeId": "537",
            "property": "images",
            "type": "image_list",
            "required": true,
            "sourceRef": "step.scan.outputs.characterPath",
            "valueSource": "reference"
          },
          {
            "key": "reference",
            "direction": "input",
            "nodeId": "497",
            "property": "image",
            "type": "image_list",
            "required": true,
            "sourceRef": "step.scan.outputs.reference2",
            "valueSource": "reference"
          },
          {
            "key": "prefix",
            "direction": "input",
            "nodeId": "461",
            "property": "filename_prefix",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.prefix2",
            "valueSource": "reference"
          },
          {
            "key": "prompt",
            "direction": "input",
            "nodeId": "471",
            "property": "prompt",
            "type": "text",
            "required": true,
            "sourceRef": "step.normalize.outputs.prompt2",
            "valueSource": "reference"
          },
          {
            "key": "result",
            "direction": "output",
            "nodeId": "461",
            "property": "images",
            "type": "image_list"
          }
        ]
      },
      "startCondition": {
        "match": "all",
        "rules": [
          {
            "id": "hasAction2",
            "leftRef": "step.scan.outputs.ready2",
            "operator": "equals",
            "valueSource": "literal",
            "rightValue": "true"
          }
        ]
      }
    },
    {
      "promptTemplate": "",
      "id": "export",
      "name": "按角色名导出到固定目录",
      "kind": "capability",
      "capabilityId": "core.code",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "code": "const text = (value) => (value === null || value === undefined ? \"\" : String(value));\nconst list = (value) => (Array.isArray(value) ? value : []);\nconst fileName = (item) => {\n  if (typeof item === \"string\") return item.trim();\n  if (item && typeof item === \"object\" && typeof item.filename === \"string\") return item.filename.trim();\n  return \"\";\n};\nconst safeName = (value, fallback) => {\n  const cleaned = text(value).replace(/[^\\p{L}\\p{N}._()\\- ・]/gu, \"_\").replace(/\\s+/g, \" \").trim().replace(/[.\\s]+$/, \"\");\n  return cleaned ? cleaned.slice(0, 120) : fallback;\n};\nconst batch = text(inputs.batch).trim();\nif (!batch) throw new Error(\"批次不能为空\");\nconst characters = list(inputs.characters).filter((item) => item && typeof item === \"object\");\nif (!characters.length) throw new Error(\"读取步骤没有返回角色列表，无法按角色名命名\");\nconst rounds = [\n  { key: \"round1\", directory: \"结果1\", prefixKey: \"prefix1\", files: list(inputs.round1).map(fileName).filter(Boolean) },\n  { key: \"round2\", directory: \"结果2\", prefixKey: \"prefix2\", files: list(inputs.round2).map(fileName).filter(Boolean) }\n];\nconst total = rounds[0].files.length + rounds[1].files.length;\nif (!total) throw new Error(\"两轮换装都没有产出成图，没有可导出的文件\");\nconst used = Object.create(null);\nconst items = [];\nconst unmatched = [];\nconst missing = [];\nrounds.forEach((round) => {\n  const produced = [];\n  round.files.forEach((source) => {\n    const matched = characters.filter((item) => {\n      const prefix = text(item[round.prefixKey]);\n      if (!/^[A-Za-z0-9_-]+$/.test(prefix) || source.indexOf(prefix + \"_\") !== 0) return false;\n      return /^[0-9]+_?(?:-[0-9a-f]{8})?\\.[A-Za-z0-9]{1,8}$/.test(source.slice(prefix.length + 1));\n    });\n    if (matched.length !== 1) { unmatched.push(source); return; }\n    produced.push(matched[0].name);\n    const directory = batch + \"/\" + round.directory;\n    const base = safeName(matched[0].name, \"角色\");\n    const key = (directory + \"/\" + base).toLowerCase();\n    const seen = used[key] ? used[key] + 1 : 1;\n    used[key] = seen;\n    items.push({ source: source, target: directory + \"/\" + (seen > 1 ? base + \"-\" + seen : base) + \".png\" });\n  });\n  characters.forEach((item) => { if (produced.indexOf(item.name) < 0) missing.push({ round: round.key, character: item.name }); });\n});\nif (unmatched.length) throw new Error(\"有 \" + unmatched.length + \" 张成图的文件名前缀无法唯一对应到角色，导出已中止（不猜名字）：\" + unmatched.join(\"、\") + \"。请确认 ComfyUI 步骤的 SaveImage.filename_prefix 绑定生效，且角色名没有重复。\");\nconst images = items.map((item) => item.source);\nreturn {\n  images: images,\n  count: images.length,\n  plan: {\n    format: \"zane-local-export-plan/v1\",\n    kind: \"pillow-swap\",\n    batch: batch,\n    root: batch,\n    expected: characters.length * rounds.length,\n    characters: characters.map((item) => item.name),\n    rounds: rounds.map((round) => ({ key: round.key, directory: batch + \"/\" + round.directory, count: round.files.length })),\n    missing: missing,\n    items: items\n  }\n};",
        "timeoutMs": 20000,
        "localExport": {
          "enabled": true,
          "planKey": "plan",
          "onConflict": "overwrite"
        }
      },
      "inputs": [
        {
          "label": "batch",
          "sourceRef": "input.batch",
          "key": "batch",
          "valueSource": "reference"
        },
        {
          "label": "characters",
          "sourceRef": "step.scan.outputs.characters",
          "key": "characters",
          "valueSource": "reference"
        },
        {
          "label": "round1",
          "sourceRef": "step.swap_round1.outputs.result",
          "key": "round1",
          "valueSource": "reference"
        },
        {
          "label": "round2",
          "sourceRef": "step.swap_round2.outputs.result",
          "key": "round2",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "全部成图",
          "description": "",
          "key": "images",
          "type": "image_list"
        },
        {
          "label": "导出数量",
          "description": "",
          "key": "count",
          "type": "number"
        },
        {
          "label": "导出计划",
          "description": "",
          "key": "plan",
          "type": "json"
        }
      ]
    }
  ],
  "outputs": [
    {
      "label": "全部成图",
      "key": "result",
      "type": "image_list",
      "sourceRef": "step.export.outputs.images"
    },
    {
      "label": "导出计划",
      "key": "export_plan",
      "type": "json",
      "sourceRef": "step.export.outputs.plan"
    }
  ]
};
