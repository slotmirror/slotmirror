import { ACCOUNT_COLOR_KEYS, type AccountColor } from "./colors";
import { MAX_BUFFER_MINUTES } from "./config";
import {
  accountWorkHours,
  EditorConflict,
  loadEditorState,
  MAX_NAME_LENGTH,
  NO_WORKING_HOURS,
  renameAccount,
  requestSyncs,
  ruleDetailsProblem,
  setAccountColor,
  setAccountWorkHours,
  setDefaultBlockTitle,
  setRuleDetails,
  setSourceCalendar,
  sourceBuffer,
  type AccountWorkHours,
  type EditorAccount,
  type EditorState,
  type RuleDetails,
} from "./editor";
import type { Messages } from "./i18n";
import { formText as text, minutes, workHoursFrom as readWorkHours } from "./form";
import { hasWorkingHours, type WorkingHoursProblem } from "./sync/working-hours";
import type { CurrentUser } from "./users";
import { accountVersion, isStale } from "./versions";

/**
 * The save of the calendar panel under /next/calendars. One form carries the name, the colour,
 * the working hours, the source calendars and the buffer of one account. This module reads it and
 * calls the functions of `src/editor.ts` that the old endpoints call, so that both validate the
 * same way. It holds no SQL.
 */

/** What the user typed into the panel, to show it again after a refused save. */
export interface CalendarDraft {
  name: string;
  color: string;
  hours: {
    on: boolean;
    days: number[];
    start: string;
    end: string;
    untilMidnight: boolean;
    zone: string;
  };
  /** The calendars of the account that were switched on. */
  sources: string[];
  /** Null if the form had no buffer fields. */
  buffer: { before: string; after: string } | null;
  /**
   * Whether the account had working hours when the form was drawn. Null if the form did not say.
   * A save with hours on and none before also switches hours on for the incoming mirrorings.
   */
  hadHours: boolean | null;
  /** The version (`v`) the form was drawn with; null if it had none. */
  version: string | null;
}

export function calendarDraft(form: FormData): CalendarDraft {
  return {
    name: text(form, "name"),
    color: text(form, "color") || "auto",
    hours: {
      on: form.has("workHoursOn"),
      days: form.getAll("workDays").map((value) => Number(value)),
      start: text(form, "workStart"),
      end: text(form, "workEnd"),
      untilMidnight: form.has("workUntilMidnight"),
      zone: text(form, "workTimeZone"),
    },
    sources: form.getAll("source").filter((value) => typeof value === "string"),
    buffer: form.has("bufferShown")
      ? { before: text(form, "bufferBefore"), after: text(form, "bufferAfter") }
      : null,
    hadHours: hadHoursField(form),
    version: form.has("v") ? text(form, "v") : null,
  };
}

/** The field "workHoursHad": "1" or "0" as the page drew it; anything else, or none, is unknown. */
function hadHoursField(form: FormData): boolean | null {
  const value = form.get("workHoursHad");
  return value === "1" ? true : value === "0" ? false : null;
}

/**
 * Working hours from the panel. The switch off, or no weekday and no time, mean none. Same rules as
 * the account settings form (`workHoursFrom` in `src/form.ts`).
 */
function workHoursFrom(form: FormData): AccountWorkHours | null {
  return readWorkHours(form, true);
}

/** The mirrorings that run into an account. */
function runningInto(state: EditorState, accountId: string) {
  return state.directions.filter(
    (direction) =>
      direction.to === accountId && direction.ruleId !== null && direction.effective !== "off",
  );
}

/**
 * The mirrorings into a calendar that a change of its working hours changes. New hours start on
 * every running mirroring into the calendar, as `saveCalendar` ticks them. With hours already set,
 * a change reaches only the mirrorings that have "only in working hours" on. The panel names them
 * in the save bar. `hadHours` is what the form says about the hours before the save; without it
 * the stored hours decide.
 */
export function hoursAffected(
  state: EditorState,
  accountId: string,
  hadHours?: boolean | null,
): { from: string; to: string }[] {
  const account = state.accounts.find((entry) => entry.id === accountId);
  const running = runningInto(state, accountId);
  const affected =
    (hadHours ?? Boolean(account?.workHours))
      ? running.filter(
          (direction) => direction.options !== null && hasWorkingHours(direction.options),
        )
      : running;
  return affected.map((direction) => ({ from: direction.from, to: direction.to }));
}

/**
 * The mirrorings that a change of a calendar's buffer changes: every running mirroring that copies
 * from the calendar, because the buffer belongs to the copies of its events (`sourceBuffer`). The
 * panel names them in the save bar, next to the ones that working hours reach.
 */
export function bufferAffected(
  state: EditorState,
  accountId: string,
): { from: string; to: string }[] {
  return state.directions
    .filter(
      (direction) =>
        direction.from === accountId && direction.ruleId !== null && direction.effective !== "off",
    )
    .map((direction) => ({ from: direction.from, to: direction.to }));
}

/** A form field that a refusal is about, so that the panel can show the reason at the field. */
export type CalendarField =
  | "color"
  | "workDays"
  | "workStart"
  | "workEnd"
  | "workTimeZone"
  | "bufferBefore"
  | "bufferAfter";

/**
 * The end of a save. A refusal names its reason, and the field if one field caused it; a refusal
 * at a field comes before any write. A refusal without a field is a change made by another tab
 * while this save ran: steps before it may be stored. A conflict stored nothing: the form's
 * version `v` says that the panel was drawn from a state that changed since.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; error: string; field?: CalendarField }
  | { ok: false; conflict: true }
  | { ok: false; missing: true };

/** The field of a working-hours problem: the one the person must change. */
function hoursField(problem: WorkingHoursProblem, hours: AccountWorkHours | null): CalendarField {
  if (problem === "days") return "workDays";
  if (problem === "zone") return "workTimeZone";
  if (problem === "order") return "workEnd";
  // "time": a missing or malformed time. The start first, as the person reads the row.
  const start = hours?.workStart.trim() ?? "";
  return start === "" || !/^\d{2}:\d{2}$/.test(start) ? "workStart" : "workEnd";
}

/** The first buffer field outside the range: "before" if it does not fit, else "after". */
function bufferField(before: string): CalendarField {
  const number = minutes(before);
  const fits = Number.isInteger(number) && number >= 0 && number <= MAX_BUFFER_MINUTES;
  return fits ? "bufferAfter" : "bufferBefore";
}

/** The stored hours and the hours of the form as one comparable value. */
function hoursKey(hours: AccountWorkHours | null): string {
  const value = hours ?? NO_WORKING_HOURS;
  return JSON.stringify([
    [...value.workDays].sort((x, y) => x - y),
    value.workStart,
    value.workEnd,
    value.workTimeZone,
  ]);
}

/** The name that a save stores, as `renameAccount` derives it: null for none or the derived one. */
function storedName(account: EditorAccount, typed: string): string | null {
  const trimmed = typed.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed === "" || trimmed === account.derivedName ? null : trimmed;
}

/**
 * Check every field, then write what changed. A save without changes reads the state once and
 * writes nothing, so that the cost of a save does not grow with the number of calendars. A refusal
 * writes nothing. The steps are not one transaction: a later save with the same form finishes
 * them, because each step compares the form with the stored state. The working hours and the switch
 * "only in working hours" for the incoming mirrorings are one batch, and "first working hours"
 * comes from what the form was drawn with, so a retry after a failed batch does both.
 */
export async function saveCalendar(
  env: Env,
  user: CurrentUser,
  t: Messages,
  accountId: string,
  form: FormData,
): Promise<SaveResult> {
  const state = await loadEditorState(env, user.id);
  const account = state.accounts.find((entry) => entry.id === accountId);
  if (!account) return { ok: false, missing: true };
  // Before any other check: a refusal of a stale form would show values that are not stored.
  if (isStale(form, accountVersion(state, accountId))) return { ok: false, conflict: true };
  const texts = t.next.calendars;
  const errors = texts.fieldErrors;

  const colorValue = form.has("color") ? text(form, "color") : null;
  if (colorValue !== null && colorValue !== "auto" && !isColor(colorValue)) {
    return { ok: false, error: errors.color, field: "color" };
  }

  const typedHours = workHoursFrom(form);
  const hours = form.has("workHoursShown") ? accountWorkHours(env, typedHours) : null;
  if (hours && "problem" in hours) {
    return {
      ok: false,
      error: errors[hours.problem],
      field: hoursField(hours.problem, typedHours),
    };
  }

  let buffer: RuleDetails["sources"] = undefined;
  if (form.has("bufferShown")) {
    const before = text(form, "bufferBefore");
    const after = text(form, "bufferAfter");
    const current = sourceBuffer(state, accountId);
    // Different buffers on the account's mirrorings, and no new value typed: keep them.
    const keep = current === "mixed" && before === "" && after === "";
    const options = { bufferBefore: minutes(before), bufferAfter: minutes(after) };
    const same =
      current !== null &&
      current !== "mixed" &&
      current.bufferBefore === options.bufferBefore &&
      current.bufferAfter === options.bufferAfter;
    if (!keep) {
      const sources = [{ from: accountId, options }];
      if (ruleDetailsProblem(state, { sources })) {
        return {
          ok: false,
          error: errors.buffer(MAX_BUFFER_MINUTES),
          field: bufferField(before),
        };
      }
      if (!same) buffer = sources;
    }
  }

  // What differs from the stored state. The rest is not written.
  const hoursChanged = hours !== null && hoursKey(account.workHours) !== hoursKey(hours.hours);
  const hadHours = hadHoursField(form) ?? account.workHours !== null;
  // New hours start on every running mirroring into the calendar, as the old form ticks them;
  // later changes leave each mirroring as it is.
  const incoming = runningInto(state, accountId);
  const hoursOn =
    hours?.hours && !hadHours && incoming.length > 0
      ? incoming.map((direction) => ({ from: direction.from, to: accountId, on: true }))
      : undefined;
  const sourceChanges = form.has("sourceShown")
    ? (() => {
        const shown = new Set(
          form.getAll("sourceShown").filter((value) => typeof value === "string"),
        );
        const on = new Set(form.getAll("source"));
        return account.calendars
          .filter((calendar) => shown.has(calendar.id) && calendar.isSource !== on.has(calendar.id))
          .map((calendar) => ({ id: calendar.id, on: on.has(calendar.id) }));
      })()
    : [];
  const colorChanged =
    colorValue !== null && colorValue !== (account.colorChosen ? account.color : "auto");
  const nameChanged =
    form.has("name") && storedName(account, text(form, "name")) !== account.customName;
  const details: RuleDetails = {};
  if (buffer) details.sources = buffer;

  // One set for the steps that take one, and one request per account at the end.
  const syncs = new Set<string>();
  try {
    // The hours and the switch for the incoming mirrorings are one batch: a failure leaves neither,
    // and the retry (the form still says "no hours before") does both. It writes the hours only if
    // they and the rules are as checked.
    if (hours && (hoursChanged || hoursOn)) {
      await setAccountWorkHours(env, user, accountId, hours.hours, {
        switchOn: hoursOn?.map((entry) => entry.from),
        syncs,
        state,
      });
    }
    if (
      sourceChanges.some((change) => change.on) &&
      state.rules.length === 0 &&
      state.settings.blockTitleStored === false
    ) {
      // The first rule of a new user gets the block title in the user's language.
      await setDefaultBlockTitle(env, user.id, t.editor.defaultBlockTitle);
    }
    // Each switch only from the value that was checked: another request that switched it since
    // stops the save here.
    for (const change of sourceChanges) {
      await setSourceCalendar(env, user, change.id, change.on, syncs, true);
    }
    if (colorChanged) {
      await setAccountColor(
        env,
        user,
        accountId,
        colorValue === "auto" ? null : (colorValue as AccountColor),
        account,
      );
    }
    // The name and the colour are written only if they are still the ones that were checked.
    if (nameChanged) await renameAccount(env, user, accountId, text(form, "name"), account);
    // After the source calendars, so that the buffer reaches the rules they just added. The buffer
    // patches the rules out of this calendar; the hours above patch only the rules into it, so the
    // checked state still holds for them. A source switch adds or changes rules out of it: then
    // the buffer step reads again.
    if (details.sources) {
      const checked = sourceChanges.length > 0 ? undefined : state;
      await setRuleDetails(env, user, details, syncs, checked);
    }
  } catch (error) {
    if (error instanceof EditorConflict) return { ok: false, error: texts.conflict };
    throw error;
  } finally {
    // Writes before a failure stay, so their accounts sync as well.
    await requestSyncs(env, syncs);
  }
  return { ok: true };
}

function isColor(value: string): value is AccountColor {
  return (ACCOUNT_COLOR_KEYS as string[]).includes(value);
}
