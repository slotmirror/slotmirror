import { useI18n } from "../../../i18n";
import { GRANT_DAYS } from "../../../mcp-oauth";
import type { CurrentUser } from "../../../users";
import { Notice } from "../components";
import { PublicLayout } from "../public-layout";

/**
 * The question whether an app may read the user's slotmirror data. The app named itself when it
 * registered, so the page says that the name is unchecked and shows where the answer goes.
 */
export function ConsentPage(props: {
  user: CurrentUser;
  appName: string;
  returnsTo: string;
  ticket: string;
}) {
  const { t } = useI18n();
  const text = t.next.auth.consent;
  const name = props.appName || t.consent.unnamed;
  return (
    <PublicLayout title={t.consent.title} lead={t.consent.asks(name)} user={props.user}>
      <dl class="pub-facts">
        <dt>{text.app}</dt>
        <dd class="pub-break">{name}</dd>
        <dt>{text.returnsTo}</dt>
        <dd class="pub-break pub-mono">{props.returnsTo}</dd>
      </dl>
      <h2 class="pub-subtitle">{text.canTitle}</h2>
      <ul class="pub-bullets">
        {text.can.map((line) => (
          <li>{line}</li>
        ))}
      </ul>
      <p class="pub-text">{text.lasts(GRANT_DAYS)}</p>
      <Notice kind="warn">{t.consent.unchecked}</Notice>
      {/* Served off: the script turns the buttons on once the page was seen, so that a click
          meant for another window lands on nothing. Without a script, the noscript form decides;
          the stylesheet hides the held form until the script has run. */}
      <form method="post" action="/oauth/authorize" class="pub-actions" data-hold>
        <input type="hidden" name="ticket" value={props.ticket} />
        <button type="submit" name="decision" value="allow" class="btn btn-primary" disabled>
          {t.consent.allow}
        </button>
        <button type="submit" name="decision" value="deny" class="btn btn-secondary" disabled>
          {t.consent.deny}
        </button>
      </form>
      <noscript>
        <form method="post" action="/oauth/authorize" class="pub-actions">
          <input type="hidden" name="ticket" value={props.ticket} />
          <button type="submit" name="decision" value="allow" class="btn btn-primary">
            {t.consent.allow}
          </button>
          <button type="submit" name="decision" value="deny" class="btn btn-secondary">
            {t.consent.deny}
          </button>
        </form>
      </noscript>
    </PublicLayout>
  );
}
