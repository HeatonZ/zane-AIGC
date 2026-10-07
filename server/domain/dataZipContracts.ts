import * as z from "zod/v4";

// A bounded, local JSON Schema subset: no refs, patterns, formats, code or remote resolution.
export interface RecordShape {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, RecordShape>; required?: string[]; additionalProperties?: boolean;
  items?: RecordShape; enum?: Array<string | number | boolean | null>;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number;
}
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(value => !["constructor", "prototype", "__proto__", "expected_count"].includes(value));
export const recordShapeSchema: z.ZodType<RecordShape> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
  properties: z.record(key, recordShapeSchema).optional(), required: z.array(key).max(64).optional(),
  additionalProperties: z.boolean().optional(), items: recordShapeSchema.optional(),
  enum: z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).min(1).max(64).optional(),
  minLength: z.int().min(0).max(32000).optional(), maxLength: z.int().min(0).max(32000).optional(),
  minItems: z.int().min(0).max(1000).optional(), maxItems: z.int().min(0).max(1000).optional(),
  minimum: z.number().optional(), maximum: z.number().optional(),
}).strict().superRefine((shape, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const keywords: Array<[string[], string[]]> = [
    [["properties", "required", "additionalProperties"], ["object"]],
    [["items", "minItems", "maxItems"], ["array"]],
    [["minLength", "maxLength"], ["string"]],
    [["minimum", "maximum"], ["number", "integer"]],
  ];
  for (const [keys, types] of keywords) if (!types.includes(shape.type) && keys.some(key => key in shape)) fail("Schema关键字与type不一致");
  if ((shape.minLength ?? 0) > (shape.maxLength ?? Infinity) || (shape.minItems ?? 0) > (shape.maxItems ?? Infinity) || (shape.minimum ?? -Infinity) > (shape.maximum ?? Infinity)) fail("Schema最小值不能超过最大值");
  if (shape.required && new Set(shape.required).size !== shape.required.length) fail("required不能重复");
  if (shape.additionalProperties === false && shape.required?.some(key => !Object.hasOwn(shape.properties ?? {}, key))) fail("required字段未声明且禁止额外字段");
  if (shape.enum?.some(value => shape.type === "null" ? value !== null : shape.type === "integer" ? !Number.isInteger(value) : shape.type === "object" || shape.type === "array" || typeof value !== shape.type)) fail("enum与type不一致");
}));
export const dataZipConfigSchema = z.object({
  itemKey: key.default("item"), identityField: key.optional(), itemSchema: recordShapeSchema.optional(),
  minItems: z.int().min(1).max(1000).default(1), maxItems: z.int().min(1).max(1000).default(200),
}).strict();
export const expectedCountSchema = z.union([z.int().min(1).max(1000), z.string().regex(/^[1-9][0-9]{0,2}$|^1000$/)]);
