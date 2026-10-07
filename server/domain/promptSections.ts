/** Normalize declared section headers only; never rewrite bodies, fill gaps or reorder sections. */
export function normalizePromptSectionHeadings(prompt: string, sections: readonly string[], aliases: Readonly<Record<string, string>> = {}) {
  const names = new Map(sections.map(section => [section.toLowerCase(), section]));
  for (const [alias, target] of Object.entries(aliases)) {
    if (!sections.includes(target)) throw new Error("提示词标题别名引用了未声明段落：" + target);
    names.set(alias.toLowerCase(), target);
  }
  if (!names.size) return prompt;
  const escaped = [...names.keys()].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Horizontal whitespace only: never consume newlines or neighboring body text.
  const pattern = new RegExp("^[ \\t]*(" + escaped.join("|") + ")[ \\t]*:", "gmi");
  return prompt.replace(pattern, (_match, name: string) => names.get(name.toLowerCase()) + ":");
}
