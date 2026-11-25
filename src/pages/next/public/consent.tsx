import { useI18n } from "../../../i18n";
import { GRANT_DAYS } from "../../../mcp-oauth";
import type { CurrentUser } from "../../../users";
import { Notice, Tag } from "../components";
import { PublicLayout } from "../public-layout";
import { BrandMark } from "../shell";

/** A check mark in front of what the app may read. Neutral: it is no sign that the app is safe. */
function Check() {
  return (
    <svg
      class="pub-check"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * The app and slotmirror, joined. The tile shows the first letter or digit of the name, never a
 * symbol or emoji: the name is unchecked, so the tile must not look like a verified badge. The
 * logo is the large mark, so its id differs from the small one in the header.
 */
function AppPair(props: { appName: string }) {
  const initial = (props.appName.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  return (
    <div class="pub-pair" aria-hidden="true">
      <span class="pub-tile is-app">{initial}</span>
      <span class="pub-pair-link" />
      <span class="pub-tile">
        <BrandMark size={28} />
      </span>
    </div>
  );
}

/**
 * The question whether an app may read the user's slotmirror data. The app named itself when it
 * registered, so the page says that the name is unchecked and shows where the answer goes. It is
 * a step outside the app, so it has no navigation, like the sign-in page.
 */
export function ConsentPage(props: {
  user: CurrentUser;
  appName: string;
  returnsTo: string;
  /** This request's path. "Not you?" signs out and opens it again, so it waits for the sign-in. */
  resume: string;
  ticket: string;
  /** Offer a box that also lets the app read calendar events. It starts unticked. */
  offerEvents?: boolean;
}) {
  const { t } = useI18n();
  const text = t.next.auth.consent;
  const name = props.appName || t.consent.unnamed;
  const decision = (held: boolean) => (
    <>
      <input type="hidden" name="ticket" value={props.ticket} />
      {props.offerEvents ? <EventsChoice /> : null}
      <button type="submit" name="decision" value="allow" class="btn btn-primary" disabled={held}>
        {t.consent.allow}
      </button>
      <button type="submit" name="decision" value="deny" class="btn btn-secondary" disabled={held}>
        {t.consent.deny}
      </button>
    </>
  );
  return (
    <PublicLayout
      title={t.consent.title}
      lead={t.consent.asks(name)}
      mark={<AppPair appName={props.appName} />}
      // The page has no account menu, so the footer carries the language switch. Its links reload
      // this request with ?lang=, as on the sign-in page.
      languageSwitch
    >
      <dl class="pub-facts">
        <dt>{text.app}</dt>
        <dd class="pub-break">{name}</dd>
        <dt>{text.returnsTo}</dt>
        <dd class="pub-break pub-mono">{props.returnsTo}</dd>
      </dl>
      <h2 class="pub-subtitle pub-can-title">
        {t.consent.readsLabel}
        <Tag>{t.consent.readOnly}</Tag>
      </h2>
      <ul class="pub-checks">
        {text.can.map((line) => (
          <li>
            <Check />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <p class="pub-text">{text.lasts(GRANT_DAYS)}</p>
      <Notice kind="warn">
        {props.offerEvents ? t.consent.uncheckedWithEvents : t.consent.unchecked}
      </Notice>
      <form method="post" action="/auth/logout" class="pub-account">
        <input type="hidden" name="resume" value={props.resume} />
        <span class="pub-break">{t.consent.signedInAs(props.user.email)}</span>{" "}
        <span class="pub-switch">
          {t.consent.notYou}{" "}
          <button type="submit" class="pub-link">
            {t.next.shell.user.signOut}
          </button>
        </span>
      </form>
      {/* Served off: the script turns the buttons on once the page was seen, so that a click
          meant for another window lands on nothing. Without a script, the noscript form decides;
          the stylesheet hides the held form until the script has run. */}
      <form method="post" action="/oauth/authorize" class="pub-actions" data-hold>
        {decision(true)}
      </form>
      <noscript>
        <form method="post" action="/oauth/authorize" class="pub-actions">
          {decision(false)}
        </form>
      </noscript>
    </PublicLayout>
  );
}

/** The box that also lets the app read calendar events. Each of the two forms carries its own. */
function EventsChoice() {
  const { t } = useI18n();
  return (
    <label class="pub-opt-in">
      <input type="checkbox" name="events" value="1" />
      <span>{t.consent.events}</span>
    </label>
  );
}
