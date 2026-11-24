import { appPath } from "../../app-base";
import type { Child } from "hono/jsx";
import {
  LEVELS,
  MAX_CATEGORY_LENGTH,
  visibilityEffect,
  type Choice,
  type EditorAccount,
  type EditorDirection,
  type EditorState,
  type Level,
  levelOf,
  passCategoriesFor,
  type PassPair,
} from "../../editor";
import { passPairsFromForm } from "../../form";
import { useI18n } from "../../i18n";
import type { MirroringField } from "../../next-mirroring";
import { directionVersion, settingsVersion } from "../../versions";
import { hasWorkingHours } from "../../sync/working-hours";
import { GOOGLE_COLORS } from "../../colors";
import { reconnectUrl } from "./links";
import {
  describedBy,
  EmptyState,
  hintId,
  labelId,
  ListGroup,
  ListRow,
  Note,
  Notice,
  Panel,
  PanelNotices,
  PropertyRow,
  SaveBar,
  Section,
  Segmented,
  Switch,
  Tag,
} from "./components";
import { mirroringActivityHref } from "./activity-link";
import { CalendarSwatch, chipStyle, LevelMark } from "./identity";
import {
  changeEffect,
  directionLevel,
  directionOf,
  marksMixed,
  marksPrivate,
  stillSeen,
} from "./levels";
import { mirroringStats, type MirroringStat } from "./overview";
import {
  mirroringCopies,
  mirroringRun,
  navAttention,
  Run,
  RunText,
  type RunPhrase,
} from "./run-status";
import { HeaderAction, Shell } from "./shell";
import type { PageBase } from "./types";
import { hoursText } from "./work-hours";

export interface MirroringProps extends PageBase {
  /** The direction whose panel is open, from `?d=<from>~<to>`; validated against the state. */
  selected?: { from: string; to: string };
  /** The panel with the settings for all mirrorings is open (`?d=all`). */
  settingsOpen: boolean;
  /** A save just finished (`?saved=1`). */
  saved: boolean;
  /** Why a save was refused. The page shows it at the top of the open panel. */
  error?: string;
  /** The field that caused the refusal: the reason shows there, "Nothing was saved." on top. */
  errorField?: MirroringField;
  /** The refused form, so that the panel keeps what the user entered. */
  draft?: FormData;
  /**
   * A save was refused because the panel was drawn from a state that changed since. The panel
   * shows the stored values, a fresh version, and this text as a warning at its top.
   */
  conflict?: string;
  /**
   * The raw `?d=` of the address. If it names no direction and is not "all", the page says that
   * the mirroring no longer exists.
   */
  requested?: string;
  /** The time the page treats as now. Tests set it; the route leaves it out. */
  now?: number;
}

/** The address of one mirroring's panel. */
export function mirroringHref(from: string, to: string, saved = false): string {
  const base = `${appPath("/mirroring")}?d=${encodeURIComponent(from)}~${encodeURIComponent(to)}`;
  return saved ? `${base}&saved=1` : base;
}

/** The address of the panel with the settings for all mirrorings. */
export function mirroringSettingsHref(saved = false): string {
  return saved ? `${appPath("/mirroring")}?d=all&saved=1` : `${appPath("/mirroring")}?d=all`;
}

const RANK: Record<Choice, number> = { off: 0, busy: 1, title: 2, full: 3 };

const LEVEL_CHOICE: Record<Level, Choice> = {
  off: "off",
  "busy-private": "busy",
  "busy-open": "busy",
  "title-private": "title",
  "title-open": "title",
  "full-private": "full",
  "full-open": "full",
};

/** Addresses at consumer providers get the private sample, all others the work sample. */
const PRIVATE_DOMAINS = /@(gmail|googlemail|outlook|hotmail|live|icloud|me)\./i;

const DAYS_AHEAD = [30, 90, 180, 365] as const;

/**
 * The level that the two questions of the panel name. `copy` must be one of the four answers;
 * anything else, also a full level such as "title-open", is null. Every copied level takes a mark:
 * open only for the exact answer "open", private for anything else, also a missing answer, so
 * that a broken or stale form never makes copies more visible (fail closed).
 */
export function levelFromFields(
  copy: string,
  who: string | undefined,
): { choice: Choice; markPrivate?: boolean } | null {
  if (!(["off", "busy", "title", "full"] as const).some((choice) => choice === copy)) return null;
  const choice = copy as Choice;
  if (choice === "off") return { choice };
  return { choice, markPrivate: who !== "open" };
}

/**
 * The label of the Save button for a level whose save widens what others see: titles or details,
 * or the copy's own title for a mirroring that is turned on at Busy only.
 */
function widenButton(
  text: ReturnType<typeof useI18n>["t"]["next"]["mirroring"],
  level: Level,
  blockTitle: string,
): string | undefined {
  if (level === "title-open" || level === "full-open") return text.bar.button[level];
  return level === "busy-open" ? text.bar.buttonBusy(blockTitle) : undefined;
}

/**
 * What "Same as you" for the existing mirrorings shows, in at most two sentences: the mirrorings
 * that would change, grouped by what they copy, with the names of their target calendars. The
 * same mirrorings as `visibilityEffect` counts: those with an enabled rule that is private.
 */
export function openConsequence(
  state: EditorState,
  text: ReturnType<typeof useI18n>["t"]["next"]["mirroring"]["all"],
): string[] {
  const names = new Map(state.accounts.map((account) => [account.id, account.name]));
  const groups: Record<Exclude<Choice, "off">, string[]> = { busy: [], title: [], full: [] };
  const add = (choice: Choice, target: string) => {
    if (choice !== "off" && !groups[choice].includes(target)) groups[choice].push(target);
  };
  // In the order of the calendars, so that the sentence reads like the lists of the app.
  const order = (direction: EditorDirection) =>
    state.accounts.findIndex((account) => account.id === direction.to);
  for (const direction of state.directions.toSorted((a, b) => order(a) - order(b))) {
    const marks = direction.slots.flatMap((slot) =>
      slot.rule?.enabled ? [slot.rule.options.markPrivate] : [],
    );
    if (marks.some(Boolean)) add(direction.effective, names.get(direction.to) ?? direction.to);
  }
  for (const other of state.others) {
    const rules = state.rules.filter(({ rule }) => rule.id === other.ruleId && rule.enabled);
    if (rules.some(({ rule }) => rule.options.markPrivate)) add(other.choice, other.target);
  }
  const sentences: string[] = [];
  if (groups.busy.length > 0) {
    sentences.push(text.applyOpen.busy(text.list(groups.busy), state.settings.blockTitle));
  }
  const title = groups.title;
  const full = groups.full;
  if (title.length > 0 && full.length > 0 && sentences.length > 0) {
    const both = [...title, ...full.filter((name) => !title.includes(name))];
    sentences.push(text.applyOpen.titleOrFull(text.list(both)));
  } else {
    if (title.length > 0) sentences.push(text.applyOpen.title(text.list(title)));
    if (full.length > 0) sentences.push(text.applyOpen.full(text.list(full)));
  }
  return sentences;
}

// Draft: the refused form, read by the controls --------------------------------------------------

/** Reads a field from the refused form if there is one, else the value from the state. */
class Fields {
  constructor(private readonly draft: FormData | undefined) {}

  get active(): boolean {
    return this.draft !== undefined;
  }

  text(name: string, fallback: string): string {
    const value = this.draft?.get(name);
    return this.draft ? (typeof value === "string" ? value : fallback) : fallback;
  }

  all(name: string, fallback: readonly string[]): string[] {
    if (!this.draft) return [...fallback];
    return this.draft.getAll(name).filter((value): value is string => typeof value === "string");
  }

  /** A checkbox: present in the form means on, as in a browser submit. */
  flag(name: string, fallback: boolean): boolean {
    return this.draft ? this.draft.has(name) : fallback;
  }
}

/**
 * How many changes a refused form of a mirroring holds against the stored values, counted as the
 * save bar counts them (`panel.js`): the two questions are one change, the colours of a filter are
 * one, every other field is one.
 */
export function directionChanges(
  draft: FormData,
  stored: {
    copy: string;
    /** "" for a mirroring with mixed marks, which preselects no answer. */
    who: string;
    workHours: boolean;
    /** The panel shows the working-hours switch only if the target has hours. */
    hoursShown: boolean;
    onlyCategories: readonly string[];
    sourceIsGoogle: boolean;
    targetIsGoogle: boolean;
    blockColor: string;
    passCategories: readonly PassPair[];
  },
): { count: number; fields: string[] } {
  const text = (name: string) => {
    const value = draft.get(name);
    return typeof value === "string" ? value : "";
  };
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));
  const onlyColors = draft
    .getAll("onlyColor")
    .filter((value): value is string => typeof value === "string");
  // One entry per change, with the form fields it is made of; the two questions are one change.
  const changes: string[][] = [
    [
      ...(text("copy") !== stored.copy ? ["copy"] : []),
      ...(text("who") !== stored.who ? ["who"] : []),
    ],
    stored.hoursShown && draft.has("workHours") !== stored.workHours ? ["workHours"] : [],
    stored.sourceIsGoogle
      ? sameSet(onlyColors, stored.onlyCategories)
        ? []
        : ["onlyColor"]
      : text("onlyCategories") !== stored.onlyCategories.join(", ")
        ? ["onlyCategories"]
        : [],
    text("blockColor") !== stored.blockColor ? ["blockColor"] : [],
    ...passChanges(draft, stored),
  ].filter((fields) => fields.length > 0);
  return { count: changes.length, fields: changes.flat() };
}

/**
 * The changes of the carried categories in a refused form, as `panel.js` counts them: the list of
 * one provider is one change; between providers each of the two fields of the rows is one.
 */
function passChanges(
  draft: FormData,
  stored: {
    sourceIsGoogle: boolean;
    targetIsGoogle: boolean;
    passCategories: readonly PassPair[];
  },
): string[][] {
  if (!draft.has("passCategoriesShown")) return [];
  const source = stored.sourceIsGoogle ? "google" : "microsoft";
  const target = stored.targetIsGoogle ? "google" : "microsoft";
  const pairs = passPairsFromForm(draft, source, target);
  const differs = (side: "from" | "to") =>
    pairs.map((pair) => pair[side]).join("\n") !==
    stored.passCategories.map((pair) => pair[side]).join("\n");
  if (source === target && source === "google") {
    // The boxes are one change, in any order, as for the filter.
    const chosen = pairs.map((pair) => pair.from);
    const saved = stored.passCategories.map((pair) => pair.from);
    const same = chosen.length === saved.length && chosen.every((value) => saved.includes(value));
    return same ? [] : [["passColor"]];
  }
  if (source === target) return differs("from") ? [["passCategories"]] : [];
  return [differs("from") ? ["passFrom"] : [], differs("to") ? ["passTo"] : []];
}

// List ---------------------------------------------------------------------------------------------

/** The muted tags of a row: only what differs from the plain copy. */
function RowTags(props: {
  source: EditorAccount;
  target: EditorAccount;
  direction: EditorDirection;
}) {
  const { t } = useI18n();
  const text = t.next.mirroring;
  const { source, target, direction } = props;
  const options = direction.options;
  if (direction.effective === "off" || !options) return null;
  const only = options.onlyCategories.length;
  const color = options.blockColor;
  return (
    <>
      {hasWorkingHours(options) ? <Tag>{text.tags.hours}</Tag> : null}
      {only > 0 ? (
        <Tag>
          {source.provider === "google" ? text.tags.colors(only) : text.tags.categories(only)}
        </Tag>
      ) : null}
      {color ? (
        <Tag>
          {target.provider === "google"
            ? text.tags.color(t.editor.googleColor(color))
            : text.tags.category(color)}
        </Tag>
      ) : null}
    </>
  );
}

function DirectionRow(props: {
  state: EditorState;
  stat: MirroringStat | undefined;
  now: number;
  direction: EditorDirection;
  selected: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = t.next.mirroring;
  const { state, direction } = props;
  const source = state.accounts.find((account) => account.id === direction.from);
  const target = state.accounts.find((account) => account.id === direction.to);
  if (!source || !target) return null;
  const level = directionLevel(state, direction);
  const quiet = level === "off";
  const run = quiet || !props.stat ? null : mirroringRun(props.stat, props.now, i18n);
  const copies = quiet ? null : mirroringCopies(props.stat);
  const copiesText = copies === null ? null : t.next.shell.run.copies(copies);
  const levelText = t.next.shell.levels.summary[level];
  const labelStatus = [copiesText, run?.text].filter(Boolean).join(". ");
  return (
    <ListRow
      id={`row-m-${source.id}~${target.id}`}
      href={mirroringHref(source.id, target.id)}
      selected={props.selected}
      label={text.rowLabel(source.name, target.name, levelText, labelStatus || null)}
      icon={
        <span class={quiet ? "mx-quiet" : undefined}>
          <CalendarSwatch account={source} />
        </span>
      }
      title={<span class={quiet ? "mx-quiet-text" : undefined}>{source.name}</span>}
      meta={
        <span class="level-inline">
          <LevelMark level={level} tint={quiet ? undefined : source.color} />
          {levelText}
        </span>
      }
      tags={<RowTags source={source} target={target} direction={direction} />}
      count={copiesText ?? undefined}
      status={run ? <Run run={run} now={props.now} /> : undefined}
    />
  );
}

/** A button that posts to an endpoint of the old editor and returns to this page. */
function BackForm(props: { action: string; back: string; class?: string; children: Child }) {
  return (
    <form method="post" action={props.action} class={props.class}>
      <input type="hidden" name="back" value={props.back} />
      {props.children}
    </form>
  );
}

function Notices(props: {
  state: EditorState;
  ready: EditorAccount[];
  notice: PageBase["notice"];
}) {
  const { t } = useI18n();
  const text = t.next.mirroring.notices;
  const { state } = props;
  const broken = state.accounts.filter((account) => account.needsReconnect);
  const missing = state.accounts.filter((account) => !account.calendar && !account.needsReconnect);
  const noMirroring =
    props.ready.length >= 2 &&
    state.directions.every((direction) => !direction.ruleId) &&
    !state.accounts.some((account) => account.inGroup);
  return (
    <div class="mx-notices">
      {props.notice ? (
        <Notice kind={props.notice.kind === "error" ? "danger" : "info"}>
          {props.notice.text}
        </Notice>
      ) : null}
      {broken.map((account) => (
        <Notice
          kind="warn"
          title={text.reconnectTitle(account.name)}
          action={
            <a class="btn btn-secondary" href={reconnectUrl(account)}>
              {text.reconnect}
            </a>
          }
        >
          {text.reconnectText}
        </Notice>
      ))}
      {missing.length > 0 ? (
        <Notice
          kind="warn"
          title={text.missingTitle(missing.map((account) => account.name).join(", "))}
          action={
            <BackForm action="/rules/calendars/refresh" back={appPath("/mirroring")}>
              <button type="submit" class="btn btn-secondary">
                {text.checkAgain}
              </button>
            </BackForm>
          }
        >
          {text.missingText}
          {missing.some((account) => account.provider === "google")
            ? ` ${text.missingGoogle}`
            : null}
        </Notice>
      ) : null}
      {noMirroring ? (
        <Notice
          kind="info"
          title={text.startTitle}
          action={
            <BackForm action="/rules/group/all" back={appPath("/mirroring")}>
              <button type="submit" class="btn btn-primary">
                {text.startButton}
              </button>
            </BackForm>
          }
        >
          {text.startText(props.ready.length)}
        </Notice>
      ) : null}
    </div>
  );
}

function MirroringList(
  props: PageBase & {
    ready: EditorAccount[];
    selected?: MirroringProps["selected"];
    stats: Map<string, MirroringStat>;
    now: number;
  },
) {
  const { t } = useI18n();
  const text = t.next.mirroring;
  const { state } = props;
  return (
    <div class="list mx-list">
      {props.ready.map((target) => {
        const directions = state.directions.filter((direction) => direction.to === target.id);
        if (directions.length === 0) return null;
        return (
          <ListGroup
            label={text.appearsIn(target.name)}
            title={
              <span class="mx-group-title">
                {text.appearsInPrefix}
                <span class="mx-target">
                  <CalendarSwatch account={target} />
                  <span class="mx-target-name">{target.name}</span>
                </span>
              </span>
            }
            hint={target.workHours ? text.hoursHint(hoursText(t, target.workHours)) : undefined}
          >
            {directions.map((direction) => (
              <DirectionRow
                state={state}
                stat={props.stats.get(`${direction.from}~${direction.to}`)}
                now={props.now}
                direction={direction}
                selected={
                  props.selected?.from === direction.from && props.selected.to === direction.to
                }
              />
            ))}
          </ListGroup>
        );
      })}
    </div>
  );
}

// Panel parts ---------------------------------------------------------------------------------------

/** A sample event of the source, in the source's colour. Busy blocks carry the hatch of the logo. */
function SampleEvent(props: {
  source: EditorAccount;
  title: string;
  detail?: string;
  hatch?: string;
  /** A small lock before the title: the copy is private (Microsoft marks it so). */
  lock?: boolean;
}) {
  return (
    <span class={props.hatch ? "mx-ev is-busy" : "mx-ev"} style={chipStyle(props.source.color)}>
      {props.hatch ? (
        <svg class="mx-hatch" aria-hidden="true" focusable="false">
          <defs>
            <pattern
              id={props.hatch}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${props.hatch})`} />
        </svg>
      ) : null}
      {props.lock ? (
        <svg
          class="mx-ev-lock"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      ) : null}
      <span class="mx-ev-title">{props.title}</span>
      <span class="mx-ev-time num">10:00–11:00</span>
      {props.detail ? <span class="mx-ev-detail">{props.detail}</span> : null}
    </span>
  );
}

/** What the owner and everyone else sees in the target at one level, as two properties. */
function SeenBy(props: {
  state: EditorState;
  source: EditorAccount;
  target: EditorAccount;
  direction: EditorDirection;
  level: Level;
}) {
  const { t } = useI18n();
  const text = t.next.mirroring.preview;
  const { state, source, target, direction, level } = props;
  const choice = LEVEL_CHOICE[level];
  if (choice === "off") {
    return (
      <PropertyRow label={text.you}>
        <span class="mx-none">{text.notThere(target.name)}</span>
      </PropertyRow>
    );
  }
  const sample = PRIVATE_DOMAINS.test(source.email) ? t.editor.samplePrivate : t.editor.sampleWork;
  // The title the copies carry. A rule without a stored title carries the schema default, so the
  // preview shows that, not the default of the page's language.
  const busyTitle = direction.options?.blockTitle ?? state.settings.blockTitle;
  // From the level, which carries the mirroring's own mark, never from the default.
  const hidden = level.endsWith("-private");
  const google = target.provider === "google";
  const yours = choice === "busy" ? busyTitle : sample.title;
  const detail = choice === "full" ? sample.detail : undefined;
  return (
    <>
      <PropertyRow label={text.you}>
        <SampleEvent
          source={source}
          title={yours}
          detail={detail}
          hatch={choice === "busy" ? `mx-hatch-you-${level}` : undefined}
        />
      </PropertyRow>
      <PropertyRow label={text.others}>
        {hidden ? (
          // Others see a busy time: a private item in Outlook, "Busy" in Google. Both carry the
          // lock, so that the private copy differs from an open one with the same title.
          <SampleEvent
            source={source}
            title={google ? text.privateGoogle : text.privateMicrosoft}
            lock
            hatch={`mx-hatch-others-${level}`}
          />
        ) : (
          // The same entry as yours: the person sees what others will see, not a phrase for it.
          <SampleEvent
            source={source}
            title={yours}
            detail={detail}
            hatch={choice === "busy" ? `mx-hatch-others-${level}` : undefined}
          />
        )}
      </PropertyRow>
    </>
  );
}

/** Who still sees a private copy anyway, folded into one line under the preview. */
function WhoStillSees(props: { source: EditorAccount; target: EditorAccount; blockTitle: string }) {
  const { t } = useI18n();
  return (
    <details class="mx-still prop-indent">
      <summary>{t.next.mirroring.preview.stillSees}</summary>
      <p>
        {props.target.provider === "google"
          ? t.editor.whoStillSeesGoogle
          : t.editor.whoStillSeesMicrosoft}{" "}
        {t.next.mirroring.preview.privateSourceArrives(props.source.name, props.blockTitle)}
      </p>
    </details>
  );
}

/** Google's event colours as checkboxes, for a filter. `id` is the property's group id. */
function ColorChecks(props: {
  name: string;
  chosen: readonly string[];
  id: string;
  hint?: boolean;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  // One tab stop for the group, arrow keys move between the colours (`panel.js`). The colours of
  // one filter count as one change in the save bar.
  return (
    <div
      class="swatches"
      role="group"
      aria-labelledby={labelId(props.id)}
      {...describedBy(props.id, { hint: props.hint, invalid: props.invalid })}
      data-roving
      data-change-group={props.name}
    >
      {GOOGLE_COLORS.map((color) => (
        <label class="swatch" title={t.editor.googleColor(color.id)}>
          <input
            type="checkbox"
            name={props.name}
            value={`color:${color.id}`}
            checked={props.chosen.includes(`color:${color.id}`)}
            aria-label={t.editor.googleColor(color.id)}
          />
          <span class="swatch-dot is-event" style={`--c:${color.hex}`} />
        </label>
      ))}
    </div>
  );
}

/** Google's event colours as radio buttons, for the colour of the copies. */
function ColorRadios(props: {
  name: string;
  value: string;
  id: string;
  none: string;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      class="swatches"
      role="radiogroup"
      aria-labelledby={labelId(props.id)}
      {...describedBy(props.id, { invalid: props.invalid })}
    >
      <label class="swatch" title={props.none}>
        <input
          type="radio"
          name={props.name}
          value=""
          checked={props.value === ""}
          aria-label={props.none}
        />
        <span class="swatch-dot is-none" />
      </label>
      {GOOGLE_COLORS.map((color) => (
        <label class="swatch" title={t.editor.googleColor(color.id)}>
          <input
            type="radio"
            name={props.name}
            value={color.id}
            checked={props.value === color.id}
            aria-label={t.editor.googleColor(color.id)}
          />
          <span class="swatch-dot is-event" style={`--c:${color.hex}`} />
        </label>
      ))}
    </div>
  );
}

/** An arrow from the source value to the target value of a row. Decorative. */
function RowArrow() {
  return (
    <svg
      class="mx-pass-arrow"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/**
 * The categories that the copies carry from their events. Between two calendars of one provider
 * the list holds the source values, as the filter does: names for Outlook, ticked colours for
 * Google. Between providers each row pairs a source value with a target value: a name and a
 * Google colour. The rows send "passFrom" and "passTo" in their order (see `passPairsFromForm`).
 * The server renders the saved rows and one empty row, which works without script; the script
 * adds more rows (`mirroring.js`).
 */
function PassCategories(props: {
  from: EditorAccount;
  to: EditorAccount;
  fields: Fields;
  stored: readonly PassPair[];
  error?: string;
}) {
  const { t } = useI18n();
  const text = t.next.mirroring.pass;
  const { from, to, fields, stored, error } = props;
  const invalid = error !== undefined;
  const sourceIsGoogle = from.provider === "google";
  const shown = <input type="hidden" name="passCategoriesShown" value="1" />;
  if (from.provider === to.provider) {
    const values = stored.map((pair) => pair.from);
    return sourceIsGoogle ? (
      <PropertyRow
        label={text.colors}
        group="mx-pass"
        stacked
        fields={["passColor"]}
        error={error}
        hint={text.colorsHint}
      >
        {shown}
        <ColorChecks
          name="passColor"
          id="mx-pass"
          hint
          invalid={invalid}
          chosen={fields.all("passColor", values)}
        />
      </PropertyRow>
    ) : (
      <PropertyRow
        label={text.categories}
        for="mx-pass"
        fields={["passCategories"]}
        error={error}
        hint={text.categoriesHint}
      >
        {shown}
        <input
          class="input"
          id="mx-pass"
          type="text"
          name="passCategories"
          autocomplete="off"
          placeholder={text.placeholder}
          {...describedBy("mx-pass", { hint: true, invalid })}
          value={fields.text("passCategories", values.join(", "))}
        />
      </PropertyRow>
    );
  }
  // A refused form keeps its rows; an empty row follows the last one with a name.
  const froms = fields.all("passFrom", [...stored.map((pair) => pair.from), ""]);
  const tos = fields.all("passTo", [...stored.map((pair) => pair.to), ""]);
  const rows = Array.from({ length: Math.max(froms.length, tos.length) }, (_, index) => ({
    from: froms[index] ?? "",
    to: tos[index] ?? "",
  }));
  const last = rows.at(-1);
  if (!last || (sourceIsGoogle ? last.to : last.from).trim() !== "")
    rows.push({ from: "", to: "" });
  // After a refusal, the rows that do not fit on their own are marked; a list that is only too long
  // marks none, and the reason stands under the rows. A row without a name is blank, as on save.
  const rowInvalid = (row: PassPair) =>
    invalid &&
    (sourceIsGoogle ? row.to : row.from).trim() !== "" &&
    "problem" in passCategoriesFor(from.provider, to.provider, [row]);
  const name = (
    field: "passFrom" | "passTo",
    value: string,
    calendar: EditorAccount,
    marked: boolean,
  ) => (
    <input
      class="input"
      type="text"
      name={field}
      autocomplete="off"
      maxlength={MAX_CATEGORY_LENGTH}
      placeholder={text.placeholder}
      aria-label={text.category(calendar.name)}
      aria-invalid={marked ? "true" : undefined}
      value={value}
    />
  );
  const color = (
    field: "passFrom" | "passTo",
    value: string,
    prefix: string,
    calendar: EditorAccount,
    marked: boolean,
  ) => (
    <span class="select">
      <select
        name={field}
        aria-label={text.color(calendar.name)}
        aria-invalid={marked ? "true" : undefined}
      >
        <option value="" selected={value === ""}>
          {text.chooseColor}
        </option>
        {GOOGLE_COLORS.map((option) => (
          <option value={`${prefix}${option.id}`} selected={value === `${prefix}${option.id}`}>
            {t.editor.googleColor(option.id)}
          </option>
        ))}
      </select>
    </span>
  );
  return (
    <PropertyRow
      label={sourceIsGoogle ? text.colors : text.categories}
      group="mx-pass"
      stacked
      fields={["passFrom", "passTo"]}
      error={error}
      hint={sourceIsGoogle ? text.rowsHintColors : text.rowsHint}
    >
      {shown}
      <div
        class="mx-pass-rows"
        role="group"
        aria-labelledby={labelId("mx-pass")}
        {...describedBy("mx-pass", { hint: true, invalid })}
      >
        {rows.map((row) => {
          const marked = rowInvalid(row);
          return (
            <div class="mx-pass-row">
              {sourceIsGoogle
                ? color("passFrom", row.from, "color:", from, marked)
                : name("passFrom", row.from, from, marked)}
              <RowArrow />
              {sourceIsGoogle
                ? name("passTo", row.to, to, marked)
                : color("passTo", row.to, "", to, marked)}
            </div>
          );
        })}
      </div>
      <button type="button" class="btn btn-secondary" data-needs-script data-pass-add>
        {text.addRow}
      </button>
    </PropertyRow>
  );
}

/**
 * The level mark in the panel title. One mark per level, and CSS shows the one that the two
 * questions name, so the title follows the form also without script.
 */
function TitleMarks(props: { tint: EditorAccount["color"] }) {
  return (
    <span class="mx-title-marks" aria-hidden="true">
      {LEVELS.map((level) => (
        <span class="mx-title-mark" data-level={level}>
          <LevelMark level={level} tint={level === "off" ? undefined : props.tint} />
        </span>
      ))}
    </span>
  );
}

/** The state line of a mirroring's panel: the run, the copies, a link to its activity. */
function DirectionMeta(props: {
  run: RunPhrase | null;
  copies: number | null;
  activity: string;
  /** The mirroring is "Not copied": the line says so, where a run would stand. */
  off: boolean;
}) {
  const { t, formatTimestamp } = useI18n();
  const run = t.next.shell.run;
  return (
    <>
      {props.off ? (
        <>
          <span>{t.next.mirroring.copyOptions.off}</span>
          <span class="detail-meta-sep" aria-hidden="true" />
        </>
      ) : null}
      {props.run ? <RunText run={props.run} title={formatTimestamp} /> : null}
      {props.copies !== null ? (
        <>
          <span class="detail-meta-sep" aria-hidden="true" />
          <span class="num">{run.copies(props.copies)}</span>
        </>
      ) : null}
      {props.run || props.copies !== null ? (
        <span class="detail-meta-sep" aria-hidden="true" />
      ) : null}
      <a class="link" href={props.activity}>
        {run.viewActivity}
      </a>
    </>
  );
}

// Panel for one mirroring ---------------------------------------------------------------------------

function DirectionPanel(
  props: MirroringProps & {
    from: EditorAccount;
    to: EditorAccount;
    direction: EditorDirection;
    stat: MirroringStat | undefined;
    now: number;
  },
) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = t.next.mirroring;
  const { state, from, to, direction } = props;
  const fields = new Fields(props.draft);
  const level = directionLevel(state, direction);
  const currentChoice = LEVEL_CHOICE[level];
  const canEdit = to.calendar?.canEdit === true;
  const options = direction.options;

  // The two questions. A refused form keeps its answers. "What others see" shows the mirroring's
  // own mark; for a mirroring that is off, the user's default, which turning it on would give it.
  // The answer then carries the mark "Default", so that the person sees where it comes from.
  // Calendars of the source with both marks: no answer is preselected, and one is required, since
  // it applies to all of them. A preselected "Same as you" would open the private ones on Save.
  const mixed = marksMixed(direction);
  const copy = fields.text("copy", currentChoice);
  const defaultWho = marksPrivate(state, direction) ? "private" : "open";
  const who = fields.text("who", mixed ? "" : defaultWho);
  // The version the panel was drawn from. A refused form keeps the one it was drawn with, so that
  // a change made meanwhile still refuses its next save.
  const version = fields.text("v", directionVersion(state, direction));
  const blockTitle = options?.blockTitle ?? state.settings.blockTitle;
  const others =
    to.provider === "google" ? text.whoHint.othersGoogle : text.whoHint.othersMicrosoft;
  const whoLabel = (value: "private" | "open") =>
    level === "off" && value === defaultWho ? (
      <>
        {text.whoOptions[value]}{" "}
        <span class="mx-default" title={text.whoDefaultNote}>
          {text.whoDefaultMark}
        </span>
      </>
    ) : (
      text.whoOptions[value]
    );
  const hint = (() => {
    if (!canEdit) return text.copyHint.readOnly(to.name);
    if (direction.maxChoice !== "full") {
      return text.copyHint.cap(text.copyOptions[direction.maxChoice]);
    }
    return undefined;
  })();

  // Working hours.
  const hoursOn = options !== null && hasWorkingHours(options);
  const hours = to.workHours ?? (hoursOn && options ? options : null);
  // The target's panel, at its working hours; `from` names this mirroring, so that the calendar
  // panel can offer the way back.
  const calendarHref =
    `${appPath("/calendars")}?c=${encodeURIComponent(to.id)}` +
    `&from=${encodeURIComponent(from.id)}~${encodeURIComponent(to.id)}#cal-hours-on`;

  // Filters and look of the copies.
  const onlyNames = options?.onlyCategories ?? [];
  const sourceIsGoogle = from.provider === "google";
  const targetIsGoogle = to.provider === "google";
  const blockColor = fields.text("blockColor", options?.blockColor ?? "");

  const off = level === "off";
  const run = off || !props.stat ? null : mirroringRun(props.stat, props.now, i18n);
  const copies = off ? null : mirroringCopies(props.stat);

  const back = mirroringHref(from.id, to.id, true);
  // One note per level that the save bar has something to say about; the script shows the note of
  // the level that is chosen (`data-sentence`). A level that shows more than the current one names
  // who will see what; one that widens what others see is a warning with its own button label. A
  // lower level that stays visible to others says what they still see. "Not copied" says that the
  // copies go.
  /** The sentence of a note. Busy for everyone from a copied level shows the copy's own title. */
  const sentence = (noteLevel: Exclude<Level, "off">) =>
    noteLevel === "busy-open"
      ? level === "off"
        ? text.bar.sentence["busy-open"](from.name, to.name, blockTitle)
        : text.bar.busyTitleShown(to.name, blockTitle)
      : text.bar.sentence[noteLevel](from.name, to.name);
  // A mixed direction counts from its private calendars: any open answer then opens one of them,
  // so it warns and names the Save button. The private answer opens nothing; for the open
  // calendars it says what others see again.
  const baseline = mixed ? levelOf(currentChoice, true) : level;
  const notes = LEVELS.flatMap(
    (noteLevel): { level: Level; effect: string; text: string; button?: string }[] => {
      if (noteLevel === "off") {
        return level === "off" || copies === 0
          ? []
          : [
              {
                level: noteLevel,
                effect: "none",
                text: text.bar.copiesRemoved(copies, to.name),
                button: text.bar.turnOff,
              },
            ];
      }
      const still = stillSeen(mixed ? levelOf(currentChoice, false) : level, noteLevel);
      const again =
        still === "private"
          ? text.bar.privateAgain[to.provider === "google" ? "google" : "microsoft"]
          : null;
      if (noteLevel === baseline) {
        return mixed && again ? [{ level: noteLevel, effect: "none", text: again }] : [];
      }
      const effect = changeEffect(baseline, noteLevel);
      if (effect !== "none") {
        const button = effect === "widens" ? widenButton(text, noteLevel, blockTitle) : undefined;
        return [{ level: noteLevel, effect, text: sentence(noteLevel), button }];
      }
      if (!still) return [];
      const words =
        still === "busy"
          ? text.bar.stillSeesBusy(blockTitle)
          : still === "titles"
            ? text.bar.stillSeesTitles
            : (again ?? "");
      return [{ level: noteLevel, effect: "none", text: words }];
    },
  );
  // A refusal at a field: the reason shows there, the top says only that nothing was saved.
  const errorAt = (field: MirroringField) => (props.errorField === field ? props.error : undefined);
  const refused = props.draft
    ? directionChanges(props.draft, {
        copy: currentChoice,
        who: mixed ? "" : defaultWho,
        workHours: options !== null && hasWorkingHours(options),
        hoursShown: hours !== null,
        onlyCategories: onlyNames,
        sourceIsGoogle,
        targetIsGoogle,
        blockColor: options?.blockColor ?? "",
        passCategories: options?.passCategories ?? [],
      })
    : undefined;

  return (
    <Panel
      title={
        <span class="mx-title">
          <TitleMarks tint={from.color} />
          <span class="mx-title-text">{text.fromTo(from.name, to.name)}</span>
        </span>
      }
      meta={
        <DirectionMeta
          run={run}
          copies={copies}
          activity={mirroringActivityHref(from.id, to.id)}
          off={off}
        />
      }
      saved={props.saved}
      closeHref={appPath("/mirroring")}
      form={{ action: appPath("/mirroring") }}
      footer={
        <SaveBar
          forced={props.error !== undefined}
          refusedCount={refused?.count}
          refusedFields={refused?.fields}
          labels={notes.flatMap((note) =>
            note.effect === "widens" && note.button ? [{ for: note.level, text: note.button }] : [],
          )}
          notes={
            <>
              {notes.map((note) => (
                <Note
                  data-sentence={note.level}
                  warn={note.effect === "widens"}
                  button={note.button}
                  danger={note.level === "off"}
                >
                  {note.text}
                </Note>
              ))}
              {/* Shown by the script when only "what others see" changed. */}
              <Note data-who-note="">{text.bar.whoChanges}</Note>
            </>
          }
        />
      }
    >
      <input type="hidden" name="scope" value="direction" />
      <input type="hidden" name="from" value={from.id} />
      <input type="hidden" name="to" value={to.id} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="v" value={version} />
      <div hidden data-mx data-level={level} />
      <PanelNotices conflict={props.conflict} error={props.error} field={props.errorField} />

      <Section>
        <PropertyRow
          label={text.whatIsCopied}
          group="mx-copy"
          stacked
          fields={["copy"]}
          hint={
            <>
              {(["off", "busy", "title", "full"] as const).map((choice) => (
                <span class="mx-copy-hint" data-copy={choice}>
                  {choice === "off"
                    ? text.copyHints.off(from.name, to.name)
                    : text.copyHints[choice]}
                </span>
              ))}
              {hint ? <span class="mx-copy-limit"> {hint}</span> : null}
            </>
          }
        >
          <Segmented
            name="copy"
            labelledBy={labelId("mx-copy")}
            describedBy={hintId("mx-copy")}
            group="level"
            block
            tiles
            value={copy}
            options={(["off", "busy", "title", "full"] as const).map((choice) => ({
              value: choice,
              label: text.copyOptions[choice],
              icon: <LevelMark level={choice === "off" ? "off" : `${choice}-open`} />,
              disabled:
                RANK[choice] > RANK[direction.maxChoice] ||
                (!canEdit && choice !== "off" && choice !== currentChoice),
            }))}
          />
        </PropertyRow>
        {/* `data-mixed`: the script asks the browser for an answer while a copied level is chosen
            (`mirroring.js`); "Not copied" needs none, also without script. */}
        <div class="mx-who" data-provider={to.provider} data-mixed={mixed ? "" : undefined}>
          <PropertyRow
            label={text.whoSees}
            group="mx-who"
            stacked
            fields={["who"]}
            error={errorAt("who")}
            hint={
              <>
                <span class="mx-who-hint" data-who="private">
                  {to.provider === "google"
                    ? text.whoHint.privateGoogle(to.name)
                    : text.whoHint.privateMicrosoft(to.name)}
                </span>
                <span class="mx-who-hint" data-who="open" data-copy="busy">
                  {`${text.whoHint.openBusy(to.name, blockTitle)} ${others}`}
                </span>
                <span class="mx-who-hint" data-who="open" data-copy="title">
                  {`${text.whoHint.openTitle(to.name)} ${others}`}
                </span>
                <span class="mx-who-hint" data-who="open" data-copy="full">
                  {`${text.whoHint.openFull(to.name)} ${others}`}
                </span>
                {level === "off" ? <span class="mx-who-default">{text.whoDefaultNote}</span> : null}
                {mixed ? (
                  <span class="mx-mixed">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5l9.5 16.5h-19z" />
                      <path d="M12 9.5v4.5M12 17.2h.01" />
                    </svg>
                    <span>{text.mixedMarks(from.name)}</span>
                  </span>
                ) : null}
              </>
            }
          >
            <Segmented
              name="who"
              labelledBy={labelId("mx-who")}
              describedBy={errorAt("who") ? `${hintId("mx-who")} mx-who-error` : hintId("mx-who")}
              invalid={errorAt("who") !== undefined}
              group="level"
              block
              value={who}
              options={[
                { value: "private", label: whoLabel("private") },
                { value: "open", label: whoLabel("open") },
              ]}
            />
          </PropertyRow>
        </div>
      </Section>

      <Section title={text.preview.title}>
        <div class="mx-preview">
          {LEVELS.map((option) => (
            <div class="mx-pv props" data-pv={option}>
              <SeenBy
                state={state}
                source={from}
                target={to}
                direction={direction}
                level={option}
              />
            </div>
          ))}
          {mixed ? <p class="mx-none mx-pv-answer">{text.preview.answerFirst}</p> : null}
          <WhoStillSees source={from} target={to} blockTitle={blockTitle} />
        </div>
      </Section>

      <div class="mx-when-copied">
        <Section title={text.limits}>
          <PropertyRow
            label={text.hours.short}
            for={hours ? "mx-hours" : undefined}
            fields={["workHours"]}
            hint={
              hours ? (
                <>
                  <span class="mx-hours-off">{text.hours.hintOff}</span>
                  <span class="mx-hours-on">
                    {text.hours.hint(to.name, hoursText(t, hours))}{" "}
                    <a class="link" href={calendarHref}>
                      {text.hours.change}
                    </a>
                  </span>
                </>
              ) : (
                <a class="link" href={calendarHref}>
                  {text.hours.set}
                </a>
              )
            }
          >
            {hours ? (
              <>
                <input type="hidden" name="workHoursShown" value="1" />
                <Switch
                  id="mx-hours"
                  name="workHours"
                  label={text.hours.label(to.name)}
                  describedBy={hintId("mx-hours")}
                  checked={fields.flag("workHours", hoursOn)}
                />
              </>
            ) : (
              <span class="mx-none">{text.hours.missing(to.name)}</span>
            )}
          </PropertyRow>
          <PropertyRow
            label={sourceIsGoogle ? text.only.colors : text.only.categories}
            for={sourceIsGoogle ? undefined : "mx-only"}
            group={sourceIsGoogle ? "mx-only" : undefined}
            stacked={sourceIsGoogle}
            fields={[sourceIsGoogle ? "onlyColor" : "onlyCategories"]}
            error={errorAt("onlyCategories")}
            hint={
              sourceIsGoogle ? text.only.colorsHint(from.name) : text.only.categoriesHint(from.name)
            }
          >
            <input type="hidden" name="onlyCategoriesShown" value="1" />
            {sourceIsGoogle ? (
              <ColorChecks
                name="onlyColor"
                id="mx-only"
                hint
                invalid={errorAt("onlyCategories") !== undefined}
                chosen={fields.all("onlyColor", onlyNames)}
              />
            ) : (
              <input
                class="input"
                id="mx-only"
                type="text"
                name="onlyCategories"
                autocomplete="off"
                maxlength={2000}
                placeholder={text.only.placeholder}
                {...describedBy("mx-only", {
                  hint: true,
                  invalid: errorAt("onlyCategories") !== undefined,
                })}
                value={fields.text("onlyCategories", onlyNames.join(", "))}
              />
            )}
          </PropertyRow>
        </Section>

        <Section title={text.copies.title}>
          <PropertyRow
            label={targetIsGoogle ? text.copies.colorShort : text.copies.categoryShort}
            for={targetIsGoogle ? undefined : "mx-color"}
            group={targetIsGoogle ? "mx-color" : undefined}
            stacked={targetIsGoogle}
            fields={["blockColor"]}
            error={errorAt("blockColor")}
            hint={targetIsGoogle ? undefined : t.editor.blockCategoryHint}
          >
            {targetIsGoogle ? (
              <ColorRadios
                name="blockColor"
                id="mx-color"
                value={blockColor}
                none={text.copies.none}
                invalid={errorAt("blockColor") !== undefined}
              />
            ) : (
              <input
                class="input"
                id="mx-color"
                type="text"
                name="blockColor"
                autocomplete="off"
                maxlength={MAX_CATEGORY_LENGTH}
                placeholder={text.copies.categoryPlaceholder}
                aria-label={text.copies.category}
                {...describedBy("mx-color", {
                  hint: true,
                  invalid: errorAt("blockColor") !== undefined,
                })}
                value={blockColor}
              />
            )}
          </PropertyRow>
          <PassCategories
            from={from}
            to={to}
            fields={fields}
            stored={options?.passCategories ?? []}
            error={errorAt("passCategories")}
          />
        </Section>
      </div>
    </Panel>
  );
}

// Panel for all mirrorings --------------------------------------------------------------------------

function SettingsPanel(props: MirroringProps) {
  const { t } = useI18n();
  const text = t.next.mirroring.all;
  const { settings } = props.state;
  const fields = new Fields(props.draft);
  const plain = settings.skipCategories.filter((name) => !name.startsWith("color:")).join(", ");
  const colors = settings.skipCategories.filter((name) => name.startsWith("color:"));
  // How many mirrorings the bulk checkbox would change for each answer, so that the page can state
  // it before the save, also without script (CSS shows the count of the checked answer).
  const narrowed = visibilityEffect(props.state, "private").narrowed;
  const widened = visibilityEffect(props.state, "open").widened;
  const consequence = widened > 0 ? openConsequence(props.state, text) : [];
  const newWho = fields.text("newWho", settings.markPrivate ? "private" : "open");
  const version = fields.text("v", settingsVersion(props.state));
  return (
    <Panel
      title={text.title}
      saved={props.saved}
      closeHref={appPath("/mirroring")}
      form={{ action: appPath("/mirroring") }}
      footer={
        <SaveBar
          forced={props.error !== undefined}
          notes={
            widened > 0 ? (
              // The consequence is stated once, next to the checkbox, where it also shows without
              // script. While "everyone" and the checkbox are chosen, this note only gives the
              // Save button its label; it has no words of its own.
              <Note data-apply-note="" warn button={text.applyOpenButton(widened)}>
                {""}
              </Note>
            ) : undefined
          }
        />
      }
    >
      <input type="hidden" name="scope" value="all" />
      <input type="hidden" name="back" value={mirroringSettingsHref(true)} />
      <input type="hidden" name="v" value={version} />
      {/* A save keeps each rule's window and all-day value unless the form changed it. Who sees
          the copies changes existing mirrorings only with the bulk checkbox (`applyWho`). */}
      <input type="hidden" name="daysAheadShown" value={String(settings.daysAhead)} />
      <input type="hidden" name="skipAllDayShown" value={settings.skipAllDay ? "1" : "0"} />
      <PanelNotices conflict={props.conflict} error={props.error} />
      <Section>
        <PropertyRow
          label={text.window}
          group="mx-window"
          stacked
          fields={["daysAhead"]}
          hint={text.windowHint}
        >
          <Segmented
            name="daysAhead"
            labelledBy={labelId("mx-window")}
            describedBy={hintId("mx-window")}
            block
            value={fields.text("daysAhead", String(settings.daysAhead))}
            options={DAYS_AHEAD.map((days) => ({
              value: String(days),
              label: text.days(days),
            }))}
          />
        </PropertyRow>
        <PropertyRow
          label={text.blockTitle}
          for="mx-title"
          fields={["blockTitle"]}
          hint={text.blockTitleHint}
        >
          <input
            class="input"
            id="mx-title"
            type="text"
            name="blockTitle"
            maxlength={255}
            autocomplete="off"
            placeholder={text.blockTitlePlaceholder(t.editor.defaultBlockTitle)}
            aria-describedby={hintId("mx-title")}
            value={fields.text("blockTitle", settings.blockTitle)}
          />
        </PropertyRow>
        <PropertyRow
          label={text.whoDefault}
          group="mx-newwho"
          stacked
          fields={["newWho", "applyWho"]}
          hint={text.whoDefaultHint}
        >
          <Segmented
            name="newWho"
            labelledBy={labelId("mx-newwho")}
            describedBy={hintId("mx-newwho")}
            group="who"
            block
            value={newWho}
            options={[
              { value: "private", label: t.next.mirroring.whoOptions.private },
              { value: "open", label: t.next.mirroring.whoOptions.open },
            ]}
          />
        </PropertyRow>
        {narrowed > 0 || widened > 0 ? (
          <div class="mx-apply">
            <label class="mx-apply-check">
              <input
                type="checkbox"
                name="applyWho"
                value="1"
                aria-describedby="mx-apply-hints"
                checked={fields.flag("applyWho", false)}
              />
              <span data-apply="private" data-count={String(narrowed)}>
                {text.applyWho(narrowed)}
              </span>
              <span data-apply="open" data-count={String(widened)}>
                {text.applyWho(widened)}
              </span>
            </label>
            {/* One description for the checkbox: CSS shows the hint of the chosen answer, and
                the hidden one is not read. */}
            <div class="mx-apply-hints" id="mx-apply-hints">
              <p class="mx-apply-hint" data-who="private">
                {text.applyPrivate(narrowed)}
              </p>
              <p class="mx-apply-hint is-warn" data-who="open">
                <svg
                  class="mx-apply-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3.5l9.5 16.5h-19z" />
                  <path d="M12 9.5v4.5M12 17.2h.01" />
                </svg>
                <span>{consequence.join(" ")}</span>
              </p>
            </div>
          </div>
        ) : null}
      </Section>
      <Section title={text.skipTitle}>
        <PropertyRow
          label={text.skipCategoriesLabel}
          for="mx-skip"
          fields={["skipCategories"]}
          hint={text.skipCategoriesHint}
        >
          <input
            class="input"
            id="mx-skip"
            type="text"
            name="skipCategories"
            autocomplete="off"
            placeholder={text.skipCategoriesPlaceholder}
            aria-label={text.skipCategories}
            aria-describedby={hintId("mx-skip")}
            value={fields.text("skipCategories", plain)}
          />
        </PropertyRow>
        <PropertyRow
          label={text.skipColorsLabel}
          group="mx-skipcolor"
          stacked
          fields={["skipColor"]}
        >
          <ColorChecks
            name="skipColor"
            id="mx-skipcolor"
            chosen={fields.all("skipColor", colors)}
          />
        </PropertyRow>
        <PropertyRow
          label={text.skipAllDayLabel}
          for="mx-allday"
          fields={["skipAllDay"]}
          hint={text.skipAllDayHint}
        >
          <Switch
            id="mx-allday"
            name="skipAllDay"
            label={text.skipAllDay}
            describedBy={hintId("mx-allday")}
            checked={fields.flag("skipAllDay", settings.skipAllDay)}
          />
        </PropertyRow>
        <PropertyRow
          label={text.skipTentativeLabel}
          for="mx-tentative"
          fields={["skipTentative"]}
          hint={text.skipTentativeHint}
        >
          <Switch
            id="mx-tentative"
            name="skipTentative"
            label={text.skipTentative}
            describedBy={hintId("mx-tentative")}
            checked={fields.flag("skipTentative", settings.skipTentative)}
          />
        </PropertyRow>
      </Section>
    </Panel>
  );
}

// Page ----------------------------------------------------------------------------------------------

/** Mirroring: directions grouped by target, a detail panel on the right. */
export function MirroringPage(props: MirroringProps) {
  const { t } = useI18n();
  const text = t.next.mirroring;
  const { state, selected } = props;
  const now = props.now ?? Date.now();
  const stats = mirroringStats(state, props.outcomes, now);
  const ready = state.accounts.filter((account) => account.calendar);
  const from = selected
    ? state.accounts.find((account) => account.id === selected.from)
    : undefined;
  const to = selected ? state.accounts.find((account) => account.id === selected.to) : undefined;
  const direction = selected ? directionOf(state, selected.from, selected.to) : undefined;
  const panel =
    from && to && direction ? (
      <DirectionPanel
        {...props}
        from={from}
        to={to}
        direction={direction}
        stat={stats.get(`${from.id}~${to.id}`)}
        now={now}
      />
    ) : props.settingsOpen ? (
      <SettingsPanel {...props} />
    ) : undefined;
  // A refused save whose panel is gone (the direction changed meanwhile) still tells why.
  const orphanError = props.error && !panel ? props.error : undefined;
  // An address of a mirroring that no longer exists, for example from a bookmark or another tab.
  const gone = Boolean(props.requested) && props.requested !== "all" && !panel && !orphanError;
  return (
    <Shell
      title={text.title}
      user={props.user}
      active="mirroring"
      palette={{ state, providers: props.providers }}
      attention={navAttention(state, props.outcomes, now, stats)}
      actions={
        <HeaderAction
          href={mirroringSettingsHref()}
          closeHref={appPath("/mirroring")}
          open={props.settingsOpen}
        >
          {text.settings}
        </HeaderAction>
      }
      panel={panel}
      styles={["/next/mirroring.css"]}
    >
      {orphanError || gone ? (
        <div class="mx-notices">
          {orphanError ? (
            <Notice kind="danger">{orphanError}</Notice>
          ) : (
            <Notice kind="warn">{text.notices.gone}</Notice>
          )}
        </div>
      ) : null}
      <Notices state={state} ready={ready} notice={props.notice} />
      {ready.length < 2 ? (
        <EmptyState
          title={ready.length === 0 ? text.empty.noneTitle : text.empty.oneTitle}
          text={text.empty.text}
        >
          <a class="btn btn-primary" href={appPath("/calendars")}>
            {text.empty.action}
          </a>
        </EmptyState>
      ) : (
        <MirroringList {...props} ready={ready} stats={stats} now={now} />
      )}
    </Shell>
  );
}
