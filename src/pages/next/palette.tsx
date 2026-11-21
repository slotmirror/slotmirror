import { appPath } from "../../app-base";
import type { Child } from "hono/jsx";
import type { AccountColor } from "../../colors";
import type { Provider } from "../../config";
import type { EditorState, Level } from "../../editor";
import { LOCALE_NAMES, LOCALES, useI18n, useLanguageHref, type Locale } from "../../i18n";
import { can } from "../../permissions";
import type { CurrentUser } from "../../users";
import { useFeatures } from "../features";
import { CalendarSwatch, chipStyle, LevelMark, ProviderGlyph } from "./identity";
import { directionLevel } from "./levels";

/**
 * The command palette (Cmd/Ctrl+K) and the shortcut sheet (`?`), rendered by the server from data
 * the page has loaded: no request and no endpoint. `public/next/palette.js` opens them, filters
 * the options and runs them. The palette only navigates, opens panels, switches theme and
 * language, and reloads the calendar lists: no item signs out, deletes or changes a level.
 * Speed plan, sections 6 and 7.
 */

/** What the page has loaded. Admin and Tokens pass nothing: pages, actions and settings only. */
export interface PaletteData {
  state?: EditorState;
  providers?: Record<Provider, boolean>;
}

/** The `g` sequences: second key per page. */
export const GO_KEYS = { overview: "O", mirroring: "M", calendars: "C", activity: "A" } as const;

/** The platform hint: CSS shows one of the two by `html[data-platform]`. Not read aloud. */
function KeyHint(props: { mac: string; other: string }) {
  return (
    <>
      <kbd class="kbd-mac" aria-hidden="true">
        {props.mac}
      </kbd>
      <kbd class="kbd-other" aria-hidden="true">
        {props.other}
      </kbd>
    </>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

/** The trigger in the sidebar; on a phone an icon button in the top bar. Hidden without script. */
export function PaletteTrigger() {
  const { t } = useI18n();
  const text = t.next.palette;
  return (
    <button
      type="button"
      class="palette-trigger"
      command="show-modal"
      commandfor="palette"
      aria-haspopup="dialog"
      aria-label={text.open}
      aria-keyshortcuts="Meta+K Control+K"
      data-needs-script
    >
      <SearchIcon />
      <span class="palette-trigger-label">{text.open}</span>
      <KeyHint mac={text.key.mac} other={text.key.other} />
    </button>
  );
}

interface Option {
  /** The id in the recent list. A link's id is its address, so only buttons name one. */
  id?: string;
  label: string;
  meta?: string;
  keywords?: string;
  href?: string;
  hreflang?: string;
  /** "theme:<choice>", "shortcuts", "menu" (opens the user menu) or "submit" (the reload form). */
  action?: string;
  keys?: string[];
  /**
   * Identity, as attributes only: the script puts the marks from `PaletteMarks` in front of the
   * label when the palette opens. A row costs a few bytes, also with many calendars.
   */
  color?: AccountColor;
  level?: Level;
  provider?: Provider;
}

function OptionItem(props: { option: Option; index: number }) {
  const { option } = props;
  const body = (
    <>
      <span class="po-label">{option.label}</span>
      {option.meta ? <span class="po-meta">{option.meta}</span> : null}
      {option.keys ? (
        <span class="po-keys" aria-hidden="true">
          {option.keys.map((key) => (
            <kbd>{key}</kbd>
          ))}
        </span>
      ) : null}
    </>
  );
  const common = {
    role: "option",
    id: `po-${props.index}`,
    "data-id": option.href ? undefined : option.id,
    "data-k": option.keywords,
    "data-level": option.level,
    "data-p": option.provider,
    style: option.color ? chipStyle(option.color) : undefined,
    "aria-keyshortcuts": option.keys?.join(" "),
  };
  if (option.href) {
    return (
      <a {...common} href={option.href} hreflang={option.hreflang}>
        {body}
      </a>
    );
  }
  return option.action === "submit" ? (
    <button {...common} type="submit" form="palette-reload" data-action="submit">
      {body}
    </button>
  ) : (
    <button {...common} type="button" data-action={option.action}>
      {body}
    </button>
  );
}

function LanguageOption(props: { code: Locale; index: number; keywords: string }) {
  const { t } = useI18n();
  const href = useLanguageHref(props.code);
  return (
    <OptionItem
      index={props.index}
      option={{
        label: t.next.palette.items.language(LOCALE_NAMES[props.code]),
        keywords: `${props.keywords} ${t.next.palette.keywords.languageNames[props.code]} ${props.code}`,
        href,
        hreflang: props.code,
      }}
    />
  );
}

/**
 * One mark per kind that the rows name, rendered once: a swatch, the levels in use, the providers
 * in use, and the check of the current theme. `palette.js` copies them into the rows and colours
 * them with the row's `--c`.
 */
function PaletteMarks(props: { levels: Set<Level>; providers: Set<Provider> }) {
  const sample = { color: "slate" as const };
  return (
    <template data-marks>
      <CalendarSwatch account={sample} />
      {[...props.levels].map((level) => (
        <LevelMark level={level} tint={level === "off" ? undefined : sample.color} />
      ))}
      {[...props.providers].map((provider) => (
        <span data-p={provider}>
          <ProviderGlyph provider={provider} />
        </span>
      ))}
      <span class="po-check" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      </span>
    </template>
  );
}

/** The palette dialog. */
export function Palette(props: { user: CurrentUser; data?: PaletteData }) {
  const { locale, t } = useI18n();
  const text = t.next.palette;
  const words = text.keywords;
  const nav = t.next.shell.nav;
  const features = useFeatures();
  const { user } = props;
  const state = props.data?.state;
  const accounts = new Map(state?.accounts.map((account) => [account.id, account]));

  const pages: Option[] = [];
  const page = (id: keyof typeof GO_KEYS, href: string, allowed: boolean) => {
    if (allowed) {
      const keys = ["G", GO_KEYS[id]];
      pages.push({ label: nav[id], keywords: words[id], href, keys });
    }
  };
  page("overview", appPath("/"), can(user, "accounts:read"));
  page("mirroring", appPath("/mirroring"), can(user, "rules:read"));
  page("calendars", appPath("/calendars"), can(user, "accounts:read"));
  page("activity", appPath("/activity"), can(user, "activity:read"));
  if (can(user, "tokens:read") && features.tokens) {
    pages.push({ label: nav.tokens, keywords: words.tokens, href: appPath("/tokens") });
  }
  if (can(user, "users:read")) {
    pages.push({ label: nav.admin, keywords: words.admin, href: appPath("/admin") });
  }

  const mirrorings: Option[] = [];
  const calendars: Option[] = [];
  if (state && can(user, "rules:read")) {
    for (const direction of state.directions) {
      const from = accounts.get(direction.from);
      const to = accounts.get(direction.to);
      if (from === undefined || to === undefined) continue;
      const key = `${encodeURIComponent(direction.from)}~${encodeURIComponent(direction.to)}`;
      const level = directionLevel(state, direction);
      mirrorings.push({
        label: t.next.mirroring.fromTo(from.name, to.name),
        meta: t.next.shell.levels.summary[level],
        href: `${appPath("/mirroring")}?d=${key}`,
        color: from.color,
        level,
      });
    }
    mirrorings.push({
      label: text.items.forAll,
      keywords: words.forAll,
      href: `${appPath("/mirroring")}?d=all`,
    });
  }
  if (state && can(user, "accounts:read")) {
    for (const account of state.accounts) {
      calendars.push({
        label: account.name,
        meta: t.next.shell.providers[account.provider],
        href: `${appPath("/calendars")}?c=${encodeURIComponent(account.id)}`,
        color: account.color,
        provider: account.provider,
      });
    }
  }

  const actions: Option[] = [];
  if (can(user, "activity:read")) {
    actions.push({
      label: text.items.showProblems,
      keywords: words.showProblems,
      href: `${appPath("/activity")}?kind=problems`,
    });
  }
  const reload = Boolean(state) && can(user, "rules:write");
  if (reload) {
    actions.push({
      id: "a:reload",
      label: text.items.reload,
      keywords: words.reload,
      action: "submit",
    });
  }
  // Connecting a calendar is something to do, not a calendar: it sits with the actions.
  if (state && can(user, "accounts:read")) {
    for (const provider of ["microsoft", "google"] as const) {
      if (props.data?.providers?.[provider]) {
        actions.push({
          label: text.items.connect(t.next.shell.providers[provider]),
          keywords: `${words.connect} ${words.calendar}`,
          href: `/auth/${provider}/connect`,
        });
      }
    }
  }
  actions.push({
    id: "a:keys",
    label: text.items.shortcuts,
    keywords: words.shortcuts,
    action: "shortcuts",
    keys: ["?"],
  });
  // Opens the user menu and nothing else: sign out and delete stay choices made in the menu.
  actions.push({
    id: "a:menu",
    label: text.items.accountMenu,
    keywords: words.accountMenu,
    action: "menu",
  });

  const themes: Option[] = (["system", "light", "dark"] as const).map((choice) => ({
    id: `t:${choice}`,
    label: text.items.theme(
      t.next.shell.user[
        choice === "system" ? "themeSystem" : choice === "light" ? "themeLight" : "themeDark"
      ],
    ),
    keywords: words.themeChoice[choice],
    action: `theme:${choice}`,
  }));
  const usedLevels = new Set(mirrorings.flatMap((option) => (option.level ? [option.level] : [])));
  const usedProviders = new Set(
    calendars.flatMap((option) => (option.provider ? [option.provider] : [])),
  );

  let index = 0;
  const group = (
    id: string,
    label: string,
    options: Option[],
    extra?: Child,
    keywords?: string,
    kind?: string,
  ) =>
    options.length > 0 || extra ? (
      <div role="group" aria-labelledby={`pg-${id}`} class="pg" data-k={keywords} data-kind={kind}>
        <div id={`pg-${id}`} class="pg-label">
          {label}
        </div>
        {options.map((option) => (
          <OptionItem option={option} index={index++} />
        ))}
        {extra}
      </div>
    ) : null;

  return (
    <dialog id="palette" class="palette" aria-label={text.label} data-needs-script>
      <div class="palette-input">
        <SearchIcon />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-label={text.label}
          autocomplete="off"
          spellcheck={false}
          enterkeyhint="go"
          placeholder={text.placeholder}
        />
      </div>
      <div id="palette-list" class="palette-list" role="listbox" aria-label={text.label}>
        {/* Filled by the script with copies of recent options; shown only for an empty query. */}
        <div role="group" aria-labelledby="pg-recent" class="pg" data-recent hidden>
          <div id="pg-recent" class="pg-label">
            {text.groups.recent}
          </div>
        </div>
        {group("pages", text.groups.pages, pages, null, undefined, text.kinds.page)}
        {group(
          "mirrorings",
          text.groups.mirrorings,
          mirrorings,
          null,
          words.mirror,
          text.kinds.mirroring,
        )}
        {group(
          "calendars",
          text.groups.calendars,
          calendars,
          null,
          words.calendar,
          text.kinds.calendar,
        )}
        {group("actions", text.groups.actions, actions, null, undefined, text.kinds.action)}
        {group(
          "settings",
          text.groups.settings,
          themes,
          LOCALES.filter((code) => code !== locale).map((code) => (
            <LanguageOption code={code} index={index++} keywords={words.language} />
          )),
          words.settings,
        )}
      </div>
      <PaletteMarks levels={usedLevels} providers={usedProviders} />
      <p class="palette-empty" hidden>
        {text.empty}
      </p>
      <p
        class="sr-only"
        data-count
        aria-live="polite"
        data-one={text.resultsOne}
        data-many={text.resultsMany}
      />
      <footer class="palette-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {text.hintNavigate}
        </span>
        <span>
          <kbd>↵</kbd> {text.hintOpen}
        </span>
        <span>
          <kbd>esc</kbd> {text.hintClose}
        </span>
      </footer>
      {/* `palette.js` writes the current page into `back` before the submit. After the
          search field, which `palette.js` finds as the first input. */}
      {reload ? (
        <form id="palette-reload" method="post" action={`${appPath("/calendars")}/refresh`}>
          <input type="hidden" name="back" value={appPath("/calendars")} />
        </form>
      ) : null}
    </dialog>
  );
}

/** The shortcut sheet, opened with `?` or from the palette. */
export function ShortcutSheet(props: { user: CurrentUser }) {
  const { t } = useI18n();
  const text = t.next.palette;
  const keys = text.keys;
  const nav = t.next.shell.nav;
  const save = t.next.shell.common.saveKey;
  const row = (label: string, ...hints: Child[]) => (
    <div class="sheet-row">
      <dt>{label}</dt>
      <dd>{hints}</dd>
    </div>
  );
  const goes = (Object.keys(GO_KEYS) as (keyof typeof GO_KEYS)[]).filter((id) =>
    can(
      props.user,
      id === "mirroring" ? "rules:read" : id === "activity" ? "activity:read" : "accounts:read",
    ),
  );
  return (
    <dialog id="shortcuts" class="palette sheet" aria-labelledby="sheet-title" data-needs-script>
      <div class="sheet-head">
        <h2 id="sheet-title" class="sheet-title" tabindex={-1} autofocus>
          {keys.title}
        </h2>
        <form method="dialog">
          <button type="submit" class="btn btn-ghost">
            {keys.dismiss}
          </button>
        </form>
      </div>
      <dl class="sheet-list">
        {row(keys.palette, <KeyHint mac={text.key.mac} other={text.key.other} />)}
        {goes.map((id) =>
          row(
            keys.goTo(nav[id]),
            <kbd>G</kbd>,
            <span class="sheet-then">{keys.followedBy}</span>,
            <kbd>{GO_KEYS[id]}</kbd>,
          ),
        )}
        {row(keys.nextRow, <kbd>J</kbd>, <kbd>↓</kbd>)}
        {row(keys.prevRow, <kbd>K</kbd>, <kbd>↑</kbd>)}
        {row(keys.open, <kbd>↵</kbd>)}
        {row(keys.close, <kbd>esc</kbd>)}
        {row(keys.save, <KeyHint mac={save.mac} other={save.other} />)}
        {row(keys.sheet, <kbd>?</kbd>)}
      </dl>
      <p class="sheet-hint">{keys.singleKeyHint}</p>
    </dialog>
  );
}

/** The switch in the user menu that turns the single-key shortcuts off (WCAG 2.1.4). */
export function SingleKeySwitch() {
  const { t } = useI18n();
  return (
    <label class="menu-row" data-needs-script>
      <span>{t.next.palette.keys.singleKey}</span>
      <input type="checkbox" class="switch" role="switch" data-single-keys checked />
    </label>
  );
}
