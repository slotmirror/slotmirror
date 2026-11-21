import { isAppPagePath } from "./app-base";

/** Longest `back` value that is used. A longer one is a crafted request, so it gets the fallback. */
export const MAX_BACK_LENGTH = 512;

/** True if the text holds a control character, a space or a backslash. */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * For one release: a page of the last release posted `back` below `/next`. `/next` becomes `/` and
 * `/next/<page>` becomes `/<page>`. Any other path stays as it is. The mapped path still has to pass
 * `isAppPagePath`, so it can never name another host. Returns null for a `/next` path with a dot
 * segment, because the parsed path of "/next/../admin" says nothing about what was posted.
 */
function staleNextPath(value: string, pathname: string): string | null {
  const rawPath = value.split(/[?#]/, 1)[0] ?? "";
  if (rawPath !== "/next" && !rawPath.startsWith("/next/")) return pathname;
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return pathname === "/next" ? "/" : pathname.slice("/next".length);
}

/**
 * Where a form of an app page returns to after a POST: the form field `back`, if it is the address
 * of an app page of this site (`isAppPagePath`: the Overview or a page of `APP_PAGES`, with an
 * optional query), else `fallback`. The check is strict, because a redirect to a value from a form
 * is an open redirect if the value can name another host.
 *
 * Browsers read "//host" and "/\host" as another host, and drop tabs and newlines inside a URL,
 * so "/\t/host" turns into "//host". The path is checked as parsed text, not as typed.
 */
export function backPath(form: FormData, fallback: string): string {
  const value = form.get("back");
  if (typeof value !== "string" || value.length > MAX_BACK_LENGTH) return fallback;
  if (!value.startsWith("/")) return fallback;
  // Control characters and spaces, backslashes and a second slash have no place in a local path.
  if (value.includes("//") || hasUnsafeCharacter(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, "https://back.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://back.invalid") return fallback;
  const pathname = staleNextPath(value, url.pathname);
  if (pathname === null || !isAppPagePath(pathname)) return fallback;
  return `${pathname}${url.search}`;
}

/**
 * The form of a POST, or null if the body is no form (no body, a wrong content type, a broken
 * multipart). A handler reads it before it acts, so that a request without a form does nothing
 * and gets a 400, not a 500 after the action ran.
 */
export async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
