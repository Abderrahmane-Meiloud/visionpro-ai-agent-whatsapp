/** Pure validation/rendering for approved WhatsApp templates (no DB/network). */
export type TemplateLike = { variables: number; status: string; language: string };

export function validateTemplateSend(t: TemplateLike | null | undefined, variables: any): { error?: string; params?: string[] } {
  if (!t) return { error: 'unknown template' };
  if (t.status !== 'approved') return { error: 'template is not approved' };
  const params = Array.isArray(variables) ? variables.map((v) => String(v ?? '')) : [];
  if (params.length !== t.variables) return { error: `expected ${t.variables} variable(s), got ${params.length}` };
  for (const v of params) if (!v.trim()) return { error: 'template variables cannot be empty' };
  return { params };
}

/** Render a {{1}}/{{2}} body preview with the supplied variables (for storing a readable OUT message). */
export function renderPreview(bodyPreview: string, params: string[]): string {
  return bodyPreview.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? `{{${n}}}`);
}
