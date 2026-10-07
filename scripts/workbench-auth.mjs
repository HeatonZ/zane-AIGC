/** Only call for the workbench origin, never for Hermes/ComfyUI upstream requests. */
export function workbenchFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  if (process.env.ZANE_API_TOKEN && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + process.env.ZANE_API_TOKEN);
  return fetch(input, { ...init, headers });
}
