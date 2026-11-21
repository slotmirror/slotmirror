import { useI18n } from "../../../i18n";
import type { CurrentUser } from "../../../users";
import { PageFrame } from "./frame";

/** A short notice with one way out: a button back to the start page. */
export function MessagePage(props: {
  title: string;
  message: string;
  user?: CurrentUser | null;
  /** Replaces the default way out (the start page), for example on the 404 page. */
  back?: { href: string; label: string };
}) {
  const { t } = useI18n();
  return (
    <PageFrame title={props.title} user={props.user}>
      <p class="pub-text">{props.message}</p>
      <div class="pub-actions">
        <a class="btn btn-primary" href={props.back?.href ?? "/"}>
          {props.back?.label ?? t.messages.back}
        </a>
      </div>
    </PageFrame>
  );
}
