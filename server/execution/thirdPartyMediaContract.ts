import { z } from "zod";
import type { CapabilityValue } from "../capabilities/contracts.js";

/** Shared limits and serializable editor schemas for the third-party media contract.
 * Keep this module free of Node-only media processing so the browser capability catalog
 * can import the schemas without bundling sharp or other server dependencies.
 */
export const THIRD_PARTY_MEDIA_LIMITS = { imageBytes: 20 * 1024 * 1024, images: 16, requestBytes: 64 * 1024 * 1024, responseBytes: 64 * 1024 * 1024 } as const;
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/);
const uploadSchema = z.array(z.object({ inputKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), fieldName }).strict()).max(16);
const responseSchema = z.object({ path: z.string().min(1).max(512).default("data"), base64Field: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).default("b64_json"), expectedCount: z.int().min(1).max(16).optional() }).strict();

export const multipartImagesValueSchema = z.toJSONSchema(uploadSchema) as unknown as Record<string, CapabilityValue>;
export const responseImagesValueSchema = z.toJSONSchema(responseSchema) as unknown as Record<string, CapabilityValue>;

