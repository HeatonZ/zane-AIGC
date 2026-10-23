import ObjectArrayInput from "./ObjectArrayInput";

/**
 * 服务页里 `json` 类型字段的控件选择：声明了行表单契约（`inputMode=object_array` + 非空
 * `itemFields`）就渲染可增删行的表格，否则保持原来的 JSON 文本域。
 *
 * 为什么单独抽出来：这个判断决定「用户能不能用表单填分镜稿」，而它被埋在 serviceFields 的
 * 三元分支里时只能靠读源码断言。抽成组件后测试可以真的渲染一遍，验证结构而不是猜。
 */
export type ServiceJsonFieldShape = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  hidden: boolean;
  placeholder?: string;
  inputMode?: "object_array";
  itemFields?: Array<{
    key: string;
    label: string;
    type: "text" | "number" | "boolean" | "select";
    required: boolean;
    minimum?: number;
    maximum?: number;
    placeholder?: string;
    options?: string[];
  }>;
};

/** 只有「声明了行表单且行字段非空」才算行表单；只写 inputMode 不写 itemFields 仍是文本域。 */
export function isObjectArrayField(field: Pick<ServiceJsonFieldShape, "type" | "inputMode" | "itemFields">): boolean {
  return field.type === "json" && field.inputMode === "object_array" && (field.itemFields?.length ?? 0) > 0;
}

export function ServiceJsonField({ field, value, disabled = false, onChange }: {
  field: ServiceJsonFieldShape;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  if (isObjectArrayField(field)) {
    return <ObjectArrayInput
      field={field as unknown as Parameters<typeof ObjectArrayInput>[0]["field"]}
      value={value}
      disabled={disabled}
      onChange={rows => onChange(rows)}
    />;
  }
  return <textarea
    className="zclient-input zclient-textarea"
    rows={5}
    placeholder={field.placeholder ?? ""}
    value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2)}
    onChange={event => onChange(event.target.value)}
  />;
}
