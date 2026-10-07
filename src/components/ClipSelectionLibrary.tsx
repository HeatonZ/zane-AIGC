import { useEffect, useState } from "react";
import type { ClipSelection } from "../../server/domain/productionContracts";
import { listClipSelections } from "../lib/api";
import ClipSelectionDialog from "./ClipSelectionDialog";
export default function ClipSelectionLibrary({ onOpenRun }: { onOpenRun(runId:string):void }) {
  const [lists,setLists] = useState<ClipSelection[]>([]); const [selected,setSelected] = useState<string|null>(null); const [error,setError] = useState("");
  useEffect(() => { const controller = new AbortController(); listClipSelections(undefined,controller.signal).then(result => setLists(result.selections)).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); return () => controller.abort(); },[selected]);
  return <section><div className="library-section-heading"><div><h2>选片清单</h2><p>固定每镜采用的版本，随时重新合成。</p></div></div>{error && <p className="production-inline-error">{error}</p>}{lists.length ? <div className="library-drafts">{lists.map(list => <button className="library-draft" key={list.id} onClick={() => setSelected(list.id)}><span><strong>{list.name}</strong><small>{list.shots.length} 镜 · 已选 {list.shots.filter(shot=>shot.choice).length} 镜</small></span></button>)}</div> : <p className="studio-field-hint">在逐镜视频运行的结果面板中创建选片清单。</p>}{selected && <ClipSelectionDialog initialSelectionId={selected} onClose={() => setSelected(null)} onComposed={id => { setSelected(null); onOpenRun(id); }} />}</section>;
}
