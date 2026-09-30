type RecordValue = Record<string, unknown>;
type Graph = Record<string, RecordValue>;

interface H3Services {
  request: (route: string, init?: RequestInit, signal?: AbortSignal) => Promise<unknown>;
  readImage: (value: unknown) => Promise<{ bytes: Buffer; filename: string; contentType: string }>;
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  progress?: (message: string) => Promise<void>;
}

export interface H3Media {
  filename: string;
  subfolder: string;
  type: 'output';
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function jsonPost(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

function checkedPlan(value: unknown, id: string): RecordValue {
  const plan = record(value);
  if (!plan || plan.id !== id || !Array.isArray(plan.segments) || !plan.segments.length || !Number.isInteger(plan.revision)) {
    throw new Error('H3 项目返回了无效的分段方案');
  }
  return plan;
}

function media(value: unknown): H3Media | undefined {
  const item = record(value);
  if (typeof item?.filename !== 'string' || !item.filename || /[\\/]/.test(item.filename) || !/\.mp4$/i.test(item.filename)) return undefined;
  const subfolder = typeof item.subfolder === 'string' ? item.subfolder.replace(/\\/g, '/') : '';
  if (subfolder.startsWith('/') || subfolder.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return { filename: item.filename, subfolder, type: 'output' };
}

const H3_HEADINGS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const;

type H3Heading = typeof H3_HEADINGS[number];

const H3_HEADING_ALIASES: Record<H3Heading, string[]> = {
  subject_definitions: ['subject_definitions', '主体定义', '主体描述'],
  summary: ['summary', '摘要', '概要', '概述'],
  retention_analysis: ['retention_analysis', '保留分析', '参考保留分析', '细节保留分析'],
  detailed_description: ['detailed_description', '详细描述', '详细说明', '详细描写'],
  overall_soundscape: ['overall_soundscape', '整体音景', '整体声景', '整体声音景观'],
  non_diegetic_music: ['non_diegetic_music', '非叙事音乐', '非画内音乐', '非叙事配乐'],
};


function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMarkdownFence(value: string): string {
  let text = value.replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text.slice(text.indexOf('\n') + 1, -3).trim();
  }
  return text;
}

function normalizeH3Headings(value: string): string {
  let text = value;
  for (const heading of H3_HEADINGS) {
    const aliases = H3_HEADING_ALIASES[heading].map(escapeRegex).join('|');
    const pattern = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?(?:' + aliases + ')(?:\\*\\*|__)?[ \\t]*[:：](?:\\*\\*|__)?[ \\t]*\\n?', 'gmi');
    text = text.replace(pattern, heading + ':\n');
  }
  return text;
}

function orderedH3Fields(value: string): RegExpMatchArray[] {
  return [...value.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):[ \t]*$/gm)];
}

function hasOrderedH3Fields(value: string): boolean {
  const fields = orderedH3Fields(value);
  return fields.length === H3_HEADINGS.length && fields.every((field, index) => field[1] === H3_HEADINGS[index]);
}

function pictureList(imageCount: number): string {
  return Array.from({ length: imageCount }, (_, index) => `<Picture ${index + 1}>`).join(', ');
}

function sanitizeFreeformBody(value: string): string {
  const aliases = Object.values(H3_HEADING_ALIASES).flat().map(escapeRegex).join('|');
  const headingLine = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*|__)?(?:' + aliases + ')(?:\\*\\*|__)?[ \\t]*[:：].*$', 'gmi');
  const shotToken = /\[\s*shot[^\]\r\n]*\]/gi;
  const body = value
    .replace(headingLine, (line) => '- ' + line.trim())
    .replace(shotToken, '')
    .trim();
  return body || 'Follow the supplied segment brief and preserve its intended action, composition, continuity, and timing.';
}

function wrapFreeformH3Prompt(value: string, index: number, imageCount: number, visualType: string, segment?: RecordValue): string {
  const references = pictureList(imageCount);
  const audioDefinition = visualType === 'performance'
    ? ' <Audio 1> is the current vocal-performance reference for <Subject 1>; use it only to guide visible mouth articulation, pauses, breathing, and delivery timing.'
    : '';
  const frameCount = typeof segment?.generation_frames === 'number' ? segment.generation_frames : undefined;
  const duration = frameCount === undefined ? '' : ` The generated duration is ${frameCount} frames at 24 fps (${(frameCount / 24).toFixed(3)} seconds).`;
  return [
    'subject_definitions:',
    `${references} are the ordered visual references available to this segment. <Subject 1> is the primary visible subject and setting described by those references; preserve the relevant identity, appearance, environment, and visible objects.${audioDefinition}`,
    '',
    'summary:',
    `Segment ${index + 1}: one continuous H3 shot following the creative direction below.${duration}`,
    '',
    'retention_analysis:',
    `Preserve the visible identity, composition, environment, lighting, colors, clothing, and props from ${references}; apply the creative direction without adding an unrelated subject or cut.`,
    '',
    'detailed_description:',
    '[Shot 1]',
    sanitizeFreeformBody(value),
    '',
    'overall_soundscape:',
    'N/A',
    '',
    'non_diegetic_music:',
    'N/A',
  ].join('\n');
}

function ensurePictureReferences(value: string, imageCount: number): string {
  if (/<Picture\s+\d+\s*>/i.test(value)) return value;
  const fields = orderedH3Fields(value);
  const start = fields[0]?.index;
  const end = fields[1]?.index ?? value.length;
  if (start === undefined) return value;
  const references = pictureList(imageCount);
  return value.slice(0, end) + `${references} are the available ordered visual references; preserve their relevant visible details.\n` + value.slice(end);
}

function canonicalizeH3Sections(text: string, fields: RegExpMatchArray[]): string {
  const detailStart = fields[3].index!;
  const detailEnd = fields[4].index!;
  const shotToken = /\[\s*shot[^\]\r\n]*\]/gi;
  const marker = 'detailed_description:\n';
  const detail = text.slice(detailStart, detailEnd);
  const prefix = text.slice(0, detailStart).replace(shotToken, '');
  const suffix = text.slice(detailEnd).replace(shotToken, '');
  const detailBody = detail.slice(marker.length).replace(shotToken, '').trimStart();
  let result = prefix + marker + '[Shot 1]\n' + detailBody + suffix;
  const resultFields = orderedH3Fields(result);
  const soundStart = resultFields[4].index!;
  const beforeSound = result.slice(0, soundStart);
  result = beforeSound + 'overall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A';
  return result.trim();
}

/** Accept free-form AIXG prose and adapt it to the six fields required by the H3 node. */
export function normalizeH3Prompt(value: string, index: number, imageCount = 1, visualType = 'performance', segment?: RecordValue): string {
  let text = normalizeH3Headings(stripMarkdownFence(value));
  if (!hasOrderedH3Fields(text)) text = wrapFreeformH3Prompt(text, index, imageCount, visualType, segment);
  text = normalizeH3Headings(text);
  text = ensurePictureReferences(text, imageCount);
  if (visualType !== 'performance') text = text.replace(/<Audio\s+1>/gi, 'the current segment audio reference');

  const fields = orderedH3Fields(text);
  if (!hasOrderedH3Fields(text)) {
    throw new Error('第 ' + (index + 1) + ' 段提示词无法适配为 H3 结构');
  }
  const result = canonicalizeH3Sections(text, fields);
  if (result.length > 20_000) throw new Error('第 ' + (index + 1) + ' 段提示词过长');
  return result;
}

function promptMap(value: unknown, segments: unknown[], imageCount: number): Map<number, string> {
  const count = segments.length;
  if (!Array.isArray(value) || value.length !== count) throw new Error('Hermes 提示词数量必须与音频分段数量一致');
  const result = new Map<number, string>();
  for (const entry of value) {
    const row = record(entry);
    const index = row?.index;
    const rawPrompt = row?.prompt;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || result.has(index)) {
      throw new Error('Hermes 提示词段号缺失、重复或越界');
    }
    if (typeof rawPrompt !== 'string' || !rawPrompt.trim() || rawPrompt.length > 20_000) {
      throw new Error('第 ' + (index + 1) + ' 段提示词为空或过长');
    }
    const segment = record(segments[index]);
    const prompt = normalizeH3Prompt(rawPrompt, index, imageCount, typeof segment?.visual_type === 'string' ? segment.visual_type : 'performance');
    if (Object.keys(row!).some((key) => key !== 'index' && key !== 'prompt')) {
      throw new Error('Hermes 每段只能返回 index 和 prompt，音频时间与帧数由系统保留');
    }
    const headings = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
    const matches = [...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):[ \t]*$/gm)];
    if (matches.length !== headings.length || matches.some((match, position) => match[1] !== headings[position])) {
      throw new Error('第 ' + (index + 1) + ' 段提示词经系统适配后仍缺少 H3 结构');
    }
    if (!/^overall_soundscape:\s*N\/A\s*non_diegetic_music:\s*N\/A\s*$/m.test(prompt)) {
      throw new Error('第 ' + (index + 1) + ' 段 H3 声音字段适配失败');
    }
    if (!/^detailed_description:\s*\[Shot 1\]/m.test(prompt)) {
      throw new Error('第 ' + (index + 1) + ' 段单镜头字段适配失败');
    }
    const pictures = [...prompt.matchAll(/<Picture\s+(\d+)>/gi)];
    if (!pictures.length) throw new Error('第 ' + (index + 1) + ' 段提示词必须使用已上传的参考图');
    if (pictures.some((match) => Number(match[1]) < 1 || Number(match[1]) > imageCount)) {
      throw new Error('第 ' + (index + 1) + ' 段提示词引用了不存在的参考图');
    }
    if ((prompt.match(/\[Shot\s+\d+\]/gi) ?? []).length !== 1 || !/\[Shot 1\]/i.test(prompt)) {
      throw new Error('第 ' + (index + 1) + ' 段提示词必须只包含一个 [Shot 1]');
    }
    result.set(index, prompt);
  }
  return result;
}

function active(plan: RecordValue): boolean {
  return Boolean(plan.controller_active) || ['running', 'pausing', 'stopping', 'merging'].includes(String(plan.run_status));
}

/** Uses the plugin's project API so native segment loading, trimming and assembly stay authoritative. */
export async function runH3LongVideo(
  graph: Graph,
  workflow: unknown,
  input: { plan: unknown; promptRows: unknown; images: unknown[]; materialNote: string },
  services: H3Services,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ videoId: string; video: H3Media; segmentVideos: H3Media[]; prompts: { index: number; prompt: string }[]; plan: RecordValue }> {
  const exported = record(input.plan);
  const projectId = exported?.project_id;
  if (exported?.schema !== 'h3lv.segment-plan/v1' || typeof projectId !== 'string' || !/^[a-f0-9]{32}$/i.test(projectId)) {
    throw new Error('H3 长视频需要音频分析步骤输出的 h3lv.segment-plan/v1 数据');
  }
  if (!Array.isArray(exported.segments) || !exported.segments.length) throw new Error('H3 分段方案为空');
  if (!input.images.length || input.images.length > 6) throw new Error('H3 长视频需要按顺序提供 1 至 6 张参考图');
  const prompts = promptMap(input.promptRows, exported.segments as unknown[], input.images.length);
  const loaders = Object.entries(graph).filter(([, node]) => node.class_type === 'H3LVUnified');
  const videos = Object.entries(graph).filter(([, node]) => node.class_type === 'VHS_VideoCombine');
  const references = Object.entries(graph).filter(([, node]) => node.class_type === 'MiniMaxH3ReferenceToVideo');
  if (loaders.length !== 1 || videos.length !== 1 || references.length !== 1) {
    throw new Error('H3 长视频工作流必须包含一个 H3LVUnified、一个 MiniMaxH3ReferenceToVideo 和一个 VHS_VideoCombine');
  }
  const [loaderId, loader] = loaders[0];
  const [videoId, videoNode] = videos[0];
  const [, reference] = references[0];
  const loaderInputs = record(loader.inputs);
  const referenceInputs = record(reference.inputs);
  const videoInputs = record(videoNode.inputs);
  if (!loaderInputs || !referenceInputs || !videoInputs) throw new Error('H3 工作流节点输入格式无效');
  const linked = (value: unknown, outputIndex: number) => Array.isArray(value) && value.length === 2 && String(value[0]) === loaderId && value[1] === outputIndex;
  if (!linked(referenceInputs.length, 2) || !linked(videoInputs.audio, 0) || !linked(videoInputs.filename_prefix, 3) || !linked(videoInputs.frame_rate, 12) || videoInputs.save_output !== true) {
    throw new Error('H3 工作流需要保持原有帧数、音频、文件名和帧率连接，并开启 VHS save_output');
  }
  for (const node of Object.values(graph)) {
    if (node.class_type !== 'SelfLiftAvatarH3Sampler') continue;
    const samplerLink = record(node.inputs)?.sampler;
    const sampler = Array.isArray(samplerLink) ? graph[String(samplerLink[0])] : undefined;
    if (sampler?.class_type !== 'KSamplerSelect' || record(sampler.inputs)?.sampler_name !== 'euler') {
      throw new Error('本机 SelfLift 采样器要求标准 Euler，请将 KSamplerSelect.sampler_name 绑定为 euler');
    }
  }
  // Every segment gets the exact Hermes text from its stored final_prompt.
  referenceInputs.prompt = [loaderId, 11];
  loaderInputs.mode = exported.mode;
  loaderInputs.project_id = projectId;
  loaderInputs.segment_index = 0;

  const route = '/h3lv/project/' + encodeURIComponent(projectId);
  let plan = checkedPlan(await services.request(route, undefined, signal), projectId);
  if (active(plan)) throw new Error('此 H3 项目仍在生成，请等待它结束');
  if (plan.revision !== exported.revision || plan.mode !== exported.mode || (plan.segments as unknown[]).length !== exported.segments.length) {
    throw new Error('H3 分段方案在音频分析之后已变化，请重新分析后运行');
  }
  const rows = (plan.segments as unknown[]).map((value, index) => {
    const row = record(value);
    const original = record((exported.segments as unknown[])[index]);
    if (!row || !original || row.start_sample !== original.start_sample || row.end_sample !== original.end_sample || row.generation_frames !== original.generation_frames) {
      throw new Error('H3 第 ' + (index + 1) + ' 段音频边界或帧数已变化');
    }
    if (row.job) throw new Error('此 H3 项目已经有生成记录，请使用新的音频分析项目');
    const prompt = prompts.get(index)!;
    if ((row.visual_type ?? 'performance') !== 'performance' && /<Audio\s+1>/i.test(prompt)) {
      throw new Error('第 ' + (index + 1) + ' 段为氛围表演或空镜，提示词不能引用 <Audio 1>');
    }
    return row;
  });
  const images = await Promise.all(input.images.map((value) => services.readImage(value)));
  const uploadedNames: string[] = [];
  await services.progress?.('正在导入 ' + input.images.length + ' 张有序参考图');
  for (let index = 0; index < input.images.length; index += 1) {
    const image = images[index];
    const form = new FormData();
    form.set('index', '0');
    form.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), image.filename);
    const uploaded = record(await services.request(route + '/refs', { method: 'POST', body: form }, signal));
    if (typeof uploaded?.name !== 'string' || !uploaded.name) throw new Error('H3 第 ' + (index + 1) + ' 张参考图导入失败');
    uploadedNames.push(uploaded.name);
  }
  // Preserve brief, boundaries, frame counts and visual type; only fill final_prompt and material references.
  plan = checkedPlan(await services.request(route + '/edit', jsonPost({
    revision: plan.revision,
    materials: { refs: uploadedNames, note: input.materialNote },
    segments: rows.map((row, index) => ({
      end: row.end,
      prompt: row.prompt,
      final_prompt: prompts.get(index),
      reference_source: 'default',
      visual_type: row.visual_type ?? 'performance',
    })),
  }), signal), projectId);
  const committed = plan.segments as unknown[];
  for (let index = 0; index < rows.length; index += 1) {
    const saved = record(committed[index]);
    if (!saved || saved.final_prompt !== prompts.get(index) || saved.start_sample !== rows[index].start_sample || saved.end_sample !== rows[index].end_sample || saved.generation_frames !== rows[index].generation_frames) {
      throw new Error('H3 写回后的提示词或音频时序与分析方案不一致');
    }
  }
  plan = checkedPlan(await services.request(route + '/approve', jsonPost({ revision: plan.revision }), signal), projectId);
  if (!plan.approved) throw new Error('H3 分段方案确认失败');

  const stop = async () => {
    try { await services.request(route + '/stop', jsonPost({})); } catch { /* Preserve the original error. */ }
  };
  let started = false;
  const onAbort = () => { if (started) void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = Date.now() + timeoutMs;
  let previousProgress = '';
  try {
    // This request starts the plugin's controller; it queues, records and assembles every segment.
    started = true;
    const queued = record(await services.request(route + '/run', jsonPost({
      prompt: graph, workflow, loader_id: loaderId, video_id: videoId, client_id: 'zane-aigc-studio',
    }), signal));
    if (queued?.started !== true) throw new Error('H3 顺序生成没有成功启动');
    await services.progress?.('H3 项目 ' + projectId + ' 已启动顺序生成');
    while (Date.now() < deadline) {
      plan = checkedPlan(await services.request(route, undefined, signal), projectId);
      const segments = plan.segments as unknown[];
      const completed = segments.filter((value) => record(record(value)?.job)?.status === 'completed').length;
      const message = plan.run_status === 'merging' ? '全部片段已生成，正在合成长视频'
        : 'H3 已生成 ' + completed + '/' + segments.length + ' 段';
      if (message !== previousProgress) {
        await services.progress?.(message);
        previousProgress = message;
      }
      if (plan.run_status === 'failed') {
        let detail = String(plan.error || '请查看 H3 项目记录');
        const failedJob = segments.map((value) => record(record(value)?.job)).find((job) => job?.status === 'failed');
        if (typeof failedJob?.prompt_id === 'string') {
          try {
            const history = record(await services.request('/history/' + encodeURIComponent(failedJob.prompt_id), undefined, signal));
            const messages = record(record(history?.[failedJob.prompt_id])?.status)?.messages;
            if (Array.isArray(messages)) {
              const error = messages.find((entry) => Array.isArray(entry) && entry[0] === 'execution_error');
              const nodeError = Array.isArray(error) ? record(error[1]) : undefined;
              if (typeof nodeError?.exception_message === 'string') detail += ' (' + String(nodeError.node_type || nodeError.node_id || '') + ': ' + nodeError.exception_message.trim().slice(0, 1200) + ')';
            }
          } catch { /* Keep the H3 controller error if history is unavailable. */ }
        }
        throw new Error('H3 长视频生成失败：' + detail);
      }
      if (plan.run_status === 'paused' || plan.run_status === 'stopped') throw new Error('H3 长视频已暂停或停止，项目 ID：' + projectId);
      if (plan.run_status === 'completed' && !plan.final_stale) {
        const video = media(plan.final_preview);
        if (!video || completed !== segments.length) throw new Error('H3 生成已结束，但最终视频或分段记录不完整');
        const segmentVideos = segments.flatMap((value) => { const preview = media(record(value)?.video_preview); return preview ? [preview] : []; });
        return { videoId, video, segmentVideos, prompts: [...prompts].map(([index, prompt]) => ({ index, prompt })), plan };
      }
      await services.delay(2000, signal);
    }
    throw new Error('H3 长视频生成超时，请在 H3 项目中查看已有片段：' + projectId);
  } catch (error) {
    if (started) await stop();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
