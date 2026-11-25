import type { EditorDirection, EditorState } from "./editor";

/**
 * Versions of the state that a panel renders, for the hidden field `v` of its form. A save that
 * carries `v` is refused if the version of the stored state differs: then another tab or device
 * changed what the panel showed after it was drawn. The versions are pure hashes of the editor
 * state, so they need no column and no migration.
 *
 * Every input is a stored value. A page draws from a state that `withLocalizedTitle` may have
 * changed, and a save reads the raw state; both must give the same version.
 *
 * FNV-1a over UTF-16 code units, 32 bits, in base 36. This is no security measure: the person can
 * only race their own tabs. A collision (about one in four billion for two different states) lets
 * one stale save through unnoticed: the writes then compare with the state read for this save,
 * which already holds the change of the other tab.
 */
function hash(parts: readonly string[]): string {
  let value = 0x811c9dc5;
  // A separator that no part holds, so that ["ab", "c"] and ["a", "bc"] differ.
  for (const char of parts.join("\u0000")) {
    for (let i = 0; i < char.length; i++) {
      value ^= char.charCodeAt(i);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
  }
  return value.toString(36);
}

/** Parts in a fixed order: SQL returns rules and calendars in an order that can change. */
function sorted(parts: string[]): string[] {
  return parts.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A rule as a part: its id, whether it runs, and its options as stored (level, mark, details). */
function rulePart(rule: { id: string; enabled: boolean; optionsJson: string }): string {
  return `${rule.id}:${rule.enabled ? 1 : 0}:${rule.optionsJson}`;
}

/** The block title as stored; a page may show the default of its language instead. */
function storedTitle(state: EditorState): string {
  return state.settings.blockTitleStored === false ? "" : state.settings.blockTitle;
}

/** The name of an account, or "" for an id the state does not have. */
function nameOf(state: EditorState, id: string): string {
  return state.accounts.find((account) => account.id === id)?.name ?? "";
}

/**
 * One mirroring as its panel draws it and words it: its rules (level, mark, details) and parked
 * exceptions, the caps of the org, the names of both calendars, whether the target can be written
 * and has working hours, the copies' title, and the default answer of a mirroring that is off.
 */
export function directionVersion(state: EditorState, direction: EditorDirection): string {
  const target = state.accounts.find((account) => account.id === direction.to);
  const running = direction.slots.some((slot) => slot.rule?.enabled);
  return hash([
    "d",
    `${direction.effective}:${direction.maxChoice}`,
    nameOf(state, direction.from),
    nameOf(state, direction.to),
    target?.calendar?.canEdit ? "w" : "r",
    JSON.stringify(target?.workHours ?? null),
    storedTitle(state),
    running ? "" : `default:${state.settings.markPrivate ? 1 : 0}`,
    ...sorted(
      direction.slots.map((slot) =>
        slot.rule ? rulePart(slot.rule) : `-:${slot.sourceCalendarId}`,
      ),
    ),
    ...sorted(direction.parked.map((rule) => `p:${rule.id}`)),
  ]);
}

/**
 * The settings for all mirrorings as the panel draws them and words them: the stored settings,
 * every rule (the counts and the "Same as you" warning come from each rule's level and mark), the
 * level of every mirroring after the caps, the rules outside the mirrorings, and the names of the
 * calendars that the warning lists.
 */
export function settingsVersion(state: EditorState): string {
  const { settings } = state;
  const stored = {
    daysAhead: settings.daysAhead,
    skipAllDay: settings.skipAllDay,
    skipTentative: settings.skipTentative,
    markPrivate: settings.markPrivate,
    blockTitle: storedTitle(state),
    skipCategories: settings.skipCategories,
  };
  return hash([
    "s",
    JSON.stringify(stored),
    ...sorted(state.rules.map(({ rule }) => rulePart(rule))),
    ...sorted(
      state.directions.map(
        (direction) =>
          `${direction.from}>${direction.to}:${direction.effective}:${direction.maxChoice}`,
      ),
    ),
    ...sorted(state.others.map((other) => `${other.ruleId}:${other.choice}:${other.target}`)),
    ...sorted(state.accounts.map((account) => `${account.id}:${account.name}`)),
  ]);
}

/**
 * One calendar as its panel draws it and words it: name, colour, working hours, source options,
 * which of its calendars are copied (not their names, which the provider may change), the rules
 * from it and into it (buffers, working hours), whether those mirrorings run, and the names of the
 * calendars at their other end. Null if the state has no such account.
 */
export function accountVersion(state: EditorState, id: string): string | null {
  const account = state.accounts.find((entry) => entry.id === id);
  if (!account) return null;
  const linked = state.directions.filter((d) => d.from === id || d.to === id);
  return hash([
    "c",
    account.customName ?? "",
    account.colorChosen ? account.color : "auto",
    JSON.stringify(account.workHours),
    JSON.stringify(account.sourceOptions),
    ...sorted(account.calendars.map((calendar) => `${calendar.id}:${calendar.isSource ? 1 : 0}`)),
    ...sorted(
      state.rules
        .filter((entry) => entry.from === id || entry.to === id)
        .map(({ from, to, rule }) => `${from}>${to}:${rulePart(rule)}`),
    ),
    ...sorted(
      linked.map(
        (d) =>
          `${d.from}>${d.to}:${d.effective}:${d.ruleId ?? "-"}:${nameOf(state, d.from === id ? d.to : d.from)}`,
      ),
    ),
  ]);
}

/**
 * True if the form carries a version (`v`) and it is not `current`: the panel was drawn from a
 * state that changed since. A form without `v`, such as a post of the old pages, is never stale.
 * An empty or repeated `v` counts by its first value, so it is stale too.
 */
export function isStale(form: FormData, current: string | null): boolean {
  return form.has("v") && form.get("v") !== current;
}
