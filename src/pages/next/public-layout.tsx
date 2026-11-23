import type { Child } from "hono/jsx";
import { APP_NAME } from "../../brand";
import { LOCALES, useI18n } from "../../i18n";
import { buildVersionLabel } from "../../version";
import { asset, FONT_URL } from "./assets";
import { AppHead, BrandMark, LanguageLink } from "./shell";

/** Stylesheet of the pages outside the app. `Shell` pages that reuse its classes load it too. */
export const PUBLIC_STYLES = ["/next/public.css"];

/**
 * Layout of the pages that live outside the app navigation: sign-in, setup, messages, errors,
 * consent, privacy for visitors. One column of 480 px on the chrome background, the same on every
 * page so that the logo does not move between steps, the brand on top, the footer below. It builds its head like `Shell`
 * does, so both share the theme script and the tokens of `/next/base.css`.
 */
export function PublicLayout(props: {
  title: string;
  /** A mark above the title, such as the app and slotmirror on the consent page. */
  mark?: Child;
  /** One or two sentences under the title. */
  lead?: Child;
  /**
   * Show the language switch. Its links repeat the current URL with its query, so a page whose
   * query comes from a foreign site (the provider's return) leaves it off.
   */
  languageSwitch?: boolean;
  children: Child;
}) {
  const { locale, t } = useI18n();
  const shell = t.next.shell;
  const version = buildVersionLabel();
  return (
    <html lang={locale}>
      <head>
        <meta charset="utf-8" />
        <AppHead />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        {/* No defer: the theme must be set before the first paint. */}
        <script src={asset("/next/theme.js")} />
        <script src={asset("/next/public.js")} />
        <link rel="preload" href={FONT_URL} as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href={asset("/next/base.css")} />
        {PUBLIC_STYLES.map((href) => (
          <link rel="stylesheet" href={asset(href)} />
        ))}
      </head>
      <body class="pub">
        <a class="skip" href="#main">
          {t.next.auth.layout.skip}
        </a>
        <div class="pub-page">
          <header class="pub-head">
            <a href="/" class="brand">
              <BrandMark size={22} />
              <span>{APP_NAME}</span>
            </a>
          </header>
          <main class="pub-panel" id="main" tabindex={-1}>
            {props.mark}
            <h1 class="pub-title">{props.title}</h1>
            {props.lead ? <p class="pub-lead">{props.lead}</p> : null}
            {props.children}
          </main>
          <footer class="pub-foot" aria-label={t.next.auth.layout.footer}>
            <div class="pub-foot-row">
              <a href="/privacy">{shell.user.privacy}</a>
              {props.languageSwitch ? (
                <span class="seg" role="group" aria-label={shell.user.language}>
                  {LOCALES.map((code) => (
                    <LanguageLink code={code} current={code === locale} />
                  ))}
                </span>
              ) : null}
              <span class="seg" role="group" aria-label={shell.user.theme} data-needs-script>
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
              {version ? (
                <span class="num" title={shell.user.version}>
                  {version}
                </span>
              ) : null}
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
