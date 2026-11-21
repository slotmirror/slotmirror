import { appPath } from "../../app-base";
import type { AccountSyncStatus } from "../../audit";
import { ACCOUNT_COLOR_KEYS, ACCOUNT_COLORS } from "../../colors";
import { MAX_BUFFER_MINUTES, PROVIDER_LABEL, type Provider } from "../../config";
import { MAX_NAME_LENGTH, sourceBuffer, type EditorAccount, type EditorState } from "../../editor";
import { useI18n } from "../../i18n";
import {
  bufferAffected,
  hoursAffected,
  type CalendarDraft,
  type CalendarField,
} from "../../next-calendars";
import { ALL_WEEKDAYS, isTimeZone } from "../../sync/working-hours";
import { reconnectUrl } from "./links";
import type { AccountRow } from "../../calendars";
import { CONSUMER_TENANT_ID } from "../../users";
import { accountVersion } from "../../versions";
import {
  describedBy,
  hintId,
  labelId,
  ListGroup,
  ListRow,
  Note,
  Notice,
  Panel,
  PanelNotices,
  EmptyState,
  PropertyRow,
  SaveBar,
  Section,
  Segmented,
  Switch,
  Tag,
} from "./components";
import { ConfirmStep } from "./admin-parts";
import { CalendarSwatch, ProviderGlyph } from "./identity";
import { directionLevel } from "./levels";
import { mirroringHref } from "./mirroring";
import { mirroringStats, type MirroringStat } from "./overview";
import {
  calendarRun,
  mirroringRun,
  navAttention,
  Run,
  RunText,
  type RunPhrase,
} from "./run-status";
import { Shell } from "./shell";
import type { PageBase } from "./types";
import { hoursText } from "./work-hours";

export interface CalendarsProps extends PageBase {
  /**
   * Not read any more: `state.accounts` carries the connect time and the tenant. Optional until
   * the route stops passing it.
   */
  accounts?: AccountRow[];
  /** Sync status per account ID; an account without an entry was never synced. */
  statuses: Map<string, AccountSyncStatus>;
  /** The calendar whose panel is open, from `?c=<id>`; validated against the state. */
  selected?: string;
  /** The panel shows the step before it disconnects the calendar (`?confirm=disconnect`). */
  confirm?: "disconnect";
  /** A save just finished (`?saved=1`). */
  saved: boolean;
  /** What the user typed into the open panel, after a refused save. */
  draft?: CalendarDraft;
  /** Why the save was refused, shown at the top of the open panel. */
  error?: string;
  /** The field that caused the refusal: the reason shows there, "Nothing was saved." on top. */
  errorField?: CalendarField;
  /**
   * A save was refused because the panel was drawn from a state that changed since. The panel
   * shows the stored values, a fresh version, and this text as a warning at its top.
   */
  conflict?: string;
  /** The raw `?c=` of the address. If it names no calendar, the page says it is gone. */
  requested?: string;
  /** The raw ?from= ("<from>~<to>"): the mirroring that opened the panel. */
  from?: string;
  /** The time the page treats as now. Tests set it; the route leaves it out. */
  now?: number;
}

/** The address of one calendar's panel. */
export function calendarHref(id: string): string {
  return `${appPath("/calendars")}?c=${encodeURIComponent(id)}`;
}

/** The step before a disconnect, in the calendar's own panel. Nothing is removed by opening it. */
export function disconnectHref(id: string): string {
  return `${calendarHref(id)}&confirm=disconnect`;
}

/** Which status of two weighs more: a problem before a delay, a delay before a fine run. */
const TONE_RANK = { danger: 3, warn: 2, ok: 1, idle: 0 } as const;

/**
 * The status of a calendar, in the row and the panel head. A lost connection comes first. Then
 * the worst state of the running mirrorings into the calendar, the copies that appear in it, with
 * the words of the Mirroring page (`mirroringRun`): a calendar never shows green while a mirroring
 * into it shows a delay or a failure. Mirrorings out of it do not count, so that one stale target
 * does not colour every calendar that copies into it. Of several fine ones it shows the oldest
 * last run. A calendar without a running mirroring into it shows the latest runs into it
 * (`calendarRun`).
 */
export function calendarStatus(
  state: EditorState,
  account: EditorAccount,
  sync: AccountSyncStatus | undefined,
  stats: Map<string, MirroringStat>,
  now: number,
  i18n: ReturnType<typeof useI18n>,
): RunPhrase {
  if (account.needsReconnect) return calendarRun(sync, true, now, i18n);
  const runs = state.directions
    .filter((d) => d.to === account.id && directionLevel(state, d) !== "off")
    .flatMap((d) => {
      const stat = stats.get(`${d.from}~${d.to}`);
      return stat ? [mirroringRun(stat, now, i18n)] : [];
    });
  const [first, ...rest] = runs;
  if (!first) return calendarRun(sync, false, now, i18n);
  return rest.reduce((worst, run) => {
    if (TONE_RANK[run.tone] !== TONE_RANK[worst.tone]) {
      return TONE_RANK[run.tone] > TONE_RANK[worst.tone] ? run : worst;
    }
    return run.tone === "ok" && (run.at ?? "") < (worst.at ?? "") ? run : worst;
  }, first);
}

/** What the fields show before a calendar has working hours. They count only once switched on. */
const DEFAULT_HOURS = { workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00" };

function enabledProviders(providers: Record<Provider, boolean>): Provider[] {
  return (Object.keys(PROVIDER_LABEL) as Provider[]).filter((provider) => providers[provider]);
}

function Plus() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** The connect choices as menu items. The Google hint sits right under the Google choice. */
function ConnectChoices(props: { providers: Record<Provider, boolean> }) {
  const { t } = useI18n();
  return (
    <>
      {enabledProviders(props.providers).map((provider) => (
        <>
          <a class="menu-item connect-item" href={`/auth/${provider}/connect`}>
            <ProviderGlyph provider={provider} />
            <span>{t.next.shell.providers[provider]}</span>
          </a>
          {provider === "google" ? <p class="menu-note">{t.next.calendars.googleHint}</p> : null}
        </>
      ))}
    </>
  );
}

/**
 * Calendars: connected accounts as a list, a detail panel on the right. The whole row opens the
 * panel through a stretched link, so that a row can also hold its own action.
 */
export function CalendarsPage(props: CalendarsProps) {
  const i18n = useI18n();
  const { t, formatTimestamp } = i18n;
  const now = props.now ?? Date.now();
  const text = t.next.calendars;
  const connectable = enabledProviders(props.providers).length > 0;

  function kind(account: EditorAccount): string {
    if (account.provider === "google") return t.accounts.kindGoogle;
    return account.tenantId === CONSUMER_TENANT_ID
      ? t.accounts.kindMicrosoftPersonal
      : t.accounts.kindMicrosoftWork;
  }

  const stats = mirroringStats(props.state, props.outcomes, now);

  /** The one status phrase of the lists; a calendar that lost its connection gets its action. */
  function status(account: EditorAccount) {
    const sync = props.statuses.get(account.id);
    const run = calendarStatus(props.state, account, sync, stats, now, i18n);
    // The error code is for support, not for the list: it stays in the tooltip.
    const title = sync?.code ? `${formatTimestamp(sync.at)} · ${sync.code}` : undefined;
    return (
      <>
        <span class="cal-status" title={text.statusHint(account.name)}>
          <Run run={run} now={now} title={title} />
        </span>
        {account.needsReconnect ? (
          <a class="btn btn-secondary row-action" href={reconnectUrl(account)}>
            {text.connectAgain}
          </a>
        ) : null}
      </>
    );
  }

  const selected = props.selected
    ? props.state.accounts.find((account) => account.id === props.selected)
    : undefined;
  const panel = selected ? (
    <CalendarPanel {...props} account={selected} kind={kind(selected)} now={now} />
  ) : undefined;

  const broken = props.state.accounts.filter((account) => account.needsReconnect);
  // An address of a calendar that is no longer connected, for example from a bookmark.
  const gone = Boolean(props.requested) && !selected;
  const mirrored = (account: EditorAccount) => account.calendars.filter((c) => c.isSource).length;

  return (
    <Shell
      title={text.title}
      user={props.user}
      active="calendars"
      palette={{ state: props.state, providers: props.providers }}
      attention={navAttention(props.state, props.outcomes, now)}
      actions={
        props.state.accounts.length > 0 && connectable ? (
          <>
            <button
              type="button"
              class="btn btn-secondary connect-trigger"
              popovertarget="connect-menu"
            >
              <Plus />
              {text.connectCalendar}
            </button>
            <div
              id="connect-menu"
              class="menu connect-menu"
              popover="auto"
              role="group"
              aria-label={text.connectMenu}
            >
              <ConnectChoices providers={props.providers} />
            </div>
          </>
        ) : undefined
      }
      panel={panel}
      styles={["/next/calendars.css"]}
    >
      <div class="cal-notices">
        {gone ? <Notice kind="warn">{text.gone}</Notice> : null}
        {props.notice ? (
          <Notice kind={props.notice.kind === "error" ? "danger" : "info"}>
            {props.notice.text}
          </Notice>
        ) : null}
        {broken.map((account) => (
          <Notice
            kind="danger"
            title={text.reconnectTitle(account.name)}
            action={
              <a class="btn btn-secondary" href={reconnectUrl(account)}>
                {text.connectAgain}
              </a>
            }
          >
            {text.reconnectText}
          </Notice>
        ))}
        {props.operatorNotice ? (
          <Notice kind="info" title={t.accounts.operatorNoticeTitle}>
            {props.operatorNotice}{" "}
            <a class="link" href="/privacy">
              {t.accounts.operatorNoticeLink}
            </a>
          </Notice>
        ) : null}
      </div>
      {props.state.accounts.length === 0 ? (
        <EmptyState title={text.emptyTitle} text={text.emptyText}>
          {connectable ? (
            <div class="connect-choices">
              <div class="row-flow">
                {enabledProviders(props.providers).map((provider) => (
                  <a class="btn btn-secondary" href={`/auth/${provider}/connect`}>
                    <ProviderGlyph provider={provider} />
                    {t.next.shell.providers[provider]}
                  </a>
                ))}
              </div>
              {props.providers.google ? <p class="muted">{text.googleHint}</p> : null}
            </div>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <div class="list cal-list">
            <ListGroup title={text.listLabel} label={text.listLabel}>
              {props.state.accounts.map((account) => {
                const isSelected = props.selected === account.id;
                const count = mirrored(account);
                return (
                  <ListRow
                    id={`row-c-${account.id}`}
                    selected={isSelected}
                    icon={<CalendarSwatch account={account} />}
                    title={
                      <a
                        class="row-open"
                        href={calendarHref(account.id)}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={text.openCalendar(account.name)}
                      >
                        {account.name}
                      </a>
                    }
                    meta={
                      <span class="cal-meta">
                        <ProviderGlyph provider={account.provider} label={kind(account)} />
                        <span class="cal-meta-text">{account.email}</span>
                      </span>
                    }
                    tags={
                      <>
                        {account.workHours ? <Tag>{hoursText(t, account.workHours)}</Tag> : null}
                        {count > 1 ? <Tag>{text.mirroredCount(count)}</Tag> : null}
                      </>
                    }
                    status={status(account)}
                  />
                );
              })}
            </ListGroup>
          </div>
          {props.state.accounts.length === 1 ? (
            <p class="cal-quiet muted">{text.singleHint}</p>
          ) : null}
        </>
      )}
      {/* The reload button of the panel belongs to this form, so that Enter in a field of the
          panel saves and never reloads. */}
      {selected ? (
        <form id="reload-calendars" method="post" action={`${appPath("/calendars")}/refresh`}>
          <input type="hidden" name="back" value={`${calendarHref(selected.id)}`} />
        </form>
      ) : null}
    </Shell>
  );
}

/**
 * How many changes a refused form of a calendar holds against the stored values, counted as the
 * save bar counts them (`panel.js`): the weekdays are one change, each calendar switch is one,
 * every other field is one.
 */
export function calendarChanges(
  draft: CalendarDraft,
  stored: {
    name: string;
    color: string;
    hoursOn: boolean;
    days: readonly number[];
    start: string;
    end: string;
    untilMidnight: boolean;
    zone: string;
    sources: readonly string[];
    buffer: { before: string; after: string };
  },
): { count: number; fields: string[] } {
  const sameDays =
    draft.hours.days.length === stored.days.length &&
    draft.hours.days.every((day) => stored.days.includes(day));
  const sources = new Set([...draft.sources, ...stored.sources]);
  // A source switch is named by its field and value: all of them are called "source".
  const sourceChanges = [...sources]
    .filter((id) => draft.sources.includes(id) !== stored.sources.includes(id))
    .map((id) => `source:${id}`);
  const fields = (
    [
      ["name", draft.name !== stored.name],
      ["color", draft.color !== stored.color],
      ["workHoursOn", draft.hours.on !== stored.hoursOn],
      ["workDays", !sameDays],
      ["workStart", draft.hours.start !== stored.start],
      // The end field is off while "until midnight" is on; only the switch then counts.
      ["workEnd", !draft.hours.untilMidnight && draft.hours.end !== stored.end],
      ["workUntilMidnight", draft.hours.untilMidnight !== stored.untilMidnight],
      ["workTimeZone", draft.hours.zone !== stored.zone],
      ["bufferBefore", draft.buffer !== null && draft.buffer.before !== stored.buffer.before],
      ["bufferAfter", draft.buffer !== null && draft.buffer.after !== stored.buffer.after],
    ] as const
  )
    .filter(([, changed]) => changed)
    .map(([name]) => name as string);
  return { count: fields.length + sourceChanges.length, fields: [...fields, ...sourceChanges] };
}

/** The panel of one calendar: one form, one Save. */
function CalendarPanel(
  props: CalendarsProps & { account: EditorAccount; kind: string; now: number },
) {
  const i18n = useI18n();
  const { t, formatDate, formatTimestamp, timeZone } = i18n;
  const text = t.next.calendars;
  const { account, draft } = props;
  const hours = account.workHours;
  const draftHours = draft?.hours;

  const hoursOn = draftHours ? draftHours.on : hours !== null;
  const days = new Set<number>(draftHours?.days ?? hours?.workDays ?? DEFAULT_HOURS.workDays);
  const untilMidnight = draftHours ? draftHours.untilMidnight : hours?.workEnd === "24:00";
  const start = draftHours ? draftHours.start : hours ? hours.workStart : DEFAULT_HOURS.workStart;
  const storedEnd = hours ? hours.workEnd : DEFAULT_HOURS.workEnd;
  const end = draftHours ? draftHours.end : untilMidnight ? "" : storedEnd;
  const storedZone = hours?.workTimeZone ?? "";
  const zone = draftHours ? draftHours.zone : storedZone || timeZone;
  const zoneUnknown = storedZone !== "" && !isTimeZone(storedZone);

  const colour = draft ? draft.color : account.colorChosen ? account.color : "auto";
  const name = draft ? draft.name : (account.customName ?? "");

  const buffer = sourceBuffer(props.state, account.id);
  const hasSource = account.calendars.some((calendar) => calendar.isSource);
  const mixed = buffer === "mixed";
  const bufferValue = (key: "before" | "after") =>
    draft?.buffer
      ? draft.buffer[key]
      : buffer === null || mixed
        ? ""
        : String(key === "before" ? buffer.bufferBefore : buffer.bufferAfter);
  const showBuffer = buffer !== null && (hasSource || draft?.buffer);
  const [fromId = "", toId = ""] = (props.from ?? "").split("~");
  const fromMirroring =
    toId === account.id && fromId !== toId && props.state.accounts.some((a) => a.id === fromId)
      ? fromId
      : null;
  const panelHref = fromMirroring
    ? `${calendarHref(account.id)}&from=${encodeURIComponent(fromMirroring)}~${encodeURIComponent(account.id)}`
    : calendarHref(account.id);
  const returnTo = `${panelHref}&saved=1`;
  if (props.confirm === "disconnect" && !props.error && !props.conflict) {
    const step = t.next.auth.disconnect;
    const here = calendarHref(account.id);
    const mirrorings = props.state.rules.filter(
      (entry) => entry.from === account.id || entry.to === account.id,
    ).length;
    return (
      <Panel title={step.title} closeHref={here}>
        <Section>
          <ConfirmStep
            action={`/accounts/${encodeURIComponent(account.id)}/disconnect`}
            back={appPath("/calendars")}
            sentence={step.text(account.email)}
            note={step.mirrorings(mirrorings)}
            button={step.confirm}
            cancel={step.cancel}
            cancelHref={here}
          />
        </Section>
      </Panel>
    );
  }
  // The version the panel was drawn from. A refusal at a field keeps the one the form had, so that
  // a change made meanwhile still refuses the next save (see the route).
  const version = draft?.version ?? accountVersion(props.state, account.id) ?? "";
  const invalid = (field: CalendarField) => props.errorField === field;
  const errorAt = (...fields: CalendarField[]) =>
    props.errorField && fields.includes(props.errorField) ? props.error : undefined;
  const run = calendarStatus(
    props.state,
    account,
    props.statuses.get(account.id),
    mirroringStats(props.state, props.outcomes, props.now),
    props.now,
    i18n,
  );

  // What a save changes beyond the fields: the mirrorings that new working hours reach, and the
  // copies that a switched-off calendar loses. The script shows a note when its fields change.
  const nameOf = (id: string) => props.state.accounts.find((entry) => entry.id === id)?.name ?? id;
  const hadHours = draft?.hadHours ?? hours !== null;
  const affected = hoursAffected(props.state, account.id, hadHours).map((direction) =>
    t.next.mirroring.fromTo(nameOf(direction.from), nameOf(direction.to)),
  );
  // A buffer belongs to the copies of this calendar's events: it changes every mirroring from it.
  const fromHere = showBuffer
    ? bufferAffected(props.state, account.id).map((direction) =>
        t.next.mirroring.fromTo(nameOf(direction.from), nameOf(direction.to)),
      )
    : [];
  const hoursFields = [
    "workHoursOn",
    "workDays",
    "workStart",
    "workEnd",
    "workUntilMidnight",
    "workTimeZone",
  ];
  const notes = (
    <>
      {affected.length > 0 ? (
        <Note changed={hoursFields}>
          {text.hoursAffected(affected.length, affected.join(", "))}
        </Note>
      ) : null}
      {fromHere.length > 0 ? (
        <Note changed={["bufferBefore", "bufferAfter"]}>
          {text.hoursAffected(fromHere.length, fromHere.join(", "))}
        </Note>
      ) : null}
      {account.calendars
        .filter((calendar) => calendar.isSource)
        .map((calendar) => (
          <Note off={`cal-src-${calendar.id}`}>{text.sourceOff(calendar.name)}</Note>
        ))}
    </>
  );

  const refused = draft
    ? calendarChanges(draft, {
        name: account.customName ?? "",
        color: account.colorChosen ? account.color : "auto",
        hoursOn: hours !== null,
        days: hours?.workDays ?? DEFAULT_HOURS.workDays,
        start: hours ? hours.workStart : DEFAULT_HOURS.workStart,
        end: hours?.workEnd === "24:00" ? "" : (hours?.workEnd ?? DEFAULT_HOURS.workEnd),
        untilMidnight: hours?.workEnd === "24:00",
        zone: storedZone || timeZone,
        sources: account.calendars.filter((calendar) => calendar.isSource).map((c) => c.id),
        buffer:
          buffer === null || mixed
            ? { before: "", after: "" }
            : { before: String(buffer.bufferBefore), after: String(buffer.bufferAfter) },
      })
    : undefined;

  return (
    <Panel
      title={
        <span class="cal-title">
          <CalendarSwatch account={account} />
          <span class="cal-title-text">{account.name}</span>
        </span>
      }
      meta={
        <>
          <span class="cal-status" title={text.statusHint(account.name)}>
            <RunText run={run} title={formatTimestamp} />
          </span>
          <span class="detail-meta-sep" aria-hidden="true" />
          {/* The service before the address, as in the rows of the list. */}
          <span class="cal-meta">
            <ProviderGlyph provider={account.provider} label={props.kind} />
            <span class="cal-meta-text">{account.email}</span>
          </span>
        </>
      }
      closeHref={appPath("/calendars")}
      back={
        fromMirroring
          ? {
              href: mirroringHref(fromMirroring, account.id),
              label: t.next.shell.panel.backToMirroring,
            }
          : undefined
      }
      form={{ action: `${appPath("/calendars")}/${encodeURIComponent(account.id)}` }}
      saved={props.saved && !props.error}
      footer={
        <>
          <SaveBar
            forced={props.error !== undefined}
            notes={notes}
            refusedCount={refused?.count}
            refusedFields={refused?.fields}
          />
        </>
      }
    >
      <input type="hidden" name="back" value={returnTo} />
      <input type="hidden" name="workHoursShown" value="1" />
      <input type="hidden" name="workHoursHad" value={hadHours ? "1" : "0"} />
      <input type="hidden" name="v" value={version} />
      {showBuffer ? <input type="hidden" name="bufferShown" value="1" /> : null}
      <PanelNotices conflict={props.conflict} error={props.error} field={props.errorField} />

      <Section title={text.sectionCalendar}>
        <PropertyRow label={text.name} for="cal-name" fields={["name"]} hint={text.nameHint}>
          <input
            class="input"
            id="cal-name"
            type="text"
            name="name"
            maxlength={MAX_NAME_LENGTH}
            value={name}
            placeholder={text.namePlaceholder(account.derivedName)}
            aria-describedby={hintId("cal-name")}
            autocomplete="off"
          />
        </PropertyRow>
        <PropertyRow
          label={text.colour}
          group="cal-colour"
          stacked
          fields={["color"]}
          hint={text.colourHint}
          error={errorAt("color")}
        >
          <div
            class="swatches"
            role="radiogroup"
            aria-labelledby={labelId("cal-colour")}
            {...describedBy("cal-colour", { hint: true, invalid: invalid("color") })}
          >
            <label class="choice">
              <input type="radio" name="color" value="auto" checked={colour === "auto"} />
              <span>{text.colourAuto}</span>
            </label>
            {ACCOUNT_COLOR_KEYS.map((key) => (
              <label class="swatch" title={t.accounts.colorNames[key]}>
                <input
                  type="radio"
                  name="color"
                  value={key}
                  checked={colour === key}
                  aria-label={t.accounts.colorNames[key]}
                />
                <span class="swatch-dot" style={`--c:${ACCOUNT_COLORS[key]}`} />
              </label>
            ))}
          </div>
        </PropertyRow>
      </Section>

      <Section title={text.sectionIncoming(account.name)}>
        <PropertyRow
          label={text.workingHours}
          for="cal-hours-on"
          fields={["workHoursOn"]}
          hint={text.hoursHint}
        >
          <Switch
            id="cal-hours-on"
            name="workHoursOn"
            label={text.hoursSwitch}
            describedBy={hintId("cal-hours-on")}
            checked={hoursOn}
          />
        </PropertyRow>
        <div class="props" data-hours-fields>
          <PropertyRow
            label={text.days}
            group="cal-days"
            stacked
            fields={["workDays"]}
            error={errorAt("workDays")}
          >
            <Segmented
              name="workDays"
              multiple
              block
              class="cal-days"
              labelledBy={labelId("cal-days")}
              describedBy={invalid("workDays") ? "cal-days-error" : undefined}
              invalid={invalid("workDays")}
              group="days"
              value={[...days].map(String)}
              options={ALL_WEEKDAYS.map((day) => ({
                value: String(day),
                label: t.editor.weekdays[day - 1],
                title: t.editor.weekdayNames[day - 1],
              }))}
            />
          </PropertyRow>
          <PropertyRow
            label={text.hoursRange}
            group="cal-range"
            fields={["workStart", "workEnd"]}
            error={errorAt("workStart", "workEnd")}
          >
            <span class="cal-range" role="group" aria-labelledby={labelId("cal-range")}>
              <input
                class="input cal-time"
                type="time"
                name="workStart"
                value={start}
                aria-label={text.startTime}
                {...describedBy("cal-range", { invalid: invalid("workStart") })}
              />
              <span class="cal-dash" aria-hidden="true">
                –
              </span>
              {/* A time field cannot hold 24:00; "until midnight" stands for it. The page script
                  disables the field then; without the script the server ignores it. */}
              <input
                class="input cal-time"
                type="time"
                name="workEnd"
                value={end}
                aria-label={text.endTime}
                {...describedBy("cal-range", { invalid: invalid("workEnd") })}
              />
            </span>
          </PropertyRow>
          <PropertyRow label={text.untilMidnight} for="cal-midnight" fields={["workUntilMidnight"]}>
            <Switch
              id="cal-midnight"
              name="workUntilMidnight"
              label={text.untilMidnight}
              checked={untilMidnight}
            />
          </PropertyRow>
          <PropertyRow
            label={text.timeZone}
            for="cal-zone"
            fields={["workTimeZone"]}
            hint={zoneUnknown ? t.editor.workZoneUnknown(storedZone) : undefined}
            error={errorAt("workTimeZone")}
          >
            <input
              class="input"
              id="cal-zone"
              type="text"
              name="workTimeZone"
              maxlength={64}
              value={zone}
              data-browser-zone={draftHours || storedZone ? undefined : "1"}
              {...describedBy("cal-zone", {
                hint: zoneUnknown,
                invalid: invalid("workTimeZone"),
              })}
              autocomplete="off"
            />
          </PropertyRow>
        </div>
      </Section>

      <Section title={text.sectionOutgoing(account.name)}>
        <PropertyRow
          label={text.sectionMirrored}
          group="cal-sources"
          stacked
          fields={["source"]}
          hint={
            <>
              {account.calendars.length === 0 ? text.noCalendars : text.mirroredHint}{" "}
              <button type="submit" form="reload-calendars" class="link cal-reload">
                {text.reload}
              </button>
            </>
          }
        >
          {account.calendars.length === 0 ? null : (
            <ul class="cal-sources" aria-labelledby={labelId("cal-sources")}>
              {account.calendars.map((calendar) => (
                <li class="cal-source">
                  <input type="hidden" name="sourceShown" value={calendar.id} />
                  <Switch
                    id={`cal-src-${calendar.id}`}
                    name="source"
                    value={calendar.id}
                    label={text.copyCalendar(calendar.name)}
                    describedBy={hintId("cal-sources")}
                    checked={draft ? draft.sources.includes(calendar.id) : calendar.isSource}
                  />
                  <label class="cal-source-name" for={`cal-src-${calendar.id}`}>
                    <span class="cal-name-text">{calendar.name}</span>
                    {calendar.isMain ? <Tag>{text.mainCalendar}</Tag> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </PropertyRow>
        {showBuffer ? (
          <>
            <PropertyRow
              label={text.bufferBefore}
              for="cal-buffer-before"
              fields={["bufferBefore"]}
              error={errorAt("bufferBefore")}
            >
              <input
                class="input cal-minutes num"
                id="cal-buffer-before"
                type="number"
                name="bufferBefore"
                min={0}
                max={MAX_BUFFER_MINUTES}
                step={1}
                inputmode="numeric"
                value={bufferValue("before")}
                placeholder={mixed ? "…" : "0"}
                aria-describedby={
                  invalid("bufferBefore")
                    ? `${hintId("cal-buffer-after")} cal-buffer-before-error`
                    : hintId("cal-buffer-after")
                }
                aria-invalid={invalid("bufferBefore") ? "true" : undefined}
              />
              <span class="cal-unit" aria-hidden="true">
                {text.minutes}
              </span>
            </PropertyRow>
            <PropertyRow
              label={text.bufferAfter}
              for="cal-buffer-after"
              fields={["bufferAfter"]}
              hint={mixed ? text.bufferMixed : text.bufferHint}
              error={errorAt("bufferAfter")}
            >
              <input
                class="input cal-minutes num"
                id="cal-buffer-after"
                type="number"
                name="bufferAfter"
                min={0}
                max={MAX_BUFFER_MINUTES}
                step={1}
                inputmode="numeric"
                value={bufferValue("after")}
                placeholder={mixed ? "…" : "0"}
                {...describedBy("cal-buffer-after", {
                  hint: true,
                  invalid: invalid("bufferAfter"),
                })}
              />
              <span class="cal-unit" aria-hidden="true">
                {text.minutes}
              </span>
            </PropertyRow>
          </>
        ) : null}
      </Section>

      <Section title={text.sectionConnection}>
        <PropertyRow label={text.connectedLabel}>
          <span class="num">{formatDate(account.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="" group="cal-connection" hint={text.disconnectHint}>
          <a class="btn btn-secondary" href={reconnectUrl(account)}>
            {text.connectAgain}
          </a>
          <a
            class="btn btn-ghost btn-danger-ghost"
            href={disconnectHref(account.id)}
            aria-describedby={hintId("cal-connection")}
          >
            {text.disconnect}
          </a>
        </PropertyRow>
      </Section>
    </Panel>
  );
}
