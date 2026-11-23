import {
  directionMarksPrivate,
  levelOf,
  type EditorDirection,
  type EditorState,
  type Level,
} from "../../editor";

/** The direction from one account to another, or undefined if the state has none. */
export function directionOf(
  state: EditorState,
  from: string,
  to: string,
): EditorDirection | undefined {
  return state.directions.find((direction) => direction.from === from && direction.to === to);
}

/**
 * True if the copies of a direction carry the private mark: only if every enabled rule of it does,
 * so that a mixed direction shows the more visible state. A direction that is off shows the user's
 * default, which a bare choice would give it.
 */
export function marksPrivate(state: EditorState, direction: EditorDirection): boolean {
  return directionMarksPrivate(direction) ?? state.settings.markPrivate;
}

/**
 * True if the enabled rules of a direction carry both marks: some copy as private events, others
 * as they are. The panel then preselects no answer to "What others see" and asks for one, because
 * the answer applies to every rule of the direction (see `setDirections`).
 */
export function marksMixed(direction: EditorDirection): boolean {
  const marks = new Set(
    direction.slots.flatMap((slot) => (slot.rule?.enabled ? [slot.rule.options.markPrivate] : [])),
  );
  return marks.size > 1;
}

/** The level that a direction has now, after the org caps. */
export function directionLevel(state: EditorState, direction: EditorDirection): Level {
  return levelOf(direction.effective, marksPrivate(state, direction));
}

/** What the owner sees at a level: 0 nothing, 1 busy, 2 title, 3 everything. */
const YOURS: Record<Level, number> = {
  off: 0,
  "busy-private": 1,
  "busy-open": 1,
  "title-private": 2,
  "title-open": 2,
  "full-private": 3,
  "full-open": 3,
};

/**
 * What everyone else with access to the target sees: 0 nothing, 1 a private busy time, 2 the
 * copy's own title ("Busy" or the user's title), 3 the event's title, 4 everything.
 */
const OTHERS: Record<Level, number> = {
  off: 0,
  "busy-private": 1,
  "title-private": 1,
  "full-private": 1,
  "busy-open": 2,
  "title-open": 3,
  "full-open": 4,
};

/**
 * What a change of level does to who sees what. "more": someone sees more than before. "widens":
 * others with access to the target see what they did not see before, and the panel gives that
 * case a warning and names it on the Save button:
 * - titles or details of events, from any level;
 * - any copy that is not private, from "Not copied": a mirroring that is turned on takes the
 *   default answer to "What others see", so the person must be told before the save.
 * Busy for everyone from a copied level shows only the copy's own title, so it is "more".
 * Otherwise "none".
 */
export function changeEffect(before: Level, after: Level): "none" | "more" | "widens" {
  const more = YOURS[after] > YOURS[before] || OTHERS[after] > OTHERS[before];
  if (!more) return "none";
  if (before === "off" && OTHERS[after] >= 2) return "widens";
  return OTHERS[after] >= 3 && OTHERS[after] > OTHERS[before] ? "widens" : "more";
}

/**
 * What others see after a save that shows them less. "busy": the copy with its own title;
 * "titles": the titles of the events, both for a lower level that stays visible to others.
 * "private": an open copy becomes private again, so others see a private event (Microsoft) or
 * "busy" (Google) where they saw more. Null for every other change, also for "Not copied".
 */
export function stillSeen(before: Level, after: Level): "busy" | "titles" | "private" | null {
  if (!before.endsWith("-open") || OTHERS[after] >= OTHERS[before]) return null;
  if (after === "busy-open") return "busy";
  if (after === "title-open") return "titles";
  if (after.endsWith("-private")) return "private";
  return null;
}
