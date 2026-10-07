/** Explicit, random credentials for isolated compiled-backend smoke tests only. */
import { randomBytes } from "node:crypto";
const token = randomBytes(32).toString("base64url");
process.env.ZANE_ADMIN_TOKEN = token;
process.env.ZANE_API_TOKEN = token;
// Isolated single-listener fixtures must not inherit the production .env public port.
process.env.ZANE_PUBLIC_USER_PORT = "";
const originalFetch = globalThis.fetch;
globalThis.fetch = (input,init={}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["127.0.0.1","localhost","[::1]"].includes(url.hostname) && url.pathname.startsWith("/api/")) {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) headers.set("Authorization","Bearer " + token);
    init = {...init,headers};
  }
  return originalFetch(input,init);
};
