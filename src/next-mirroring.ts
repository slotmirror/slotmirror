import {
  CHOICES,
  EditorConflict,
  MAX_CATEGORY_LENGTH,
  MAX_PASS_CATEGORIES,
  levelOf,
  loadEditorState,
  passCategoriesFor,
  requestSyncs,
  ruleDetailsProblem,
  setDefaultBlockTitle,
  setDirections,
  setRuleDetails,
  setSettings,
  type DirectionDetails,
  type EditorAccount,
  type PassPair,
  type RuleDetails,
  type RuleDetailsProblem,
} from "./editor";
import type { Messages } from "./i18n";
import { levelFromFields } from "./pages/next/mirroring";
import { directionLevel, marksMixed, marksPrivate } from "./pages/next/levels";
import {
  categoryNames,
  formText,
  onlyCategoriesField,
  passPairsFromForm,
  ruleDetailsError,
  settingsFrom,
} from "./form";
import { hasWorkingHours } from "./sync/working-hours";
import type { CurrentUser } from "./users";
import { directionVersion, isStale, settingsVersion } from "./versions";

/**
 * Saves of the mirroring page of the redesign. They call the functions of the old editor, so that
 * validation, the check for changes made meanwhile and the audit log stay the same.
 */

/** A form field that a refusal is about, so that the panel can show the reason at the field. */
export type MirroringField = "blockColor" | "onlyCategories" | "passCategories" | "who";

/**
 * The end of a save. A refusal names its reason in the user's words, and the field if one field
 * caused it. A conflict stored nothing: another tab or device changed what the panel showed after
 * it was drawn (the form's version `v` differs), or changed a rule while this save ran.
 */
export type MirroringSave =
  | { ok: true }
  | { ok: false; error: string; field?: MirroringField }
  | { ok: false; conflict: true };

const SAVED: MirroringSave = { ok: true };
const CONFLICT: MirroringSave = { ok: false, conflict: true };

function refuse(error: string, field?: MirroringField): MirroringSave {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/** A refused detail: at its field if the person can fix it there, else for the whole panel. */
function detailsRefusal(
  t: Messages,
  problem: RuleDetailsProblem,
  source: EditorAccount | undefined,
  target: EditorAccount,
): MirroringSave {
  const text = t.next.mirroring.fieldErrors;
  if (problem.kind === "color") {
    if (problem.problem === "comma") return refuse(text.categoryComma, "blockColor");
    if (problem.problem === "tooLong") {
      return refuse(text.categoryTooLong(MAX_CATEGORY_LENGTH), "blockColor");
    }
    return refuse(text.colorInvalid, "blockColor");
  }
  if (problem.kind === "onlyCategories") return refuse(text.onlyGoogle, "onlyCategories");
  if (problem.kind === "passCategories") {
    // The side that does not fit: a Google colour comes from a list, a name is typed.
    const side = problem.reason === "from" ? source : problem.reason === "to" ? target : undefined;
    const reason =
      problem.reason === "incomplete"
        ? text.passIncomplete
        : problem.reason === "tooMany"
          ? text.passTooMany(MAX_PASS_CATEGORIES)
          : side?.provider === "google"
            ? text.colorInvalid
            : text.passName(MAX_CATEGORY_LENGTH);
    return refuse(reason, "passCategories");
  }
  return refuse(ruleDetailsError(t, problem));
}

/**
 * One mirroring: its level and its details in one request. The two questions of the panel ("what
 * is copied", "who sees it") map to one `Level`. Only fields that differ from the stored value are
 * written, so that a save of a form without changes writes nothing.
 *
 * Level and details go into one write batch (`setDirections` with `details`), or the details alone
 * into one (`setRuleDetails`). So a refused or failed write stores nothing of the save, and a wider
 * level never runs without the filter saved with it. A save that would write nothing for a change
 * the user asked for, for example into a calendar that slotmirror cannot write, is refused too, so
 * that the page never says "Saved" for it.
 */
export async function saveMirroring(
  env: Env,
  user: CurrentUser,
  form: FormData,
  t: Messages,
): Promise<MirroringSave> {
  const text = t.next.mirroring;
  const from = formText(form, "from");
  const to = formText(form, "to");
  const state = await loadEditorState(env, user.id);
  const direction = state.directions.find((d) => d.from === from && d.to === to);
  const source = state.accounts.find((account) => account.id === from);
  const target = state.accounts.find((account) => account.id === to);
  if (!direction || !target) return refuse(t.editor.choiceInvalid);
  // Before any other check: a refusal of a stale form would show values that are not stored.
  if (isStale(form, directionVersion(state, direction))) return CONFLICT;

  const copy = form.get("copy");
  const who = form.get("who");
  const level =
    typeof copy === "string"
      ? levelFromFields(copy, typeof who === "string" ? who : undefined)
      : null;
  if (typeof copy === "string" && !level) return refuse(t.editor.choiceInvalid);
  // Calendars of the source with both marks: a copied level needs an explicit answer to "What
  // others see", since it applies to each of them. The form does not ask the browser for it, so
  // that "Not copied" saves without one also without script.
  if (
    level &&
    level.choice !== "off" &&
    marksMixed(direction) &&
    who !== "private" &&
    who !== "open"
  ) {
    const source = state.accounts.find((account) => account.id === from)?.name ?? from;
    return refuse(text.fieldErrors.whoRequired(source), "who");
  }
  const current = directionLevel(state, direction);
  const next = level
    ? levelOf(level.choice, level.markPrivate ?? marksPrivate(state, direction))
    : current;
  // On a mirroring whose calendars carry both marks, the level shows the open one, so an answer to
  // "What others see" can match it and still change the private calendars: it is always a change.
  const levelChanged =
    level !== null && (next !== current || (level.choice !== "off" && marksMixed(direction)));
  if (levelChanged && level.choice !== "off") {
    if (target.calendar?.canEdit !== true) return refuse(text.notSaved.readOnly(target.name));
    if (CHOICES.indexOf(level.choice) > CHOICES.indexOf(direction.maxChoice)) {
      return refuse(text.notSaved.cap(text.copyOptions[direction.maxChoice]));
    }
  }

  const details: DirectionDetails = {};
  if (next !== "off") {
    const options = direction.options;
    if (form.has("blockColor")) {
      const value = formText(form, "blockColor").trim();
      if (value !== (options?.blockColor ?? "")) details.blockColor = value;
    }
    if (form.has("workHoursShown")) {
      const on = form.get("workHours") === "1";
      if (on !== (options !== null && hasWorkingHours(options))) details.workHours = on;
    }
    if (form.has("onlyCategoriesShown")) {
      const names = categoryNames(onlyCategoriesField(form));
      const stored = options?.onlyCategories ?? [];
      if (names.join("\n") !== stored.join("\n")) details.onlyCategories = names;
    }
    if (form.has("passCategoriesShown") && source) {
      const pairs = passCategoriesOf(form, source, target, options?.passCategories ?? []);
      if (pairs) details.passCategories = pairs;
    }
  }
  const ruleDetails: RuleDetails = {
    ...(details.blockColor === undefined
      ? {}
      : { colors: [{ from, to, value: details.blockColor }] }),
    ...(details.workHours === undefined
      ? {}
      : { workHours: [{ from, to, on: details.workHours }] }),
    ...(details.onlyCategories === undefined
      ? {}
      : { onlyCategories: [{ from, to, names: details.onlyCategories }] }),
    ...(details.passCategories === undefined
      ? {}
      : { passCategories: [{ from, to, pairs: details.passCategories }] }),
  };
  const problem = ruleDetailsProblem(state, ruleDetails);
  if (problem) return detailsRefusal(t, problem, source, target);

  const hasDetails = Object.keys(ruleDetails).length > 0;
  // A level can create the user's first rule, which gets the block title in the user's language.
  // The statement never replaces a stored title; the state tells when it has nothing to do.
  // The writers take the state that was checked against `v`: their guards then refuse a rule that
  // changed after the check, not only one that changed after a read of their own.
  let checked = state;
  if (levelChanged && state.rules.length === 0 && state.settings.blockTitleStored === false) {
    await setDefaultBlockTitle(env, user.id, t.editor.defaultBlockTitle);
    checked = {
      ...state,
      settings: {
        ...state.settings,
        blockTitle: t.editor.defaultBlockTitle,
        blockTitleStored: true,
      },
    };
  }
  const syncs = new Set<string>();
  try {
    if (levelChanged) {
      const written = new Set<string>();
      await setDirections(env, user, [{ from, to, ...level, details }], syncs, written, checked);
      if (!written.has(`${from}>${to}`)) return refuse(text.notSaved.gone);
    } else if (hasDetails) {
      await setRuleDetails(env, user, ruleDetails, syncs, checked);
    }
  } catch (error) {
    // One batch: a conflict stored nothing of this save.
    if (error instanceof EditorConflict) return CONFLICT;
    throw error;
  } finally {
    await requestSyncs(env, syncs);
  }
  return SAVED;
}

/**
 * The carried categories of the form, or null if they match the stored ones. A list that
 * `passCategoriesFor` refuses is returned as it is, so that the check refuses the save. Between two
 * calendars of one provider the form lists names only: a stored target of a name (from the batch
 * path) stays with the name, so that a save of the panel never drops it.
 */
function passCategoriesOf(
  form: FormData,
  source: EditorAccount,
  target: EditorAccount,
  stored: readonly PassPair[],
): PassPair[] | null {
  const pairs = passPairsFromForm(form, source.provider, target.provider).map((pair) => {
    if (source.provider !== target.provider) return pair;
    const kept = stored.find((entry) => entry.from.toLowerCase() === pair.from.toLowerCase());
    return kept ? { from: pair.from, to: kept.to } : pair;
  });
  const checked = passCategoriesFor(source.provider, target.provider, pairs);
  if ("problem" in checked) return pairs;
  // A Google event has one colour, so the order of the boxes says nothing: the panel draws them in
  // the order of the palette, which need not be the stored one.
  const key = (list: readonly PassPair[]) => {
    const entries = list.map((pair) => JSON.stringify([pair.from, pair.to]));
    return (
      source.provider === "google" && target.provider === "google" ? entries.sort() : entries
    ).join();
  };
  return key(checked.pairs) === key(stored) ? null : checked.pairs;
}

/**
 * The settings for all mirrorings, as the old settings card sends them. The save stores the block
 * title of the form, which is the one the page showed, so a first save needs no default before it.
 * A form with a version `v` costs one more read, of the editor state, to compare it; a form
 * without one (the old settings card) saves as before.
 */
export async function saveAllMirrorings(
  env: Env,
  user: CurrentUser,
  form: FormData,
  t: Messages,
): Promise<MirroringSave> {
  const checked = form.has("v") ? await loadEditorState(env, user.id) : undefined;
  if (checked && isStale(form, settingsVersion(checked))) return CONFLICT;
  try {
    // With a checked state, the write refuses rules or settings that changed after the check.
    await setSettings(
      env,
      user,
      settingsFrom(form, t.editor.defaultBlockTitle),
      undefined,
      undefined,
      checked,
    );
  } catch (error) {
    // `setSettings` writes in one batch: a conflict stored nothing of this save.
    if (error instanceof EditorConflict) return CONFLICT;
    throw error;
  }
  return SAVED;
}
