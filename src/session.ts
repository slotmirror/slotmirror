/**
 * Signed cookies: `base64url(payload).base64url(hmac)`. No server-side store.
 * Used for the session and for the short-lived OAuth state.
 */

export const SESSION_COOKIE = "slotmirror_session";
/** Twelve hours: a working day. Signing in again is one click with the provider. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface Session {
  userId: string;
  /** Expiry as Unix seconds. */
  exp: number;
  /** `users.session_version` at sign-in. Sessions from before versions existed carry none: 0. */
  version?: number;
}

export function signSession(session: Session, secret: string): Promise<string> {
  return signPayload(session, secret);
}

/** Return the session if the signature is valid and it has not expired, otherwise null. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<Session | null> {
  const session = await verifyPayload<Session>(token, secret, now);
  return session && typeof session.userId === "string" ? session : null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Headers that a reverse proxy or a tunnel adds. A request that carries one came through another
 * machine, even if it names a local host. `MF-Original-URL` sets the URL in Miniflare; Miniflare
 * removes it before the Worker runs, so it counts only on a runtime that passes it on.
 */
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "true-client-ip",
  "mf-original-url",
];

/** The variables that decide the local sign-in without a provider. */
export type DevSignInEnv = Pick<Env, "DEV_SIGN_IN_AS" | "DEV_FAKE_CALENDARS" | "PUBLIC_URL">;

/** The host name of an address, or null if it does not parse. */
function hostnameOf(address: string): string | null {
  try {
    return new URL(address).hostname;
  } catch {
    return null;
  }
}

/** True for an address whose host is local. An address that does not parse is not local. */
function isLocalAddress(address: string): boolean {
  // "localhost:8787" parses with "localhost:" as the scheme and no host, so it is not local.
  return LOCAL_HOSTS.has(hostnameOf(address) ?? "");
}

/** True for a loopback IP address: 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
function isLoopbackIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  return value === "::1" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(value);
}

/**
 * Local development only: the email in `DEV_SIGN_IN_AS`. All of these must hold:
 *
 * - `DEV_FAKE_CALENDARS` is "1". It marks a development or load-test instance; a deployment that
 *   serves real users does not set it.
 * - `PUBLIC_URL` is unset or local. A public address, as with a tunnel, turns the bypass off.
 * - The request goes to a local host, and its `Host` header names the same host.
 * - The request carries no proxy header, such as `X-Forwarded-For` or `Forwarded`.
 * - `CF-Connecting-IP`, if present, is a loopback address. This stops only a proxy that sets the
 *   header, such as Cloudflare. `wrangler dev` keeps the value that a client sends.
 *
 * These checks stop a configuration mistake, not a client that reaches the server. The code cannot
 * see the socket. Under `wrangler dev` a client that sends `MF-Original-URL` chooses the URL and the
 * `Host` header that the Worker sees. So a server that listens on a non-loopback address, or any
 * proxy or port forward in front of it, signs every visitor in.
 */
export function devSignInEmail(env: DevSignInEnv, request: Request): string | null {
  const email = env.DEV_SIGN_IN_AS?.trim();
  if (!email) return null;
  if (env.DEV_FAKE_CALENDARS !== "1") return null;
  const publicUrl = env.PUBLIC_URL?.trim();
  if (publicUrl && !isLocalAddress(publicUrl)) return null;
  if (!isLocalAddress(request.url)) return null;
  const host = request.headers.get("host");
  if (host === null || hostnameOf(`http://${host}`) !== hostnameOf(request.url)) return null;
  if (PROXY_HEADERS.some((name) => request.headers.has(name))) return null;
  const client = request.headers.get("cf-connecting-ip");
  if (client !== null && !isLoopbackIp(client)) return null;
  return email;
}

/** Sign any JSON payload that carries an `exp` in Unix seconds. */
export async function signPayload(payload: { exp: number }, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** Return the payload if the signature is valid and `exp` lies in the future, otherwise null. */
export async function verifyPayload<T extends { exp: number }>(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<T | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
    return typeof payload.exp === "number" && payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

/** Imported keys per secret. Importing on every request costs CPU on the Free plan's 10 ms budget. */
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
