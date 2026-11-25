import type { CalendarCleanup, Cleanups } from "../../../cleanup";
import { useI18n } from "../../../i18n";
import type { CurrentUser } from "../../../users";
import { PageFrame } from "./frame";

function CalendarTitle(props: { calendar: CalendarCleanup }) {
  const { t } = useI18n();
  const text = t.next.auth.cleanup;
  return (
    <>
      <div class="pub-row-title">{props.calendar.name ?? text.unnamedCalendar}</div>
      {props.calendar.account ? <div class="pub-row-meta">{props.calendar.account}</div> : null}
    </>
  );
}

/** What a user deletes by hand: the count, the period and the marker of each calendar. */
function CalendarList(props: { calendars: CalendarCleanup[] }) {
  const { t, formatDate } = useI18n();
  const text = t.next.auth.cleanup;
  return (
    <ul class="pub-rows">
      {props.calendars.map((calendar) => (
        <li>
          <CalendarTitle calendar={calendar} />
          <div class="pub-row-meta">
            {calendar.blocks === null
              ? text.unknownCount
              : calendar.estimated
                ? text.aboutCount(calendar.blocks)
                : text.count(calendar.blocks)}
          </div>
          {calendar.windowStart && calendar.windowEnd ? (
            <div class="pub-row-meta">
              {text.period(formatDate(calendar.windowStart), formatDate(calendar.windowEnd))}
            </div>
          ) : null}
          {calendar.markers.map(({ ruleTag, blockTitle }) => (
            <div class="pub-row-meta">
              {blockTitle === null ? text.markerOnly(ruleTag) : text.marker(ruleTag, blockTitle)}
            </div>
          ))}
          {calendar.reasons.map((reason) => (
            <div class="pub-row-meta">{text.reasons[reason]}</div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Removals that still run. Nothing here asks the user to act, so no marker and no count. */
function RunningList(props: { calendars: CalendarCleanup[] }) {
  const { t, formatDate } = useI18n();
  const text = t.next.auth.cleanup;
  // A throttled job on an account that works has no deadline, and can pass this date.
  const upcoming = (date: string | null) => date !== null && Date.parse(date) > Date.now();
  return (
    <ul class="pub-rows">
      {props.calendars.map((calendar) => (
        <li>
          <CalendarTitle calendar={calendar} />
          {calendar.waitsUntil && upcoming(calendar.waitsUntil) ? (
            <div class="pub-row-meta">{text.running(formatDate(calendar.waitsUntil))}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The blocks that an offboarding could not remove, per target calendar. The page names the calendar,
 * the count, the marker and the period. It knows no event content. A removal that still runs stands
 * apart: it is no rest, and asks nothing of the user.
 */
export function CleanupPage(props: {
  user: CurrentUser;
  own: Cleanups;
  /** Deleted users, for an admin. */
  others: Cleanups;
}) {
  const { t } = useI18n();
  const text = t.next.auth.cleanup;
  const running = [...props.own.running, ...props.others.running];
  const left = props.own.left.length > 0 || props.others.left.length > 0;
  const empty = !left && running.length === 0;
  const runningOnly = !left && running.length > 0;
  return (
    <PageFrame
      title={runningOnly ? text.runningTitle : text.title}
      user={props.user}
      nav="calendars"
      lead={
        left ? (
          <>
            {text.lead} {text.reconnectDoesNotHelp}
          </>
        ) : runningOnly ? (
          text.runningLead
        ) : undefined
      }
    >
      {empty ? <p class="pub-text">{text.empty}</p> : null}
      {props.own.left.length > 0 ? <CalendarList calendars={props.own.left} /> : null}
      {runningOnly ? <RunningList calendars={running} /> : null}
      {props.others.left.length > 0 ? (
        <section class="pub-section">
          <h2 class="pub-subtitle">{text.othersTitle}</h2>
          <p class="pub-text">{text.othersLead}</p>
          <CalendarList calendars={props.others.left} />
        </section>
      ) : null}
      {left && running.length > 0 ? (
        <section class="pub-section">
          <h2 class="pub-subtitle">{text.runningTitle}</h2>
          <p class="pub-text">{text.runningLead}</p>
          <RunningList calendars={running} />
        </section>
      ) : null}
      {left ? <p class="pub-hint">{text.markerHelp}</p> : null}
    </PageFrame>
  );
}
