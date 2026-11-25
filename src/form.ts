import { MAX_BUFFER_MINUTES, type Provider } from "./config";
import {
  MAX_CATEGORY_LENGTH,
  MAX_PASS_CATEGORIES,
  type AccountWorkHours,
  type PassPair,
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

/**
 * The carried categories of one direction from a form. Between two calendars of one provider the
 * field is one list: "passCategories" (a comma list of Outlook names) or the ticked "passColor"
 * boxes (Google), with an empty target. Between providers each row sends one "passFrom" and one
 * "passTo" field, in the order of the rows, so the n-th of each name is one row. A select always
 * sends a value and a text field always sends its text, so the two lists line up. The row's text
 * field decides: if it is empty, the row is blank, whatever the colour says. That clears a saved
 * row and ignores the empty row at the end. A ticked "Tentative" box sends "passTentative" with
 * the index of its row, counted from 0 over all rows: an unticked box sends nothing, so the order
 * of the boxes cannot tell their rows. Values are only split here: `passCategoriesFor` refuses
 * names, lists over the limits and a tentative row in a direction that cannot show it, as it does
 * for the batch path, instead of dropping them.
 */
export function passPairsFromForm(form: FormData, source: Provider, target: Provider): PassPair[] {
  if (source === target) {
    const list =
      source === "google"
        ? form.getAll("passColor").filter((value) => typeof value === "string")
        : formText(form, "passCategories")
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "");
    return list.map((from) => ({ from, to: "", tentative: false }));
  }
  const texts = (name: string) =>
    form.getAll(name).map((value) => (typeof value === "string" ? value.trim() : ""));
  const froms = texts("passFrom");
  const tos = texts("passTo");
  const ticked = new Set(texts("passTentative"));
  const pairs: PassPair[] = [];
  for (let index = 0; index < Math.max(froms.length, tos.length); index++) {
    const from = froms[index] ?? "";
    const to = tos[index] ?? "";
    // The text side is the name of the Outlook category: the source for Outlook to Google.
    if ((source === "google" ? to : from) === "") continue;
    pairs.push({ from, to, tentative: ticked.has(String(index)) });
  }
  return pairs;
}

/**
 * The carried categories of the batch path: one JSON list per direction of [from, to] pairs or
 * [from, to, tentative] triples, where `tentative` is a boolean. JSON, because an Outlook category
 * name can hold any character except a comma, so no separator is safe, and a pair must stay
 * together. Null if the text is not a list of such entries.
 */
export function passPairsFromJson(text: string): PassPair[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const pairs: PassPair[] = [];
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3)) return null;
    const [from, to, tentative = false] = entry as unknown[];
    if (typeof from !== "string" || typeof to !== "string" || typeof tentative !== "boolean") {
      return null;
    }
    pairs.push({ from, to, tentative });
  }
  return pairs;
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
    case "passCategories":
      return {
        from: t.editor.passCategoriesFrom,
        to: t.editor.passCategoriesTo,
        incomplete: t.editor.passCategoriesIncomplete,
        tooMany: t.editor.passCategoriesTooMany(MAX_PASS_CATEGORIES),
        tentative: t.editor.passCategoriesTentative,
        calendar: t.editor.passCategoriesCalendar,
      }[problem.reason];
    case "direction":
      if (problem.field === "onlyCategories") return t.editor.onlyCategoriesDirection;
      if (problem.field === "passCategories") return t.editor.passCategoriesDirection;
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
