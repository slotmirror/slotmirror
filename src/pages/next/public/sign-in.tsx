import { PROVIDER_LABEL, type Provider } from "../../../config";
import { useI18n } from "../../../i18n";
import { ProviderGlyph } from "../identity";
import { PublicLayout } from "../public-layout";
import { OperatorNotice } from "./operator-notice";

function enabledProviders(providers: Record<Provider, boolean>): Provider[] {
  return (Object.keys(PROVIDER_LABEL) as Provider[]).filter((provider) => providers[provider]);
}

/**
 * The page that a visitor sees. One sentence about what slotmirror does, the sign-in buttons as
 * equal choices, and the Google hint folded under the Google choice.
 */
export function SignInPage(props: {
  providers: Record<Provider, boolean>;
  /** The operator's notice; shown before the first sign-in link. */
  operatorNotice?: string;
}) {
  const { t } = useI18n();
  return (
    <PublicLayout title={t.signIn.title} lead={t.next.auth.signIn.lead} languageSwitch>
      <OperatorNotice text={props.operatorNotice} />
      <div class="pub-providers" role="group" aria-label={t.next.auth.signIn.options}>
        {enabledProviders(props.providers).map((provider) => (
          <div class="pub-provider-item">
            <a class="btn btn-secondary pub-provider" href={`/auth/${provider}/login`}>
              <ProviderGlyph provider={provider} />
              {t.signIn.withProvider(PROVIDER_LABEL[provider])}
            </a>
            {provider === "google" ? (
              <details class="pub-google-note">
                <summary>{t.next.auth.signIn.googleWarning}</summary>
                <p class="pub-hint">{t.next.calendars.googleHint}</p>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      <p class="pub-fine">{t.next.auth.signIn.fineprint}</p>
    </PublicLayout>
  );
}
