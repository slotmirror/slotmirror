import { useI18n } from "../../../i18n";
import { PublicLayout } from "../public-layout";

/** The text for an administrator, shown in a field that the visitor can copy. */
export interface AdminRequest {
  title: string;
  text: string;
}

export interface OAuthErrorProps {
  title: string;
  lead: string;
  /** More text below the lead, e.g. what to do next. */
  steps?: string;
  /** Safe code (see `oauth-errors.ts`), never provider text. */
  code: string | null;
  reference: string;
  /** Link to the troubleshooting page, with the anchor of the code if it has one. */
  helpHref: string;
  retryHref: string;
  request?: AdminRequest;
}

/**
 * A provider error with a code instead of the provider's text. The way out is the button; the
 * code and the reference stay small and muted below, because only support needs them. The copy
 * button needs the page script; without it the field is still selectable.
 */
export function OAuthErrorPage(props: OAuthErrorProps) {
  const { t } = useI18n();
  return (
    <PublicLayout title={props.title} lead={props.lead}>
      {props.steps ? <p class="pub-text">{props.steps}</p> : null}
      {props.request ? (
        <div class="pub-request">
          <h2 class="pub-subtitle">{props.request.title}</h2>
          <textarea
            id="admin-request"
            class="input pub-mono"
            readonly
            rows={11}
            aria-label={props.request.title}
          >
            {props.request.text}
          </textarea>
          <div>
            <button
              type="button"
              class="btn btn-secondary"
              data-copy="admin-request"
              data-copied={t.oauthError.copied}
              data-needs-script
            >
              {t.oauthError.copy}
            </button>
          </div>
        </div>
      ) : null}
      <div class="pub-actions">
        <a class="btn btn-primary" href={props.retryHref}>
          {t.oauthError.tryAgain}
        </a>
        <a class="btn btn-secondary" href="/">
          {t.oauthError.back}
        </a>
      </div>
      <section class="pub-details" aria-label={t.next.auth.error.details}>
        <dl class="pub-facts pub-facts-small">
          {props.code ? (
            <>
              <dt>{t.oauthError.codeLabel}</dt>
              <dd>
                <code>{props.code}</code>
              </dd>
            </>
          ) : null}
          <dt>{t.oauthError.referenceLabel}</dt>
          <dd>
            <code>{props.reference}</code>
          </dd>
        </dl>
        <a class="link pub-small" href={props.helpHref} target="_blank" rel="noopener noreferrer">
          {t.oauthError.help}
        </a>
      </section>
    </PublicLayout>
  );
}
