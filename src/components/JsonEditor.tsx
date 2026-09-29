import { AlignLeft, Braces, Check, TriangleAlert } from "lucide-react";
import { useMemo, type KeyboardEvent } from "react";

function syntaxErrorLocation(value: string, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumn) return `第 ${lineColumn[1]} 行，第 ${lineColumn[2]} 列`;

  const position = message.match(/position\s+(\d+)/i);
  if (position) {
    const beforeError = value.slice(0, Number(position[1]));
    const lines = beforeError.split("\n");
    return `第 ${lines.length} 行，第 ${lines[lines.length - 1].length + 1} 列`;
  }

  return "JSON 格式无效";
}

export default function JsonEditor({
  id,
  value,
  onChange,
  required = false,
  placeholder = '{\n  "key": "value"\n}',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const validation = useMemo(() => {
    if (!value.trim()) return { state: "empty" as const };
    try {
      return { state: "valid" as const, parsed: JSON.parse(value) as unknown };
    } catch (error) {
      return { state: "invalid" as const, location: syntaxErrorLocation(value, error) };
    }
  }, [value]);

  function formatJson() {
    if (validation.state !== "valid") return;
    onChange(JSON.stringify(validation.parsed, null, 2));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${value.slice(0, start)}  ${value.slice(end)}`;
    onChange(nextValue);
    requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2));
  }

  const statusId = `${id}-status`;
  return (
    <div className={`json-editor${validation.state === "invalid" ? " invalid" : ""}`}>
      <div className="json-editor-toolbar">
        <span className="json-editor-language"><Braces size={13} />JSON</span>
        <button className="json-editor-format" type="button" onClick={formatJson} disabled={validation.state !== "valid"} title="格式化 JSON">
          <AlignLeft size={13} />格式化
        </button>
      </div>
      <textarea
        id={id}
        className="json-editor-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        required={required}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        aria-invalid={validation.state === "invalid"}
        aria-describedby={statusId}
      />
      <div id={statusId} className={`json-editor-status ${validation.state}`} role="status" aria-live="polite">
        {validation.state === "valid" ? <><Check size={13} /><span>JSON 语法正确</span></>
          : validation.state === "invalid" ? <><TriangleAlert size={13} /><span>{validation.location} · JSON 语法错误</span></>
            : <><Braces size={13} /><span>{required ? "待输入" : "未填写"}</span></>}
      </div>
    </div>
  );
}
