import type { Child } from "hono/jsx";
import type { CalendarCleanup, Cleanups } from "../../../cleanup";
import type { SetupStatus } from "../../../config";
import type { CurrentUser } from "../../../users";
import {
  CleanupPage,
  ConsentPage,
  DeleteUserPage,
  DisconnectPage,
  MessagePage,
  OAuthErrorPage,
  PrivacyPage,
  SetupPage,
  SignInPage,
} from "./index";

/** Sample pages for the dev preview route. Never reached outside a local or test deployment. */
export const PREVIEW_PAGES = [
  "sign-in",
  "setup",
  "consent",
  "privacy",
  "message",
  "oauth-error",
  "disconnect",
  "delete",
  "cleanup",
] as const;
export type PreviewPage = (typeof PREVIEW_PAGES)[number];

const SETUP_BASE: SetupStatus = {
  accessConfigured: false,
  sessionSecret: false,
  tokenEncryptionKey: false,
  providers: { microsoft: false, google: false },
  signIn: false,
  unknownSignInEntries: [],
  ready: false,
};

const CALENDAR: CalendarCleanup = {
  name: "Work",
  account: "ada@example.com",
  blocks: 14,
  estimated: false,
  markers: [{ ruleTag: "sm-3f9a", blockTitle: "Busy" }],
  windowStart: "2026-11-01T00:00:00Z",
  windowEnd: "2026-12-15T00:00:00Z",
  reasons: ["token_refused"],
  waitsUntil: null,
};

const RUNNING: CalendarCleanup = {
  ...CALENDAR,
  name: null,
  markers: [],
  reasons: [],
  waitsUntil: "2099-01-01T00:00:00Z",
};

const REFERENCE = "r-4f7c2a91";

/** The page for `/dev/next-preview/<page>?v=<variant>`, or null for an unknown page. */
export function previewPage(page: string, variant: string, user: CurrentUser): Child | null {
  switch (page as PreviewPage) {
    case "sign-in":
      return (
        <SignInPage
          providers={{
            microsoft: variant !== "google",
            google: variant !== "microsoft",
          }}
          operatorNotice={
            variant === "notice"
              ? "This deployment is run by the IT team of Example GmbH for its staff."
              : undefined
          }
        />
      );
    case "setup": {
      const status: SetupStatus =
        variant === "partial"
          ? { ...SETUP_BASE, accessConfigured: true, sessionSecret: true }
          : variant === "invalid"
            ? {
                ...SETUP_BASE,
                accessConfigured: true,
                sessionSecret: true,
                tokenEncryptionKey: true,
                unknownSignInEntries: ["both"],
              }
            : SETUP_BASE;
      return <SetupPage status={status} />;
    }
    case "consent":
      return (
        <ConsentPage
          user={user}
          appName={
            variant === "long"
              ? "An agent with a very long name that goes on and on without any sign of stopping ".repeat(
                  2,
                )
              : variant === "unnamed"
                ? ""
                : "Claude"
          }
          returnsTo={variant === "long" ? "127.0.0.1:33418" : "claude.ai"}
          resume="/oauth/authorize?client_id=preview"
          offerEvents={variant === "events" || variant === "long"}
          ticket="preview-ticket"
        />
      );
    case "privacy":
      return (
        <PrivacyPage
          operator="Example GmbH"
          contact={variant === "unknown" ? "" : "privacy@example.com"}
          notice={variant === "notice" ? "Used by the staff of Example GmbH only." : undefined}
          user={variant === "user" ? user : null}
        />
      );
    case "message":
      return (
        <MessagePage
          title={variant === "long" ? "This request has expired" : "Not allowed"}
          message={
            variant === "long"
              ? "This request has expired or belongs to another sign-in. Start the connection in the app again, and keep this window open until you have answered. ".repeat(
                  2,
                )
              : "ada@example.com may not sign in to this deployment."
          }
          user={variant === "user" ? user : null}
        />
      );
    case "oauth-error":
      return (
        <OAuthErrorPage
          title={variant === "plain" ? "Sign-in failed" : "Microsoft needs permission first"}
          lead={
            variant === "plain"
              ? "The token exchange with Microsoft failed. If you ask for help, quote the code and the reference below."
              : "Microsoft did not let slotmirror continue. You may have cancelled, or your organisation may not allow people to approve apps themselves."
          }
          steps={
            variant === "plain"
              ? undefined
              : "If you cancelled, try again. If your organisation blocks the approval, send the request below to your IT administrator."
          }
          code={variant === "nocode" ? null : "AADSTS65001"}
          reference={REFERENCE}
          helpHref="https://slotmirror.com/docs/troubleshooting/#aadsts65001"
          retryHref="/auth/microsoft/login"
          request={
            variant === "plain"
              ? undefined
              : {
                  title: "Request for your administrator",
                  text: 'Please approve the app "slotmirror" for our Microsoft 365 organisation.\n\nApplication (client) ID: 00000000-0000-0000-0000-000000000000\nPermissions (delegated): offline_access, Calendars.ReadWrite\nPurpose: it reads the busy times of calendars and writes "Busy" blocks into other calendars.\n\nApprove for the whole organisation: https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=00000000-0000-0000-0000-000000000000',
                }
          }
        />
      );
    case "disconnect":
      return (
        <DisconnectPage
          user={user}
          accountId="acc-preview"
          email="ada@example.com"
          rules={variant === "none" ? 0 : 4}
        />
      );
    case "delete":
      return variant === "other" ? (
        <DeleteUserPage
          user={user}
          target={{ email: "grace@example.com", accounts: 2 }}
          ownAccounts={0}
          action="/admin/users/preview/delete"
          cancel="/admin"
        />
      ) : (
        <DeleteUserPage
          user={user}
          target={null}
          ownAccounts={2}
          action="/account/delete"
          cancel="/"
        />
      );
    case "cleanup": {
      const cleanups: Record<string, { own: Cleanups; others: Cleanups }> = {
        empty: { own: { left: [], running: [] }, others: { left: [], running: [] } },
        running: { own: { left: [], running: [RUNNING] }, others: { left: [], running: [] } },
        both: {
          own: { left: [CALENDAR], running: [RUNNING] },
          others: { left: [{ ...CALENDAR, account: null, blocks: null }], running: [] },
        },
      };
      const chosen = cleanups[variant] ?? cleanups.both;
      return chosen ? <CleanupPage user={user} own={chosen.own} others={chosen.others} /> : null;
    }
    default:
      return null;
  }
}
