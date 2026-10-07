import * as z from "zod/v4";
export const runMediaExportQuery = z.object({
  outputKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  stepId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  itemIndex: z.coerce.number().int().nonnegative().optional(),
}).strict();
export const runMediaArchiveQuery = runMediaExportQuery.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const runMediaExportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), outputKey: z.string(), stepId: z.string().optional(), itemIndex: z.int().nonnegative().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/), incomplete: z.boolean(), fileCount: z.int().min(1).max(144), totalBytes: z.int().nonnegative(),
  downloadUrl: z.string(), nextAction: z.literal("download_archive"),
}).strict();
export type RunMediaExportQuery = z.infer<typeof runMediaExportQuery>;
export type RunMediaExport = z.infer<typeof runMediaExportSchema>;
