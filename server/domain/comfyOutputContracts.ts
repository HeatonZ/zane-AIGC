import * as z from "zod/v4";
import type { CapabilityValue } from "../capabilities/contracts.js";
/** Optional exact counts for declared media outputs, checked per execution/iteration. */
export const comfyOutputMediaCountsSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.int().min(0).max(144)).refine(counts => Object.keys(counts).length <= 64, "最多64个输出数量约束");
export const comfyOutputMediaCountsValueSchema: Record<string, CapabilityValue> = { ...(z.toJSONSchema(comfyOutputMediaCountsSchema) as unknown as Record<string, CapabilityValue>), maxProperties: 64 };
