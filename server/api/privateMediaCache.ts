import type { Response } from "express";

/** Store private media bytes while requiring the authenticated route to revalidate every reuse. */
export function enablePrivateMediaRevalidation(response: Response) {
  response.set("Cache-Control", "private, no-cache, must-revalidate");
  response.vary("Authorization");
  response.vary("Cookie");
  response.vary("X-Zane-Actor");
}
