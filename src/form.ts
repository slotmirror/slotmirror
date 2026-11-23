import { MAX_BUFFER_MINUTES } from "./config";
import {
  MAX_CATEGORY_LENGTH,
  type AccountWorkHours,
  type RuleDetailsProblem,
  type SettingsForm,
} from "./editor";
import type { Messages } from "./i18n";

/**
 * Pure readers of the editor forms. Both the old routes and the redesign read their forms here, so
 * that a domain module such as `src/next-calendars.ts` does not depend on a route module.
 */

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Minutes from a number field. An empty field is 0; the options schema refuses the rest. */
export function minutes(value: string): number {
  return value.trim() === "" ? 0 : Number(value);
}

/**
 * Working hours from an account form. The button "No working hours" of an older page
 * (`workHours=none`) means none. If the form carries a switch (`switchSent`), the switch off means
 * none. No weekday and no time mean none. A time field cannot hold 24:00; "until midnight" stands
 * for it.
 */
export function workHoursFrom(form: FormData, switchSent: boolean): AccountWorkHours | null {
  if (form.get("workHours") === "none") return null;
  if (switchSent && !form.has("workHoursOn")) return null;
  const value = (name: string) => formText(form, name).trim();
  const workDays = form.getAll("workDays").map((day) => Number(day));
  const workStart = value("workStart");
  const workEnd = form.has("workUntilMidnight") ? "24:00" : value("workEnd");
  if (workDays.length === 0 && workStart === "" && workEnd === "") return null;
  return { workDays, workStart, workEnd, workTimeZone: value("workTimeZone") };
}

/** The names and the checked colours of the opt-in list, as one comma list. */
export function onlyCategoriesField(form: FormData): string {
  const colors = form.getAll("onlyColor").filter((value) => typeof value === "string");
  return [formText(form, "onlyCategories"), ...colors].join(",");
}

/** A comma list as a rule's list of categories: no blanks, no repeats, within the schema's limits. */
export function categoryNames(list: string): string[] {
  const names = list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 100);
  return [...new Set(names)].slice(0, 50);
}

/** Why rule details were refused, in the user's words. */
export function ruleDetailsError(t: Messages, problem: RuleDetailsProblem): string {
  switch (problem.kind) {
    case "color":
      if (problem.problem === "comma") return t.editor.blockCategoryComma;
      if (problem.problem === "tooLong") return t.editor.blockCategoryTooLong(MAX_CATEGORY_LENGTH);
      return t.editor.blockColorInvalid;
    case "source":
      return t.editor.bufferInvalid(MAX_BUFFER_MINUTES);
    case "noWorkHours":
      return t.editor.workHoursMissing(problem.account);
    case "onlyCategories":
      return t.editor.onlyCategoriesGoogle;
    case "direction":
      if (problem.field === "onlyCategories") return t.editor.onlyCategoriesDirection;
      return problem.field === "color" ? t.editor.blockColorInvalid : t.editor.workHoursDirection;
  }
}

/**
 * Settings from a form or the editor script's fields "settings.<name>". An empty block title
 * becomes `defaultTitle`, the one of the user's language.
 */
export function settingsFrom(form: FormData, defaultTitle: string, prefix = ""): SettingsForm {
  const days = Number(form.get(`${prefix}daysAhead`));
  const shown = Number(form.get(`${prefix}daysAheadShown`));
  const skipAllDayShown = form.get(`${prefix}skipAllDayShown`);
  const markPrivateShown = form.get(`${prefix}markPrivateShown`);
  // Only the two exact words count; anything else is no choice, never "open".
  const newWho = form.get(`${prefix}newWho`);
  const text = (name: string) => formText(form, `${prefix}${name}`);
  // Outlook categories as comma-separated names, Google colours as checkboxes "color:<id>".
  const categories = text("skipCategories")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 100);
  const colors = form
    .getAll(`${prefix}skipColor`)
    .filter((value): value is string => typeof value === "string" && /^color:\d{1,2}$/.test(value));
  return {
    ...([30, 90, 180, 365].includes(days) ? { daysAhead: days } : {}),
    ...(Number.isInteger(shown) && shown >= 1 && shown <= 365 ? { daysAheadShown: shown } : {}),
    ...(skipAllDayShown === "1" || skipAllDayShown === "0"
      ? { skipAllDayShown: skipAllDayShown === "1" }
      : {}),
    ...(markPrivateShown === "1" || markPrivateShown === "0"
      ? { markPrivateShown: markPrivateShown === "1" }
      : {}),
    ...(newWho === "private" || newWho === "open" ? { newWho } : {}),
    ...(form.get(`${prefix}applyWho`) === "1" ? { applyWho: true } : {}),
    skipAllDay: form.has(`${prefix}skipAllDay`),
    skipTentative: form.has(`${prefix}skipTentative`),
    markPrivate: form.has(`${prefix}markPrivate`),
    blockTitle: text("blockTitle").trim().slice(0, 255) || defaultTitle,
    skipCategories: [...new Set([...categories, ...colors])].slice(0, 50),
  };
}

/** The direction named by `?d=<from>~<to>`, or undefined if the value is malformed. */
export function parseDirectionParam(
  value: string | undefined,
): { from: string; to: string } | undefined {
  const parts = (value ?? "").split("~");
  const [from, to] = parts;
  if (parts.length !== 2 || !from || !to) return undefined;
  return { from, to };
}
