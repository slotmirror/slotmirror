import { APP_BASE, appPath } from "../../app-base";
import type { Child } from "hono/jsx";
import { APP_NAME } from "../../brand";
import { LOCALE_NAMES, LOCALES, useI18n, useLanguageHref, type Locale } from "../../i18n";
import { can, type Action } from "../../permissions";
import type { CurrentUser } from "../../users";
import { buildVersionLabel } from "../../version";
import { useFeatures } from "../features";
import { asset, ASSET_VERSION, FONT_URL } from "./assets";
import {
  GO_KEYS,
  Palette,
  PaletteTrigger,
  ShortcutSheet,
  SingleKeySwitch,
  type PaletteData,
} from "./palette";

export type ShellPage = "overview" | "mirroring" | "calendars" | "activity" | "tokens" | "admin";

/**
 * Enhanced navigation (`/next/enhance.js`): app links and forms fetch the next page and merge it,
 * without a full load. The kill switch is this constant:
 * - "on": the default for every browser;
 * - "off": the scripts load but stay idle (`<html data-enhance-default="off">`) unless a browser opts in
 *   with `?enhance=on`;
 * - "never": no Idiomorph and no `enhance.js` tags; every link and form is a normal page load.
 * A browser keeps `?enhance=on` or `?enhance=off` in localStorage, for testing either mode or for
 * one person who needs plain page loads.
 */
export const ENHANCED_NAVIGATION: "on" | "off" | "never" = "on";

/**
 * The scripts of every app page, in this order, all from the head. The list must be the same on
 * every app page: `enhance.js` takes a different list for a new deploy and loads the page fully.
 * `theme.js` runs first and without `defer`, so that theme and `js` class are set before the first
 * paint. The others are deferred and wait for the event that concerns them.
 */
export function appScripts(mode: typeof ENHANCED_NAVIGATION = ENHANCED_NAVIGATION): string[] {
  const enhance =
    mode === "never" ? [] : ["/next/vendor/idiomorph-0.8.0.min.js", "/next/enhance.js"];
  return [
    ...enhance,
    "/next/panel.js",
    "/next/mirroring.js",
    "/next/calendars.js",
    "/next/activity.js",
    "/next/tokens.js",
    "/next/palette.js",
  ];
}

/**
 * A live region for what `enhance.js` reports: a save, an updated list, an error, the end of the
 * session. The texts come from here, so no user-facing text lives in a script. The merge keeps
 * this element (`data-morph-keep`).
 */
function Announcer() {
  const { t } = useI18n();
  const text = t.next.shell.enhance;
  return (
    <div
      id="announcer"
      class="sr-only"
      aria-live="polite"
      data-morph-keep
      data-msg-saved={text.saved}
      data-msg-updated={text.updated}
      data-msg-loading={text.loading}
      data-msg-error-network={text.errorNetwork}
      data-msg-error-server={text.errorServer}
      data-msg-session-ended={t.next.shell.panel.sessionEnded}
    />
  );
}

/**
 * The `--chrome` token of `/next/base.css` as sRGB, for what CSS cannot reach: the browser's
 * title bar (`theme-color`) and the manifest. `test/app-shell.test.ts` compares them with the CSS.
 */
export const CHROME_COLORS = { light: "#f2f4f6", dark: "#0c0d10" } as const;

/**
 * The head parts that both layouts share and that make the pages an installable app: the viewport
 * (`viewport-fit=cover` lets the safe-area insets work), the colour scheme, the title bar colour
 * per scheme, the icons and the manifest. Scripts and styles stay with the layouts.
 *
 * `theme.js` sets `content` on both `theme-color` metas when the user picks light or dark (the
 * media queries only follow the system). Each meta carries both colours for that.
 */
export function AppHead() {
  return (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="color-scheme" content="light dark" />
      <meta
        name="theme-color"
        content={CHROME_COLORS.light}
        media="(prefers-color-scheme: light)"
        data-light={CHROME_COLORS.light}
        data-dark={CHROME_COLORS.dark}
      />
      <meta
        name="theme-color"
        content={CHROME_COLORS.dark}
        media="(prefers-color-scheme: dark)"
        data-light={CHROME_COLORS.light}
        data-dark={CHROME_COLORS.dark}
      />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/app-icons/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-title" content={APP_NAME} />
      <link rel="manifest" href="/manifest.webmanifest" />
    </>
  );
}

/** A 16 px stroke icon for the navigation. The label next to it carries the meaning. */
function NavIcon(props: { children: Child }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

interface NavEntry {
  id: ShellPage;
  href: string;
  /** The action the page needs; the entry shows only to users who have it. */
  action: Action;
  /** Only while the deployment has the API tokens on. */
  tokensOnly?: boolean;
  icon: () => Child;
}

/** The pages of the redesign. */
const PRIMARY: readonly NavEntry[] = [
  {
    id: "overview",
    href: appPath("/"),
    action: "accounts:read",
    icon: () => (
      <NavIcon>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
      </NavIcon>
    ),
  },
  {
    id: "mirroring",
    href: appPath("/mirroring"),
    action: "rules:read",
    icon: () => (
      <NavIcon>
        <path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />
      </NavIcon>
    ),
  },
  {
    id: "calendars",
    href: appPath("/calendars"),
    action: "accounts:read",
    icon: () => (
      <NavIcon>
        <rect x="3" y="5" width="18" height="16" rx="2.5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </NavIcon>
    ),
  },
  {
    id: "activity",
    href: appPath("/activity"),
    action: "activity:read",
    icon: () => (
      <NavIcon>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </NavIcon>
    ),
  },
];

/** Set apart at the bottom of the sidebar. */
const SECONDARY: readonly NavEntry[] = [
  {
    id: "tokens",
    href: appPath("/tokens"),
    action: "tokens:read",
    tokensOnly: true,
    icon: () => (
      <NavIcon>
        <circle cx="8" cy="15" r="4.5" />
        <path d="M11.5 11.5L20 3M16 7l3 3" />
      </NavIcon>
    ),
  },
  {
    id: "admin",
    href: appPath("/admin"),
    action: "users:read",
    icon: () => (
      <NavIcon>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      </NavIcon>
    ),
  },
];

/*
 * The logo, direction "Eyes, refined" (`design/logo-next/eyes/`): two calendars as eyes, the
 * original event as a solid pupil, its copy in the colour of the original. From 24 px the copy is
 * hatched at 45 degrees (`mark.svg`). Below 24 px the hatch breaks into dots at 1x (checked at
 * 22 px, the public layout), so the copy is a flat tint and the outlines are the ones drawn for
 * 20 px (`mark-20.svg`), as the logo's own rule says (`design/logo-next/README.md`). The colours are
 * tokens of base.css (`--brand-ink`, `--brand-eye`, `--brand-copy`), so both themes follow.
 */
const BRAND_LARGE = {
  eyes: [
    "M14 6H18A11 11 0 0 1 29 17V47A11 11 0 0 1 18 58H14A11 11 0 0 1 3 47V17A11 11 0 0 1 14 6ZM14 12H18A5 5 0 0 1 23 17V47A5 5 0 0 1 18 52H14A5 5 0 0 1 9 47V17A5 5 0 0 1 14 12Z",
    "M46 6H50A11 11 0 0 1 61 17V47A11 11 0 0 1 50 58H46A11 11 0 0 1 35 47V17A11 11 0 0 1 46 6ZM46 12H50A5 5 0 0 1 55 17V47A5 5 0 0 1 50 52H46A5 5 0 0 1 41 47V17A5 5 0 0 1 46 12Z",
  ],
  original:
    "M16 21H16A4.5 4.5 0 0 1 20.5 25.5V38.5A4.5 4.5 0 0 1 16 43H16A4.5 4.5 0 0 1 11.5 38.5V25.5A4.5 4.5 0 0 1 16 21Z",
  copy: "M48 21H48A4.5 4.5 0 0 1 52.5 25.5V38.5A4.5 4.5 0 0 1 48 43H48A4.5 4.5 0 0 1 43.5 38.5V25.5A4.5 4.5 0 0 1 48 21Z",
  hatch:
    "M21.7 45L47.7 19M28.77 45L54.77 19M35.84 45L61.84 19M42.91 45L68.91 19M49.98 45L75.98 19M57.06 45L83.06 19",
} as const;

const BRAND_SMALL = {
  eyes: [
    "M14.4 6.4H17.6A11.2 11.2 0 0 1 28.8 17.6V46.4A11.2 11.2 0 0 1 17.6 57.6H14.4A11.2 11.2 0 0 1 3.2 46.4V17.6A11.2 11.2 0 0 1 14.4 6.4ZM14.4 12.8H17.6A4.8 4.8 0 0 1 22.4 17.6V46.4A4.8 4.8 0 0 1 17.6 51.2H14.4A4.8 4.8 0 0 1 9.6 46.4V17.6A4.8 4.8 0 0 1 14.4 12.8Z",
    "M46.4 6.4H49.6A11.2 11.2 0 0 1 60.8 17.6V46.4A11.2 11.2 0 0 1 49.6 57.6H46.4A11.2 11.2 0 0 1 35.2 46.4V17.6A11.2 11.2 0 0 1 46.4 6.4ZM46.4 12.8H49.6A4.8 4.8 0 0 1 54.4 17.6V46.4A4.8 4.8 0 0 1 49.6 51.2H46.4A4.8 4.8 0 0 1 41.6 46.4V17.6A4.8 4.8 0 0 1 46.4 12.8Z",
  ],
  original:
    "M16 22.4H16A3.2 3.2 0 0 1 19.2 25.6V38.4A3.2 3.2 0 0 1 16 41.6H16A3.2 3.2 0 0 1 12.8 38.4V25.6A3.2 3.2 0 0 1 16 22.4Z",
  copy: "M48 22.4H48A3.2 3.2 0 0 1 51.2 25.6V38.4A3.2 3.2 0 0 1 48 41.6H48A3.2 3.2 0 0 1 44.8 38.4V25.6A3.2 3.2 0 0 1 48 22.4Z",
} as const;

/** The logo mark, 20 px by default. Decorative: the app name always stands next to it. */
export function BrandMark(props: { size?: number }) {
  const size = props.size ?? 20;
  const small = size < 24;
  const mark = small ? BRAND_SMALL : BRAND_LARGE;
  // One id per size: the sidebar and a page could both draw a large mark.
  const clip = `brand-copy-${size}`;
  return (
    <svg
      class="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-size={small ? "small" : "large"}
    >
      {mark.eyes.map((d) => (
        <path class="brand-ink" fill-rule="evenodd" d={d} />
      ))}
      <path class="brand-eye" d={mark.original} />
      {small ? (
        <path class="brand-copy" d={mark.copy} />
      ) : (
        <>
          <clipPath id={clip}>
            <path d={BRAND_LARGE.copy} />
          </clipPath>
          <path
            class="brand-hatch"
            clip-path={`url(#${clip})`}
            fill="none"
            stroke-width="2.5"
            d={BRAND_LARGE.hatch}
          />
        </>
      )}
    </svg>
  );
}

/**
 * The letters in the avatar. A name gives two initials ("Jane Doe", or "jane.doe@" as the
 * part before the @); a single word gives its first letter only. Two letters of one word read as
 * something else: "DE" from "dev@" reads as a language code.
 */
export function initials(email: string, name?: string): string {
  const source = name?.trim() || (email.split("@")[0] ?? "");
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = [...(parts[0] ?? "")][0] ?? "";
  const second = parts.length > 1 ? ([...(parts.at(-1) ?? "")][0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

/** Nav entries that can carry an attention dot. */
export type ShellAttention = Partial<Record<"mirroring" | "calendars", boolean>>;

/**
 * A header action that opens a panel on this page, such as "For all mirrorings". `open` marks it
 * pressed while its panel is open; then the link closes the panel. A link that shows and hides a
 * region announces that with `aria-expanded` (`aria-pressed` is for buttons only).
 */
export function HeaderAction(props: {
  href: string;
  /** Where the link goes while the panel is open, usually the page without the panel. */
  closeHref: string;
  open: boolean;
  icon?: Child;
  children: Child;
}) {
  return (
    <a
      class="btn btn-secondary"
      href={props.open ? props.closeHref : props.href}
      aria-expanded={props.open ? "true" : "false"}
    >
      {props.icon}
      {props.children}
    </a>
  );
}

/** The language switch as a segmented control of links; the detector stores the choice. */
function LanguageLinks() {
  const { locale, t } = useI18n();
  return (
    <span class="seg" role="group" aria-label={t.next.shell.user.language}>
      {LOCALES.map((code) => (
        <LanguageLink code={code} current={code === locale} />
      ))}
    </span>
  );
}

export function LanguageLink(props: { code: Locale; current: boolean }) {
  const href = useLanguageHref(props.code);
  return props.current ? (
    <span class="seg-item" aria-current="true" title={LOCALE_NAMES[props.code]}>
      {props.code.toUpperCase()}
    </span>
  ) : (
    <a class="seg-item" href={href} hreflang={props.code} title={LOCALE_NAMES[props.code]}>
      {props.code.toUpperCase()}
    </a>
  );
}

/**
 * The shell of the redesign: sidebar, one raised main panel with a header row, and an optional
 * detail panel on the right. It loads `/next/base.css`, never the old stylesheet.
 */
export function Shell(props: {
  title: string;
  user: CurrentUser;
  /** The nav entry of this page; none for pages without one, such as "Delete my data". */
  active?: ShellPage;
  /**
   * One short line next to the title. Use it for live state ("6 mirrorings in sync"), not to
   * explain the page.
   */
  lead?: Child;
  /** Nav entries that get a dot because something there needs attention. */
  attention?: ShellAttention;
  /**
   * Width of the content column. Default 1120 px (with a panel, list plus panel 1520 px).
   * "narrow" (848 px) for pages of text and short lists, so that text and rows end at one x;
   * "wide" (1408 px) for the Overview's map and side column.
   */
  width?: "narrow" | "wide";
  /** Header actions, right aligned. */
  actions?: Child;
  /** The right detail panel (see `Panel`). */
  panel?: Child;
  /** Page stylesheets, as paths such as "/next/mirroring.css". */
  styles?: string[];
  /** What the command palette lists besides pages, actions and settings. */
  palette?: PaletteData;
  children: Child;
}) {
  const { user } = props;
  const { locale, t } = useI18n();
  const shell = t.next.shell;
  const features = useFeatures();
  const version = buildVersionLabel();
  const allowed = (entry: NavEntry) =>
    can(user, entry.action) && (!entry.tokensOnly || features.tokens);
  const link = (entry: NavEntry) => {
    const attention =
      (entry.id === "mirroring" || entry.id === "calendars") && props.attention?.[entry.id];
    const go = entry.id in GO_KEYS ? GO_KEYS[entry.id as keyof typeof GO_KEYS] : undefined;
    return (
      <a
        class="nav-item"
        href={entry.href}
        aria-current={props.active === entry.id ? "page" : undefined}
        aria-keyshortcuts={go ? `G ${go}` : undefined}
        title={go ? `${shell.nav[entry.id]} (G, ${go})` : undefined}
      >
        {entry.icon()}
        <span class="nav-label">{shell.nav[entry.id]}</span>
        {attention ? (
          <>
            <span class="nav-attention" aria-hidden="true" />
            <span class="sr-only">{`, ${shell.nav.attention}`}</span>
          </>
        ) : null}
      </a>
    );
  };
  const frameClass = [
    "frame",
    props.panel ? "has-panel" : "",
    props.width ? `is-${props.width}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const secondary = SECONDARY.filter(allowed);
  return (
    <html
      lang={locale}
      data-asset-v={ASSET_VERSION}
      data-app-base={APP_BASE}
      data-enhance-default={ENHANCED_NAVIGATION === "off" ? "off" : undefined}
    >
      <head>
        <meta charset="utf-8" />
        <AppHead />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        {/* No defer: the theme must be set before the first paint. */}
        <script src={asset("/next/theme.js")} />
        {appScripts().map((src) => (
          <script src={asset(src)} defer />
        ))}
        <link rel="preload" href={FONT_URL} as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href={asset("/next/base.css")} />
        {(props.styles ?? []).map((href) => (
          <link rel="stylesheet" href={asset(href)} />
        ))}
      </head>
      {/* `data-app` marks an app page for `enhance.js`; any other answer loads normally. */}
      <body class="app" data-app="next">
        <Announcer />
        <a class="skip" href="#main">
          {shell.nav.skip}
        </a>
        <aside class="sidebar">
          <a href={appPath("/")} class="brand">
            <BrandMark />
            <span>{APP_NAME}</span>
          </a>
          <PaletteTrigger />
          <nav class="nav" aria-label={shell.nav.main}>
            <div class="nav-group">{PRIMARY.filter(allowed).map(link)}</div>
            {secondary.length > 0 ? (
              <div class="nav-group nav-secondary">{secondary.map(link)}</div>
            ) : null}
          </nav>
          {/* Native popover: opens on click, closes on outside click and Escape, no script. */}
          <button
            type="button"
            class="user-button"
            popovertarget="user-menu"
            aria-label={shell.user.menu}
          >
            <span class="avatar">{initials(user.email)}</span>
            <span class="user-email">{user.email}</span>
          </button>
          <div id="user-menu" class="menu menu-pop" popover="auto">
            <div class="menu-head">
              <div class="menu-email">{user.email}</div>
              <div class="muted">{t.roles[user.role]}</div>
            </div>
            <div class="menu-row">
              <span>{shell.user.language}</span>
              <LanguageLinks />
            </div>
            {/* Hidden by CSS without `html.js`: the theme choice needs `theme.js`. */}
            <div class="menu-row" data-needs-script>
              <span>{shell.user.theme}</span>
              <span class="seg" role="group" aria-label={shell.user.theme}>
                <button type="button" class="seg-item" data-theme-choice="system">
                  {shell.user.themeSystem}
                </button>
                <button type="button" class="seg-item" data-theme-choice="light">
                  {shell.user.themeLight}
                </button>
                <button type="button" class="seg-item" data-theme-choice="dark">
                  {shell.user.themeDark}
                </button>
              </span>
            </div>
            <SingleKeySwitch />
            <div class="menu-sep" />
            <form method="post" action="/auth/logout">
              <button type="submit" class="menu-item">
                {shell.user.signOut}
              </button>
            </form>
            {/* A group of its own, in the danger colour, so it never reads as a sibling of "Sign
                out". The link opens a page that lists what is deleted and asks to confirm. */}
            <div class="menu-sep" />
            <a class="menu-item menu-item-danger" href="/account/delete">
              {shell.user.deleteMyData}
            </a>
            <div class="menu-sep" />
            <div class="menu-foot">
              <a href="/privacy">{shell.user.privacy}</a>
              {version ? (
                <span class="num" title={shell.user.version}>
                  {version}
                </span>
              ) : null}
            </div>
          </div>
        </aside>
        <Palette user={user} data={props.palette} />
        <ShortcutSheet user={user} />
        <div class={frameClass}>
          <div class="workspace">
            <main class="pane" id="main" tabindex={-1}>
              <header class="page-head">
                <div class="page-head-inner">
                  <h1 class="page-title" id="page-title" tabindex={-1}>
                    {props.title}
                  </h1>
                  {props.lead ? <p class="page-lead">{props.lead}</p> : null}
                  {props.actions ? <div class="page-actions">{props.actions}</div> : null}
                </div>
              </header>
              <div class="page-scroll">
                <div class="content">{props.children}</div>
              </div>
            </main>
            {props.panel}
          </div>
        </div>
      </body>
    </html>
  );
}
