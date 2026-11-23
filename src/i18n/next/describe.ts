import type { AuditKind, CleanupResult } from "../../audit";
import type { Choice } from "../../editor";
import type { CompareFailureReason } from "../../sync/compare";
import { formatCount } from "./overview";

const nEn = (count: number) => formatCount(count, "en");
const nDe = (count: number) => formatCount(count, "de");

/**
 * Strings that describe audit rows in plain language: one sentence per kind, the detail lines, and
 * the changes list. `describeActivity` and `changeEntries` in `src/pages/next/describe.ts` read
 * them for the overview, the activity page and the admin page. The English object defines the
 * shape; the German one must match it. `en.ts` and `de.ts` wire both under `next.describe`.
 */
export const describeEn = {
  changes: {
    title: "Changes, last 24 h",
    all: "All activity",
    empty: "Nothing changed in the last 24 hours.",
    /** The list covers less than 24 hours: it ends at `time`; Activity has the rest. */
    cut: (time: string) => `Changes since ${time}. Older ones are in All activity.`,
    created: (count: number) => `${nEn(count)} new`,
    updated: (count: number) => `${nEn(count)} changed`,
    removed: (count: number) => `${nEn(count)} removed`,
    failed: (count: number) => `${nEn(count)} not written`,
    times: (count: number) => `${nEn(count)} times`,
    allMirrorings: "All mirrorings",
    choices: {
      off: "Not copied",
      busy: "Busy only",
      title: "Title",
      full: "Everything",
    } satisfies Record<Choice, string>,
    now: (level: string) => `Now: ${level}`,
    /** The level changes of a mirroring in the changes list, with the newest level. */
    levelChanged: (count: number, level: string) =>
      count === 1 ? `Now: ${level}` : `Changed ${nEn(count)}× · now: ${level}`,
    /** Level changes of a mirroring that ended where they started. */
    levelBack: (level: string, count: number) => `Back to ${level} after ${nEn(count)} changes`,
    /**
     * A time in which others saw more of a mirroring's copies than before. `what` names what they
     * saw; the time is a range, one minute, a start without an end in the rows shown, or an end
     * whose start lies before the rows shown.
     */
    exposure: {
      what: {
        "busy-open": "Copies visible to others",
        "title-open": "Titles visible to others",
        "full-open": "Details visible to others",
      },
      range: (what: string, from: string, until: string) => `${what} ${from}–${until}`,
      at: (what: string, time: string) => `${what} at ${time}`,
      from: (what: string, time: string) => `${what} from ${time}`,
      until: (what: string, time: string) => `${what} until ${time}`,
      /** A start without an end in the rows, but the copies show less now: it ended later. */
      fromEnded: (what: string, time: string) => `${what} from ${time}, ended later`,
      /** A start whose rule was paused without a removal of its copies (the old rules page). */
      fromKept: (what: string, time: string, target?: string) =>
        target
          ? `${what} from ${time}, paused; copies may still be in ${target}`
          : `${what} from ${time}, paused`,
      /** A start whose mirroring went without a known removal of its copies. */
      fromRemoved: (what: string, time: string, target?: string) =>
        target
          ? `${what} from ${time}, then removed; copies may still be in ${target}`
          : `${what} from ${time}, then removed`,
      /** A range whose end is on another day; `until` carries its date (see `dated`). */
      rangeDays: (what: string, from: string, until: string) => `${what} ${from} – ${until}`,
      /** A time of yesterday, in a list of the last 24 hours. */
      yesterday: (time: string) => `yesterday ${time}`,
      /** A time with its short date, such as "Nov 21, 08:30". */
      dated: (date: string, time: string) => `${date}, ${time}`,
    },
    /** A rule went, but the removal of its copies could not be queued. */
    copiesLeft: (target: string) => `copies may still be in ${target}`,
    added: (level: string) => `Added: ${level}`,
    deleted: "Removed",
    enabled: "Turned on",
    paused: "Paused",
    hours: "Working hours changed",
    colour: "Colour of the copies changed",
    categories: (count: number) =>
      count === 0 ? "All categories" : count === 1 ? "Only 1 category" : `Only ${count} categories`,
    buffer: (before: string, after: string) => `Buffer ${before} min before, ${after} min after`,
    changed: "Changed",
    settings: "Settings for all mirrorings changed",
    connected: "Connected",
    disconnected: "Disconnected",
    renamed: "Renamed",
  },
  activity: {
    noChanges: "No changes",
    changes: (created: number, updated: number, removed: number) =>
      [
        created > 0 ? `${nEn(created)} new` : "",
        updated > 0 ? `${nEn(updated)} changed` : "",
        removed > 0 ? `${nEn(removed)} removed` : "",
      ]
        .filter(Boolean)
        .join(", "),
    route: (from: string, to: string) => `${from} to ${to}`,
    routeFailed: (from: string, to: string) => `${from} to ${to} failed`,
    routeStopped: (from: string, to: string) => `${from} to ${to} stopped early`,
    routeChanged: (from: string, to: string) => `${from} to ${to} changed`,
    routeAdded: (from: string, to: string) => `${from} to ${to} added`,
    routeOff: (from: string, to: string) => `${from} to ${to} turned off`,
    /** The title of a turned off mirroring in a list that shows only this mirroring. */
    turnedOff: "Mirroring turned off",
    /** A row whose kind this version does not know, for example from a removed feature. */
    otherKind: "Other entry",
    /** A calendar whose account was disconnected: its name is gone with it. */
    goneCalendar: "a disconnected calendar",
    kinds: {
      sign_in: () => "You signed in",
      sign_in_refused: () => "A sign-in was refused",
      sign_in_reset: () => "Sign-in unlinked",
      sign_out: () => "You signed out",
      account_connected: (name) => (name ? `${name} connected` : "A calendar was connected"),
      account_disconnected: (name) =>
        name ? `${name} disconnected` : "A calendar was disconnected",
      account_disconnect_failed: (name) =>
        name ? `Disconnecting ${name} failed` : "Disconnecting a calendar failed",
      cleanup_finished: (name) =>
        name ? `Removal of copies from ${name} finished` : "Removal of copies finished",
      account_renamed: (name) => (name ? `${name} was renamed` : "A calendar was renamed"),
      token_refresh_failed: (name) =>
        name
          ? `The connection to ${name} could not be renewed`
          : "A connection could not be renewed",
      rule_created: () => "Mirroring added",
      rule_deleted: () => "Mirroring removed",
      rule_enabled: () => "Mirroring turned on",
      rule_paused: () => "Mirroring paused",
      rule_updated: () => "Mirroring changed",
      group_changed: () => "Mirroring changed",
      settings_changed: () => "Settings for all mirrorings changed",
      user_deleted: () => "A person was deleted",
      sync_run: (name) => (name ? `Run for ${name}` : "Run finished"),
      sync_failed: (name) => (name ? `Run for ${name} failed` : "A run failed"),
      sync_run_aborted: (name) => (name ? `Run for ${name} stopped early` : "A run stopped early"),
      account_paused: (name) =>
        name ? `${name}: connection lost` : "A calendar lost its connection",
      account_resumed: (name) => (name ? `${name} reconnected` : "A calendar was reconnected"),
      alert_sent: () => "The operator was alerted",
      alert_test: () => "A test alert was requested",
      compare_run: (name) => (name ? `Comparison of ${name} finished` : "A comparison finished"),
      compare_failed: (name) => (name ? `Comparison of ${name} failed` : "A comparison failed"),
      api_token_created: () => "API token created",
      api_token_revoked: () => "API token revoked",
      mcp_app_connected: () => "App connected",
      mcp_app_disconnected: () => "App disconnected",
      mcp_policy_changed: () => "App access for members changed",
    } satisfies Record<AuditKind, (name: string | null) => string>,
    /** The detail line of a row: what its audit entry records, in the words of the glossary. */
    detail: {
      preview: (changes: string) => `Preview ${changes}`,
      throttled: (count: number) => `${nEn(count)} throttled, retried after the wait`,
      remaining: (count: number) => `${nEn(count)} left`,
      statuses: (list: string) => `HTTP ${list}`,
      /**
       * A run whose instance stopped before it wrote its outcome: the platform ended it at a CPU or
       * subrequest limit, or the outcome could not be written (`writeAbortEvents` in
       * `src/account-sync.ts`). The next run repairs what it left.
       */
      abortedExplain:
        "The run ended before it could record a result: the server stopped it, usually at a time or request limit. The next run starts on its own and can repair the copies. If this keeps happening, tell the person who runs slotmirror.",
      disconnectFailed:
        "Disconnecting failed and the calendar stays connected. Its mirrorings run again and write back any copy that was removed.",
      alerts: {
        rule_silent: "A mirroring had no successful run",
        run_aborted: "A run ended without a result",
        check_blind: "The hourly check could not read the mirrorings",
        compare_deviation: "A comparison confirmed deviations",
      },
      cleanupRemoved: (count: number) =>
        count === 1 ? "1 copy removed" : `${nEn(count)} copies removed`,
      cleanupLeft: (count: number) => (count === 1 ? "1 copy left" : `${nEn(count)} copies left`),
      cleanupAbout: (count: number) =>
        count === 1 ? "about 1 copy left" : `about ${nEn(count)} copies left`,
      cleanupReasons: {
        incomplete: "the provider kept failing, delete the rest by hand",
        token_refused: "the provider refused the connection, delete the rest by hand",
        no_tokens: "the connection is gone, delete the rest by hand",
        deadline: "the calendar was not reconnected in time, delete the rest by hand",
        not_started:
          "the state of the removal is not known, reconnecting can still finish it, otherwise delete the rest by hand",
        kept: "the removal could not start, and the mirroring keeps its copies",
      } satisfies Record<Exclude<CleanupResult, "removed">, string>,
      compareClean: (count: number) =>
        count === 1 ? "No deviation in 1 copy" : `No deviation in ${nEn(count)} copies`,
      compareFound: (missing: number, surplus: number, mismatched: number, duplicates: number) =>
        `${nEn(missing)} missing, ${nEn(surplus)} left over, ${nEn(mismatched)} different, ${nEn(duplicates)} doubled`,
      compareCleared: (count: number, found: string) =>
        `${nEn(count)} found, then gone after a run (${found})`,
      compareUnconfirmed: (count: number) => `${nEn(count)} found once, not confirmed`,
      compareCapped: "list cut off",
      compareNothing: "Nothing to compare: no copy wanted, none found",
      compareNoLeftovers: "No copy left over",
      compareReasons: {
        removal_queue: "Copies are still being removed from this calendar",
        token_lost: "A calendar lost its connection",
        paused: "A calendar lost its connection",
        throttled: "The provider throttled the read",
        config_changed: "A mirroring changed during the comparison",
        source_unavailable: "A source calendar cannot be read any more",
        read_failed: "A calendar could not be read",
        slice_too_large: "One day holds too many events to compare",
        empty_horizon: "The time windows are too short to compare",
        timeout: "The comparison did not end within a day",
        superseded: "A comparison of the whole window replaced this one",
        owner_not_admitted: "The owner of this calendar no longer has access",
      } satisfies Record<CompareFailureReason, string>,
    },
  },
};

export type DescribeMessages = typeof describeEn;

export const describeDe: DescribeMessages = {
  changes: {
    title: "Änderungen, letzte 24 Std.",
    all: "Alle Aktivitäten",
    empty: "In den letzten 24 Stunden hat sich nichts geändert.",
    cut: (time) => `Änderungen seit ${time}. Ältere findest du unter Alle Aktivitäten.`,
    created: (count) => `${nDe(count)} neu`,
    updated: (count) => `${nDe(count)} geändert`,
    removed: (count) => `${nDe(count)} entfernt`,
    failed: (count) => `${nDe(count)} nicht geschrieben`,
    times: (count) => `${nDe(count)}-mal`,
    allMirrorings: "Alle Spiegelungen",
    choices: {
      off: "Nicht kopiert",
      busy: "Nur belegt",
      title: "Titel",
      full: "Alles",
    },
    now: (level) => `Jetzt: ${level}`,
    levelChanged: (count, level) =>
      count === 1 ? `Jetzt: ${level}` : `${nDe(count)}× geändert · jetzt: ${level}`,
    levelBack: (level, count) => `Nach ${nDe(count)} Änderungen wieder ${level}`,
    exposure: {
      what: {
        "busy-open": "Kopien für andere sichtbar",
        "title-open": "Titel für andere sichtbar",
        "full-open": "Details für andere sichtbar",
      },
      range: (what, from, until) => `${what} ${from}–${until}`,
      at: (what, time) => `${what} um ${time}`,
      from: (what, time) => `${what} ab ${time}`,
      until: (what, time) => `${what} bis ${time}`,
      fromEnded: (what, time) => `${what} ab ${time}, später beendet`,
      fromKept: (what, time, target) =>
        target
          ? `${what} ab ${time}, pausiert; Kopien können noch in ${target} stehen`
          : `${what} ab ${time}, pausiert`,
      fromRemoved: (what, time, target) =>
        target
          ? `${what} ab ${time}, dann entfernt; Kopien können noch in ${target} stehen`
          : `${what} ab ${time}, dann entfernt`,
      rangeDays: (what, from, until) => `${what} ${from} – ${until}`,
      yesterday: (time) => `gestern ${time}`,
      dated: (date, time) => `${date} ${time}`,
    },
    copiesLeft: (target) => `Kopien können noch in ${target} stehen`,
    added: (level) => `Hinzugefügt: ${level}`,
    deleted: "Entfernt",
    enabled: "Eingeschaltet",
    paused: "Pausiert",
    hours: "Arbeitszeit geändert",
    colour: "Farbe der Kopien geändert",
    categories: (count) =>
      count === 0 ? "Alle Kategorien" : count === 1 ? "Nur 1 Kategorie" : `Nur ${count} Kategorien`,
    buffer: (before, after) => `Puffer ${before} Min. davor, ${after} Min. danach`,
    changed: "Geändert",
    settings: "Einstellungen für alle Spiegelungen geändert",
    connected: "Verbunden",
    disconnected: "Getrennt",
    renamed: "Umbenannt",
  },
  activity: {
    noChanges: "Keine Änderungen",
    changes: (created, updated, removed) =>
      [
        created > 0 ? `${nDe(created)} neu` : "",
        updated > 0 ? `${nDe(updated)} geändert` : "",
        removed > 0 ? `${nDe(removed)} entfernt` : "",
      ]
        .filter(Boolean)
        .join(", "),
    route: (from, to) => `${from} nach ${to}`,
    routeFailed: (from, to) => `${from} nach ${to} fehlgeschlagen`,
    routeStopped: (from, to) => `${from} nach ${to} vorzeitig beendet`,
    routeChanged: (from, to) => `${from} nach ${to} geändert`,
    routeAdded: (from, to) => `${from} nach ${to} hinzugefügt`,
    routeOff: (from, to) => `${from} nach ${to} ausgeschaltet`,
    turnedOff: "Spiegelung ausgeschaltet",
    otherKind: "Anderer Eintrag",
    goneCalendar: "ein getrennter Kalender",
    kinds: {
      sign_in: () => "Du hast dich angemeldet",
      sign_in_refused: () => "Eine Anmeldung wurde abgelehnt",
      sign_in_reset: () => "Anmeldung gelöst",
      sign_out: () => "Du hast dich abgemeldet",
      account_connected: (name) => (name ? `${name} verbunden` : "Ein Kalender wurde verbunden"),
      account_disconnected: (name) => (name ? `${name} getrennt` : "Ein Kalender wurde getrennt"),
      account_disconnect_failed: (name) =>
        name ? `${name} konnte nicht getrennt werden` : "Ein Kalender konnte nicht getrennt werden",
      cleanup_finished: (name) =>
        name ? `Entfernen der Kopien aus ${name} beendet` : "Entfernen der Kopien beendet",
      account_renamed: (name) =>
        name ? `${name} wurde umbenannt` : "Ein Kalender wurde umbenannt",
      token_refresh_failed: (name) =>
        name
          ? `Die Verbindung zu ${name} konnte nicht erneuert werden`
          : "Eine Verbindung konnte nicht erneuert werden",
      rule_created: () => "Spiegelung hinzugefügt",
      rule_deleted: () => "Spiegelung entfernt",
      rule_enabled: () => "Spiegelung eingeschaltet",
      rule_paused: () => "Spiegelung pausiert",
      rule_updated: () => "Spiegelung geändert",
      group_changed: () => "Spiegelung geändert",
      settings_changed: () => "Einstellungen für alle Spiegelungen geändert",
      user_deleted: () => "Eine Person wurde gelöscht",
      sync_run: (name) => (name ? `Lauf für ${name}` : "Lauf beendet"),
      sync_failed: (name) =>
        name ? `Lauf für ${name} fehlgeschlagen` : "Ein Lauf ist fehlgeschlagen",
      sync_run_aborted: (name) =>
        name ? `Lauf für ${name} vorzeitig beendet` : "Ein Lauf endete vorzeitig",
      account_paused: (name) =>
        name
          ? `${name}: Verbindung unterbrochen`
          : "Bei einem Kalender ist die Verbindung unterbrochen",
      account_resumed: (name) =>
        name ? `${name} wieder verbunden` : "Ein Kalender ist wieder verbunden",
      alert_sent: () => "Der Betreiber wurde benachrichtigt",
      alert_test: () => "Ein Testalarm wurde angefordert",
      compare_run: (name) =>
        name ? `Vergleich von ${name} beendet` : "Ein Vergleich wurde beendet",
      compare_failed: (name) =>
        name ? `Vergleich von ${name} fehlgeschlagen` : "Ein Vergleich ist fehlgeschlagen",
      api_token_created: () => "API-Token erstellt",
      api_token_revoked: () => "API-Token widerrufen",
      mcp_app_connected: () => "App verbunden",
      mcp_app_disconnected: () => "App getrennt",
      mcp_policy_changed: () => "App-Zugriff für Mitglieder geändert",
    },
    detail: {
      preview: (changes) => `Vorschau ${changes}`,
      throttled: (count) => `${nDe(count)} gedrosselt, neuer Versuch nach der Wartezeit`,
      remaining: (count) => `${nDe(count)} offen`,
      statuses: (list) => `HTTP ${list}`,
      abortedExplain:
        "Der Lauf endete, bevor er ein Ergebnis speichern konnte: Der Server hat ihn beendet, meist an einer Zeit- oder Anfragegrenze. Der nächste Lauf startet von selbst und kann die Kopien reparieren. Wenn das öfter passiert, sag es der Person, die slotmirror betreibt.",
      disconnectFailed:
        "Das Trennen ist gescheitert, der Kalender bleibt verbunden. Seine Spiegelungen laufen wieder und schreiben entfernte Kopien zurück.",
      alerts: {
        rule_silent: "Eine Spiegelung hatte keinen erfolgreichen Lauf",
        run_aborted: "Ein Lauf endete ohne Ergebnis",
        check_blind: "Die stündliche Prüfung konnte die Spiegelungen nicht lesen",
        compare_deviation: "Ein Vergleich hat Abweichungen bestätigt",
      },
      cleanupRemoved: (count) =>
        count === 1 ? "1 Kopie entfernt" : `${nDe(count)} Kopien entfernt`,
      cleanupLeft: (count) => (count === 1 ? "1 Kopie übrig" : `${nDe(count)} Kopien übrig`),
      cleanupAbout: (count) =>
        count === 1 ? "etwa 1 Kopie übrig" : `etwa ${nDe(count)} Kopien übrig`,
      cleanupReasons: {
        incomplete: "der Anbieter antwortet weiter mit Fehlern, lösche den Rest von Hand",
        token_refused: "der Anbieter lehnt die Verbindung ab, lösche den Rest von Hand",
        no_tokens: "die Verbindung fehlt, lösche den Rest von Hand",
        deadline: "der Kalender wurde nicht rechtzeitig neu verbunden, lösche den Rest von Hand",
        not_started:
          "der Stand der Entfernung ist nicht bekannt, ein neues Verbinden kann sie noch abschließen, sonst lösche den Rest von Hand",
        kept: "die Entfernung konnte nicht starten, die Spiegelung behält ihre Kopien",
      },
      compareClean: (count) =>
        count === 1 ? "Keine Abweichung in 1 Kopie" : `Keine Abweichung in ${nDe(count)} Kopien`,
      compareFound: (missing, surplus, mismatched, duplicates) =>
        `${nDe(missing)} fehlen, ${nDe(surplus)} übrig, ${nDe(mismatched)} abweichend, ${nDe(duplicates)} doppelt`,
      compareCleared: (count, found) =>
        `${nDe(count)} gefunden, nach einem Lauf nicht mehr da (${found})`,
      compareUnconfirmed: (count) => `${nDe(count)} einmal gefunden, nicht bestätigt`,
      compareCapped: "Liste gekürzt",
      compareNothing: "Nichts zu vergleichen: keine Kopie gewünscht, keine gefunden",
      compareNoLeftovers: "Keine Kopie übrig",
      compareReasons: {
        removal_queue: "Aus diesem Kalender werden noch Kopien entfernt",
        token_lost: "Bei einem Kalender ist die Verbindung unterbrochen",
        paused: "Bei einem Kalender ist die Verbindung unterbrochen",
        throttled: "Der Anbieter hat das Lesen gedrosselt",
        config_changed: "Eine Spiegelung wurde während des Vergleichs geändert",
        source_unavailable: "Ein Quellkalender ist nicht mehr lesbar",
        read_failed: "Ein Kalender konnte nicht gelesen werden",
        slice_too_large: "Ein Tag enthält zu viele Termine für den Vergleich",
        empty_horizon: "Die Zeiträume sind für einen Vergleich zu kurz",
        timeout: "Der Vergleich endete nicht innerhalb eines Tages",
        superseded: "Ein Vergleich des ganzen Zeitraums hat diesen abgelöst",
        owner_not_admitted: "Der Inhaber dieses Kalenders hat keinen Zugang mehr",
      },
    },
  },
};
