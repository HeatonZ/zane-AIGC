export default function RunWarnings({ warnings }: { warnings?: readonly string[] }) {
  if (!warnings?.length) return null;
  return <ul className="run-advisory-warnings" role="note" aria-label="非阻断提示">
    {warnings.map((message, index) => <li key={index}><span aria-hidden="true">⚠</span><span>{message}</span></li>)}
  </ul>;
}
