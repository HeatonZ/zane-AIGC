import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, LoaderCircle, RotateCcw } from "lucide-react";
import { accessApi } from "../lib/accessApi";
import RunInputSnapshot, { type RunInputFieldShape, type RunInputPageShape } from "./RunInputSnapshot";
import { reusableInputs, type ReusableInputs } from "../lib/packageRunInputs";

type Page = RunInputPageShape & { packageRunId: string; packageId: string; versionId: string; runId: string; revision: string; total: number; hasMore: boolean; nextAction?: string };
type PackageField = { key: string; label: string; type: string; required: boolean; hidden: boolean; options?: string[]; minimum?: number; maximum?: number };

/**
 * 服务运行的原始输入：字段来自该次运行固化的发布快照，值来自提交时快照。
 * 「再做一次」只带当前发布版仍然声明且合法的字段；不能复用的一律丢弃并说明原因，
 * 不静默改写成别的值，也不替用户跳过预检与计费。
 */
export default function PackageRunInputs({ packageRunId, userId, busy, onReuse }: {
  packageRunId: string;
  userId: string;
  busy: boolean;
  onReuse: (values: Record<string, unknown>, notice: ReusableInputs) => void;
}) {
  const api = <T,>(path: string) => accessApi<T>(path, {}, userId);
  const [page, setPage] = useState<Page>();
  const [fields, setFields] = useState<PackageField[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const base = "/api/v1/self/package-runs/" + encodeURIComponent(packageRunId) + "/inputs";

  async function read(options: { cursor?: string; inputKey?: string; offset?: number; narrow?: boolean; chunk?: number } = {}) {
    const ticket = ++sequence.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "20", valueLimit: String(options.narrow ? 1 : options.chunk ?? 2000), valueOffset: String(options.offset ?? 0) });
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.inputKey) query.set("inputKey", options.inputKey);
      if (options.narrow) query.set("maxValueBytes", "262144");
      const next = await api<Page>(base + "?" + query);
      if (!alive.current || ticket !== sequence.current) return;
      if (options.inputKey && page) {
        if (page.revision !== next.revision) throw new Error("输入快照已变化，请重新读取第一页。");
        setPage({ ...page, inputs: page.inputs.map(field => next.inputs.find(value => value.key === field.key) ?? field) });
        return;
      }
      if (options.cursor && page) {
        if (page.revision !== next.revision) throw new Error("输入快照已变化，请重新读取第一页。");
        setPage({ ...next, inputs: [...page.inputs, ...next.inputs] });
        return;
      }
      setPage(next);
      // 当前发布版字段决定「哪些还能复用」；读不到就只展示，不预填。
      const detail = await api<{ fields?: PackageField[] }>("/api/v1/self/packages/" + encodeURIComponent(next.packageId)).catch(() => undefined);
      if (alive.current && ticket === sequence.current) setFields(detail?.fields ?? []);
    } catch (e) { if (alive.current && ticket === sequence.current) setError((e as Error).message); }
    finally { if (alive.current && ticket === sequence.current) setLoading(false); }
  }
  // 换一次运行必须丢掉上一份快照，否则会拿旧字段去预填新服务。
  useEffect(() => { setPage(undefined); setFields(undefined); setError(""); void read(); }, [packageRunId]);

  const reusable = page && fields ? reusableInputs(page.inputs, fields) : undefined;

  return <section className="business-inputs" aria-label="本次运行的原始输入">
    <div className="run-section-intro">
      <h3>本次提交的原始输入</h3>
      <p>固定在这次运行提交时的快照：字段与范围取当时的发布版，值取当时的填写内容，之后改版不影响这里。媒体显示固定素材引用，不展示服务器路径。</p>
    </div>
    {error && <div className="access-error" role="alert">{error}<button className="run-icon-button" onClick={() => void read()}>重新读取</button></div>}
    {!page && loading && <div className="run-read-indicator" role="status"><LoaderCircle size={14} className="spin" />读取服务端快照…</div>}
    {page && <>
      <div className="run-detail-actions">
        <button className="button button-dark" disabled={busy || loading || !reusable} onClick={() => reusable && onReuse(reusable.values, reusable)}>
          <RotateCcw size={14} />用这些参数再做一次
        </button>
        <small>{reusable?.notice ?? (fields ? "" : "读取当前版本字段后可复用参数。")}</small>
      </div>
      {!page.inputs.length && <div className="run-empty-state"><FileText size={26} /><strong>这个服务没有输入字段</strong><p>直接用同样的设置重跑即可。</p></div>}
      <RunInputSnapshot inputs={page.inputs as RunInputFieldShape[]} userId={userId} loading={loading}
        onSlice={(input, offset, narrow) => void read({ inputKey: input.key, offset, chunk: input.valuePage.pageSize, ...(narrow ? { narrow: true } : {}) })}
        onMore={page.nextCursor ? () => void read({ cursor: page.nextCursor }) : undefined} />
      <details className="business-snapshot-meta"><summary>快照标识</summary><dl>
        <div><dt>服务 ID</dt><dd>{page.packageId}</dd></div>
        <div><dt>发布版本 ID</dt><dd>{page.versionId}</dd></div>
        <div><dt>输入 revision</dt><dd>{page.revision}</dd></div>
      </dl></details>
    </>}
    {page && !page.inputs.length && !loading && !error && <p className="access-muted"><AlertCircle size={13} /> 没有可复用的字段，重跑会用当前发布版的默认值。</p>}
  </section>;
}
