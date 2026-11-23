import { appPath } from "../../../app-base";
import { useI18n } from "../../../i18n";
import type { CurrentUser } from "../../../users";
import { PageFrame } from "./frame";

/**
 * Confirmation before an account is disconnected. The POST to the same path does the work. The
 * cancel link returns to the calendar's panel, where the user started.
 */
export function DisconnectPage(props: {
  user: CurrentUser;
  accountId: string;
  email: string;
  /** Rules that use the account as source or target. */
  rules: number;
}) {
  const { t } = useI18n();
  const text = t.next.auth.disconnect;
  return (
    <PageFrame title={text.title} user={props.user} nav="calendars">
      <p class="pub-text">{text.text(props.email)}</p>
      <p class="pub-text">{text.mirrorings(props.rules)}</p>
      <form class="pub-actions" method="post" action={`/accounts/${props.accountId}/disconnect`}>
        <button type="submit" class="btn btn-danger">
          {text.confirm}
        </button>
        <a
          class="btn btn-secondary"
          href={`${appPath("/calendars")}?c=${encodeURIComponent(props.accountId)}`}
        >
          {text.cancel}
        </a>
      </form>
    </PageFrame>
  );
}
