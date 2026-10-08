export function visibleInputFields<T extends { hidden?: boolean }>(fields: readonly T[]): T[] {
  return fields.filter(field => field.hidden !== true);
}
