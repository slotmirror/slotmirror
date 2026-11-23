import type { AccountWorkHours } from "../../editor";
import type { Messages } from "../../i18n";
import { ALL_WEEKDAYS } from "../../sync/working-hours";

/**
 * Working hours in a few words, with the short weekday names of the language ("Mon–Fri 08:00–18:00",
 * "Mo–Fr 08:00–18:00"). Weekdays in a row join with a dash, other days are listed. Without times
 * the days stand alone; without a weekday filter, "every day".
 */
export function hoursText(t: Messages, hours: AccountWorkHours): string {
  const days = [...hours.workDays].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && run.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  const name = (day: number) => t.next.shell.weekdays[day - 1] ?? "";
  const dayText =
    days.length === ALL_WEEKDAYS.length
      ? t.editor.everyDay
      : runs
          .map((run) =>
            run.length > 2
              ? `${name(run[0] ?? 1)}–${name(run.at(-1) ?? 1)}`
              : run.map(name).join(", "),
          )
          .join(", ");
  const timeText = hours.workStart ? `${hours.workStart}–${hours.workEnd}` : t.editor.allDay;
  return `${dayText} ${timeText}`;
}
