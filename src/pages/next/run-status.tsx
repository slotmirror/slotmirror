import type { AccountSyncStatus, RuleOutcome } from "../../audit";
import type { EditorState } from "../../editor";
import { useI18n } from "../../i18n";
import { StatusDot, type Tone } from "./components";
import { mirroringStats, shortAge, type MirroringStat } from "./overview";
import type { ShellAttention } from "./shell";

/**
 * The one status vocabulary of the lists and panel heads, after the Overview's map: a dot and a
 * short time ("8 min") when all is well, the state in words only when it is not ("Failed 8 min",
 * "Connection lost"). The counts and states come from `mirroringStats`, so a row says what the
 * map cell says.
 */
export interface RunPhrase {
  tone: Tone;
  /** The state in words; absent when all is well. */
  words?: string;
  /** The time shown after the words, as a short age. */
  at?: string;
  /** The whole phrase as text, for an accessible name: "Last run 8 min", "Failed 8 min". */
  text: string;
}

/** The status of one mirroring that runs. */
export function mirroringRun(
  stat: MirroringStat,
  now: number,
  i18n: ReturnType<typeof useI18n>,
): RunPhrase {
  const run = i18n.t.next.shell.run;
  const age = (iso: string) => shortAge(iso, now, i18n.locale, i18n.t.next.overview.age.now);
  switch (stat.state) {
    case "ok":
      return stat.at
        ? { tone: "ok", at: stat.at, text: run.lastRun(age(stat.at)) }
        : { tone: "idle", words: run.noRun, text: run.noRun };
    case "partial":
      return { tone: "warn", words: run.catchingUp, text: run.catchingUp };
    case "failed": {
      const words = stat.notWritten > 0 ? run.notWritten(stat.notWritten) : run.failed;
      const at = stat.failure?.createdAt;
      return { tone: "danger", words, at, text: at ? `${words} ${age(at)}` : words };
    }
    case "overdue": {
      const words = run.overdue(age(stat.stale ?? ""));
      return { tone: "warn", words, text: words };
    }
    case "blocked":
      return { tone: "danger", words: run.connectionLost, text: run.connectionLost };
    case "waiting":
      return { tone: "idle", words: run.noRun, text: run.noRun };
  }
}

/** The copies a mirroring holds, when its latest runs say so and the count is current. */
export function mirroringCopies(stat: MirroringStat | undefined): number | null {
  if (!stat || (stat.state !== "ok" && stat.state !== "partial")) return null;
  return stat.blocks;
}

/** The status of a calendar from the latest runs into it. */
export function calendarRun(
  status: AccountSyncStatus | undefined,
  needsReconnect: boolean,
  now: number,
  i18n: ReturnType<typeof useI18n>,
): RunPhrase {
  const run = i18n.t.next.shell.run;
  const age = (iso: string) => shortAge(iso, now, i18n.locale, i18n.t.next.overview.age.now);
  if (needsReconnect) {
    return { tone: "danger", words: run.connectionLost, text: run.connectionLost };
  }
  if (!status) return { tone: "idle", words: run.noRun, text: run.noRun };
  switch (status.state) {
    case "ok":
      return { tone: "ok", at: status.at, text: run.lastRun(age(status.at)) };
    case "partial":
      return { tone: "warn", words: run.catchingUp, text: run.catchingUp };
    case "paused":
      return { tone: "idle", words: run.paused, text: run.paused };
    case "error": {
      const words = !status.code && status.failed ? run.notWritten(status.failed) : run.failed;
      return { tone: "danger", words, at: status.at, text: `${words} ${age(status.at)}` };
    }
  }
}

/** A short age with the exact time in its title. */
export function ShortTime(props: { at: string; now: number; title?: string }) {
  const { locale, t, formatTimestamp } = useI18n();
  return (
    <time class="num" datetime={props.at} title={props.title ?? formatTimestamp(props.at)}>
      {shortAge(props.at, props.now, locale, t.next.overview.age.now)}
    </time>
  );
}

/**
 * A status as dot and words. A fine state shows only the time; its dot then names the state for
 * assistive technology ("In sync"), so that "8 min" is not read alone.
 */
export function Run(props: { run: RunPhrase; now: number; title?: string }) {
  const { run } = props;
  return (
    <span class="run">
      <StatusDot tone={run.tone} label={run.words ? false : undefined} />
      {run.words ? <span class={`run-words is-${run.tone}`}>{run.words}</span> : null}
      {run.at ? <ShortTime at={run.at} now={props.now} title={props.title} /> : null}
    </span>
  );
}

/**
 * A status as one phrase for a panel's state line: the dot and the whole words ("Last run 8 min",
 * "Failed 8 min"). `title` formats the exact time for the tooltip.
 */
export function RunText(props: { run: RunPhrase; title?: (iso: string) => string }) {
  const { run } = props;
  return (
    <span class="run">
      <StatusDot tone={run.tone} label={false} />
      {run.at ? (
        <time class="num" datetime={run.at} title={props.title?.(run.at)}>
          {run.text}
        </time>
      ) : (
        <span class={`run-words is-${run.tone}`}>{run.text}</span>
      )}
    </span>
  );
}

/**
 * The nav dots from data a page has loaded anyway: Mirroring when a mirroring failed, Calendars
 * when a calendar lost its connection. `stats` can be passed when the page computed them already.
 */
export function navAttention(
  state: EditorState,
  outcomes: RuleOutcome[],
  now: number,
  stats: Map<string, MirroringStat> = mirroringStats(state, outcomes, now),
): ShellAttention {
  return {
    mirroring: [...stats.values()].some((stat) => stat.state === "failed"),
    calendars: state.accounts.some((account) => account.needsReconnect),
  };
}
