import { useI18n } from "../../../i18n";
import { Notice } from "../components";

/**
 * The operator's notice. Render it once on a page, before the first link that connects an
 * account. Empty text renders nothing.
 */
export function OperatorNotice(props: { text?: string }) {
  const { t } = useI18n();
  if (!props.text) return null;
  return (
    <Notice kind="info" title={t.accounts.operatorNoticeTitle}>
      <p class="pub-notice-text">{props.text}</p>
      <a class="link" href="/privacy">
        {t.accounts.operatorNoticeLink}
      </a>
    </Notice>
  );
}
