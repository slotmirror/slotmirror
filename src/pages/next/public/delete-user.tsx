import { useI18n } from "../../../i18n";
import type { CurrentUser } from "../../../users";
import { PageFrame } from "./frame";

/**
 * Confirmation before a user is deleted: by themselves ("Delete my data") or by an admin. The POST
 * to `action` does the work.
 */
export function DeleteUserPage(props: {
  user: CurrentUser;
  /** The user who goes; null when users delete themselves. */
  target: { email: string; accounts: number } | null;
  ownAccounts: number;
  action: string;
  cancel: string;
}) {
  const { t } = useI18n();
  const text = t.next.auth.deleteUser;
  const accounts = props.target ? props.target.accounts : props.ownAccounts;
  const title = props.target ? text.titleOther(props.target.email) : text.titleSelf;
  return (
    <PageFrame title={title} user={props.user} nav={props.target ? "admin" : undefined}>
      <p class="pub-text">{text.intro}</p>
      <ul class="pub-bullets">
        <li>{text.calendars(accounts)}</li>
        <li>{text.mirrorings}</li>
        <li>{text.copies}</li>
        <li>{text.person}</li>
      </ul>
      <p class="pub-text">{text.activityStays}</p>
      <form class="pub-actions" method="post" action={props.action}>
        <button type="submit" class="btn btn-danger">
          {props.target ? text.confirmOther : text.confirmSelf}
        </button>
        <a class="btn btn-secondary" href={props.cancel}>
          {text.cancel}
        </a>
      </form>
    </PageFrame>
  );
}
