/**
 * Settings of a deployment. They are not in `wrangler.jsonc`, so a deploy keeps the values set in
 * the Cloudflare dashboard. Any of them can be missing, not only empty. Read them with `?? ""`.
 */
interface WorkerSettings {
  ORG_NAME?: string;
  ALLOWED_EMAILS?: string;
  ALLOWED_DOMAINS?: string;
  ALLOWED_TENANT_IDS?: string;
  ADMIN_EMAILS?: string;
  PRIVACY_CONTACT?: string;
  OPERATOR_NOTICE?: string;
  SIGN_IN_PROVIDERS?: string;
  /** Public https address of the deployment. Without it, only the cron syncs. */
  PUBLIC_URL?: string;
  DATA_JURISDICTION?: string;
  MAX_DETAIL_TO_EXTERNAL?: string;
  MAX_DETAIL_FROM_EXTERNAL?: string;
  /** "1" turns on the read-only MCP endpoint and API tokens. Anything else: both answer 404. */
  MCP_ENABLED?: string;
  /** IANA time zone for dates in the dashboard. Without it, UTC. */
  TIME_ZONE?: string;
}

/**
 * Worker secrets. `wrangler types` only sees secrets that exist in a local `.dev.vars`, so they are
 * declared here; the generated types then do not depend on a developer's local files.
 */
interface WorkerSecrets {
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * Optional. Incoming webhook (Slack-compatible JSON `{"text": ...}`) that hears once when an
   * account needs to be connected again.
   */
  ALERT_WEBHOOK_URL?: string;
  /** Optional. An outside monitor's URL that hears a plain GET once an hour from the cron. */
  HEARTBEAT_URL?: string;
  /**
   * Local development only: sign every request in as the user with this email, without a provider.
   * Needs DEV_FAKE_CALENDARS=1. Works only on localhost, 127.0.0.1 and [::1], and not while
   * PUBLIC_URL names another host (`devSignInEmail` in session.ts). Never set it behind a proxy or
   * on a server that listens on a non-loopback address: anyone who reaches it acts as this user.
   * The user must exist in the local database.
   */
  DEV_SIGN_IN_AS?: string;
  /**
   * Development and load tests only: "1" turns on simulated calendars and the /dev routes. It is
   * also the development marker that DEV_SIGN_IN_AS needs. Never set it for real users.
   */
  DEV_FAKE_CALENDARS?: string;
  /** Local load tests only: simulated network time per provider call, in milliseconds. */
  DEV_FAKE_LATENCY_MS?: string;
  /**
   * Load tests only: a URL that the operator owns. With DEV_FAKE_CALENDARS=1, each simulated
   * provider call fetches it or a page below it once, so that the subrequest limit applies.
   * Unset: no fetch.
   */
  DEV_FAKE_FETCH_URL?: string;
  /** Tests only: delay before a requested sync starts, in milliseconds. Default 5000. */
  SYNC_DEBOUNCE_MS?: string;
  /** Tests only: delay between two alarm runs, in milliseconds. Default 1000. */
  SYNC_NEXT_RUN_MS?: string;
}

interface Env extends WorkerSecrets, WorkerSettings {}

declare namespace Cloudflare {
  interface Env extends WorkerSecrets, WorkerSettings {}
}
