/** 「二次元抱枕生图」场景的步骤定义快照，由真实发布草稿导出，仅供回归测试使用。
 *
 *  为什么要固化一份：这个场景的关键行为（参考图N 固定配 提示词N/动作N、动作由场景从
 *  动作N.txt 随机抽一行、动作文件为空则整轮跳过）全在 core.code 代码与 ComfyUI 绑定里，
 *  光看测试断言无法保证它们没被改坏。这里保存真实定义，测试再用假 ComfyUI 运行时执行它，
 *  于是「改坏了流程」会直接让测试失败。
 *
 *  更新方式：改动场景草稿后，用 get_scene_draft 取回草稿并重新导出本文件；
 *  不要手改这里的代码逻辑，否则测试就不再反映真实场景。 */
export const pillowSceneWorkflow = {
  "inputs": [
    {
      "label": "批次",
      "required": true,
      "key": "batch",
      "type": "text",
      "placeholder": "例如 11"
    },
    {
      "label": "排除角色（可选，每行一个；已生成的可填这里跳过）",
      "required": false,
      "key": "exclude",
      "type": "textarea",
      "placeholder": "例如\nAZKi\n雪花ラミィ\n留空表示不排除任何角色"
    }
  ],
  "steps": [
    {
      "id": "scan",
      "name": "读取批次目录（角色图 + 参考图 + 提示词，并为每个角色抽取动作）",
      "kind": "capability",
      "capabilityId": "core.code",
      "capabilityVersion": "1",
      "capabilityConfig": {
        "code": "const text = (value) => (value === null || value === undefined ? \"\" : String(value));\nconst pad = (index) => String(index + 1).padStart(2, \"0\");\nconst IMAGE = /\\.(png|jpe?g|webp|bmp)$/i;\nconst stem = (name) => name.replace(/\\.[^.]+$/, \"\");\nconst batch = text(inputs.batch).trim();\nif (!batch) throw new Error(\"批次不能为空，请填写批次号，例如 11\");\nif (/[\\\\/]/.test(batch) || batch === \".\" || batch === \"..\") throw new Error(\"批次只能是一个目录名，不能包含路径分隔符：\" + batch);\nconst excludeList = [];\ntext(inputs.exclude).split(/[\\n\\r,，;；]+/).forEach((item) => {\n  const name = stem(item.trim());\n  if (name && excludeList.indexOf(name) < 0) excludeList.push(name);\n});\nconst isExcluded = (name) => {\n  const key = name.toLowerCase();\n  return excludeList.some((item) => item.toLowerCase() === key);\n};\nconst characterDirectory = batch + \"/\" + \"角色\";\nconst entries = await zane.fs.list(characterDirectory);\nconst files = entries.filter((entry) => entry.isFile && !entry.isSymbolicLink && IMAGE.test(entry.name));\nif (!files.length) throw new Error(\"角色目录里没有可用的图片文件：\" + characterDirectory);\nconst all = files.map((entry) => ({ name: stem(entry.name), path: entry.path, size: entry.size }));\nconst unmatched = excludeList.filter((item) => !all.some((entry) => entry.name.toLowerCase() === item.toLowerCase()));\nif (unmatched.length) throw new Error(\"排除项里有 \" + unmatched.length + \" 个名字在角色目录里找不到，已中止（不猜、不生成）：\" + unmatched.join(\"、\") + \"。该目录实际有：\" + all.map((entry) => entry.name).join(\"、\"));\nconst excluded = all.filter((entry) => isExcluded(entry.name));\nconst kept = all.filter((entry) => !isExcluded(entry.name));\nif (!kept.length) throw new Error(\"排除后没有剩余角色，无需生成：\" + characterDirectory + \"（共 \" + all.length + \" 个角色都被排除了）\");\n// 交给 ComfyUI 当 input_file_path：它自己拼 file_name + \".\" + 扩展名再读文件。\nconst directory = (await zane.fs.stat(batch)).path + \"\\\\\";\nconst batchEntries = await zane.fs.list(batch);\nconst pickReference = (label) => {\n  const matched = batchEntries.filter((entry) => entry.isFile && !entry.isSymbolicLink && IMAGE.test(entry.name) && stem(entry.name) === label);\n  if (!matched.length) throw new Error(\"批次目录里找不到参考图 \" + label + \"（支持 png/jpg/webp/bmp）：\" + batch);\n  if (matched.length > 1) throw new Error(\"批次目录里有多个名为 \" + label + \" 的参考图：\" + matched.map((entry) => entry.name).join(\"、\"));\n  return matched[0].path;\n};\nconst reference1 = [pickReference(\"1\")];\nconst reference2 = [pickReference(\"2\")];\n// 参考图 N 固定配 提示词N.txt / 动作N.txt，不交叉配对。\nconst rounds = [];\nfor (const label of [\"1\", \"2\"]) {\n  const promptName = \"提示词\" + label;\n  const promptPath = batch + \"/\" + promptName + \".txt\";\n  const promptInfo = await zane.fs.stat(promptPath);\n  if (!promptInfo.exists || !promptInfo.isFile) throw new Error(\"批次目录里找不到提示词文件：\" + promptPath + \"（提示词\" + label + \".txt 必须与参考图 \" + label + \" 配套）\");\n  if (!promptInfo.size) throw new Error(\"提示词文件是空的：\" + promptPath);\n  const actionPath = batch + \"/\" + \"动作\" + label + \".txt\";\n  const actionInfo = await zane.fs.stat(actionPath);\n  let lines = [];\n  if (actionInfo.exists && actionInfo.isFile && actionInfo.size > 0) {\n    const content = await zane.fs.readText(actionPath);\n    lines = content.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);\n  }\n  rounds.push({ label: label, ready: lines.length > 0, promptName: promptName, actionPath: actionPath, lines: lines });\n}\nif (!rounds[0].ready && !rounds[1].ready) throw new Error(\"动作1.txt 与 动作2.txt 都没有可用动作，没有可生成的内容：\" + batch + \"（请先在这两个文件里写入动作，每行一条）\");\n// 每个角色在两轮里各抽 1 行；同一次运行内各角色互不影响，抽到的动作会记进 info 便于回溯。\nconst characters = kept.map((entry, index) => {\n  const character = { index: index, name: entry.name, path: entry.path, size: entry.size };\n  rounds.forEach((round) => {\n    character[\"prefix\" + round.label] = \"pillow_r\" + round.label + \"_c\" + pad(index);\n    character[\"action\" + round.label] = round.ready ? round.lines[Math.floor(Math.random() * round.lines.length)] : \"\";\n  });\n  return character;\n});\nconst brief = (value) => (value.length > 60 ? value.slice(0, 60) + \"…\" : value);\nreturn {\n  characters: characters,\n  reference1: reference1,\n  reference2: reference2,\n  directory: directory,\n  prompt1: rounds[0].promptName,\n  prompt2: rounds[1].promptName,\n  ready1: rounds[0].ready,\n  ready2: rounds[1].ready,\n  info: {\n    batch: batch,\n    characterDirectory: characterDirectory,\n    directory: directory,\n    totalInDirectory: all.length,\n    characterCount: characters.length,\n    names: characters.map((item) => item.name),\n    excluded: excluded.map((item) => item.name),\n    reference1: reference1[0],\n    reference2: reference2[0],\n    rounds: rounds.map((round) => ({ label: round.label, promptFile: round.promptName + \".txt\", actionFile: round.actionPath, actionCount: round.lines.length, ready: round.ready })),\n    picked: characters.map((item) => ({ name: item.name, action1: brief(item.action1), action2: brief(item.action2) }))\n  }\n};",
        "timeoutMs": 10000,
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
          "label": "exclude",
          "sourceRef": "input.exclude",
          "key": "exclude",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "characters",
          "description": "",
          "key": "characters",
          "type": "json"
        },
        {
          "label": "reference1",
          "description": "",
          "key": "reference1",
          "type": "json"
        },
        {
          "label": "reference2",
          "description": "",
          "key": "reference2",
          "type": "json"
        },
        {
          "label": "directory",
          "description": "",
          "key": "directory",
          "type": "text"
        },
        {
          "label": "prompt1",
          "description": "",
          "key": "prompt1",
          "type": "text"
        },
        {
          "label": "prompt2",
          "description": "",
          "key": "prompt2",
          "type": "text"
        },
        {
          "label": "ready1",
          "description": "",
          "key": "ready1",
          "type": "boolean"
        },
        {
          "label": "ready2",
          "description": "",
          "key": "ready2",
          "type": "boolean"
        },
        {
          "label": "info",
          "description": "",
          "key": "info",
          "type": "json"
        }
      ]
    },
    {
      "id": "swap_round1",
      "name": "换装 1（参考图 1 + 提示词1.txt + 随机动作）",
      "kind": "comfyui",
      "capabilityId": "core.comfyui",
      "capabilityVersion": "1",
      "execution": {
        "mode": "for_each",
        "sourceRef": "step.scan.outputs.characters",
        "onError": "continue",
        "maxConcurrency": 1
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
      },
      "comfyui": {
        "workflowFile": "Zane/i2i_二次元抱枕_换装.json",
        "bindings": [
          {
            "key": "character",
            "direction": "input",
            "nodeId": "537",
            "property": "images",
            "type": "image_list",
            "required": true,
            "sourceRef": "iteration.item.path",
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
            "sourceRef": "iteration.item.prefix1",
            "valueSource": "reference"
          },
          {
            "key": "promptDirectory",
            "direction": "input",
            "nodeId": "592",
            "property": "input_file_path",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.directory",
            "valueSource": "reference"
          },
          {
            "key": "promptName",
            "direction": "input",
            "nodeId": "592",
            "property": "file_name",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.prompt1",
            "valueSource": "reference"
          },
          {
            "key": "action",
            "direction": "input",
            "nodeId": "591",
            "property": "prompt",
            "type": "text",
            "required": true,
            "sourceRef": "iteration.item.action1",
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
      "inputs": [
        {
          "label": "character",
          "sourceRef": "iteration.item.path",
          "key": "character",
          "valueSource": "reference"
        },
        {
          "label": "reference",
          "sourceRef": "step.scan.outputs.reference1",
          "key": "reference",
          "valueSource": "reference"
        },
        {
          "label": "prefix",
          "sourceRef": "iteration.item.prefix1",
          "key": "prefix",
          "valueSource": "reference"
        },
        {
          "label": "action",
          "sourceRef": "iteration.item.action1",
          "key": "action",
          "valueSource": "reference"
        },
        {
          "label": "promptDirectory",
          "sourceRef": "step.scan.outputs.directory",
          "key": "promptDirectory",
          "valueSource": "reference"
        },
        {
          "label": "promptName",
          "sourceRef": "step.scan.outputs.prompt1",
          "key": "promptName",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "result",
          "description": "",
          "key": "result",
          "type": "image_list"
        }
      ]
    },
    {
      "id": "swap_round2",
      "name": "换装 2（参考图 2 + 提示词2.txt + 随机动作）",
      "kind": "comfyui",
      "capabilityId": "core.comfyui",
      "capabilityVersion": "1",
      "execution": {
        "mode": "for_each",
        "sourceRef": "step.scan.outputs.characters",
        "onError": "continue",
        "maxConcurrency": 1
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
      },
      "comfyui": {
        "workflowFile": "Zane/i2i_二次元抱枕_换装.json",
        "bindings": [
          {
            "key": "character",
            "direction": "input",
            "nodeId": "537",
            "property": "images",
            "type": "image_list",
            "required": true,
            "sourceRef": "iteration.item.path",
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
            "sourceRef": "iteration.item.prefix2",
            "valueSource": "reference"
          },
          {
            "key": "promptDirectory",
            "direction": "input",
            "nodeId": "592",
            "property": "input_file_path",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.directory",
            "valueSource": "reference"
          },
          {
            "key": "promptName",
            "direction": "input",
            "nodeId": "592",
            "property": "file_name",
            "type": "text",
            "required": true,
            "sourceRef": "step.scan.outputs.prompt2",
            "valueSource": "reference"
          },
          {
            "key": "action",
            "direction": "input",
            "nodeId": "591",
            "property": "prompt",
            "type": "text",
            "required": true,
            "sourceRef": "iteration.item.action2",
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
      "inputs": [
        {
          "label": "character",
          "sourceRef": "iteration.item.path",
          "key": "character",
          "valueSource": "reference"
        },
        {
          "label": "reference",
          "sourceRef": "step.scan.outputs.reference2",
          "key": "reference",
          "valueSource": "reference"
        },
        {
          "label": "prefix",
          "sourceRef": "iteration.item.prefix2",
          "key": "prefix",
          "valueSource": "reference"
        },
        {
          "label": "action",
          "sourceRef": "iteration.item.action2",
          "key": "action",
          "valueSource": "reference"
        },
        {
          "label": "promptDirectory",
          "sourceRef": "step.scan.outputs.directory",
          "key": "promptDirectory",
          "valueSource": "reference"
        },
        {
          "label": "promptName",
          "sourceRef": "step.scan.outputs.prompt2",
          "key": "promptName",
          "valueSource": "reference"
        }
      ],
      "outputs": [
        {
          "label": "result",
          "description": "",
          "key": "result",
          "type": "image_list"
        }
      ]
    },
    {
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
          "label": "批次",
          "sourceRef": "input.batch",
          "key": "batch",
          "valueSource": "reference"
        },
        {
          "label": "角色列表",
          "sourceRef": "step.scan.outputs.characters",
          "key": "characters",
          "valueSource": "reference"
        },
        {
          "label": "换装 1 成图",
          "sourceRef": "step.swap_round1.outputs.result",
          "key": "round1",
          "valueSource": "reference"
        },
        {
          "label": "换装 2 成图",
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
      "sourceRef": "step.export.outputs.images",
      "selection": {
        "mode": "all"
      }
    },
    {
      "label": "导出计划",
      "key": "export_plan",
      "type": "json",
      "sourceRef": "step.export.outputs.plan"
    }
  ]
} as const;
