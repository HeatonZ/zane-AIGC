/** Direct-LLM protocol constants, kept in a module of their own on purpose.
 *
 *  They must be interpolated into prose (operation descriptions, schema `.describe()`, the guide)
 *  rather than hardcoded, because a second literal silently falsifies the documentation when the
 *  constant changes. But the prose module `server/ai/schemas.ts` is reachable from the browser
 *  bundle (src → server/ai/taskDraftSchemas → ./schemas), and importing the provider registry
 *  (`./directLlm.js`) from there would drag the whole registry and its x-direct-llm contract into
 *  the client bundle. This module has no imports, so both sides can share one definition. */
export const directLlmAnthropicVersion = "2023-06-01";
export const directLlmAnthropicMaxTokens = 4096;
