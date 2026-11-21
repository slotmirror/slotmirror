import type { Child } from "hono/jsx";
import type { SetupStatus } from "../../../config";
import { useI18n } from "../../../i18n";
import { Notice, StatusDot } from "../components";
import { PublicLayout } from "../public-layout";

const QUICKSTART_URL = "https://slotmirror.com/docs/quickstart/";

/**
 * A value to set or a command to run, shown as code with a copy button. It is a read-only input
 * without input chrome: selectable without script, and the copy button of `public.js` selects and
 * reads its value. `size` fits it to the value where `field-sizing` is not supported.
 */
function CopyField(props: { id: string; label: string; value: string }) {
  const { t } = useI18n();
  const text = t.next.auth.setup;
  return (
    <div class="pub-copy">
      <input
        id={props.id}
        class="pub-code pub-mono"
        readonly
        size={props.value.length}
        value={props.value}
        aria-label={props.label}
      />
      <button
        type="button"
        class="btn btn-ghost"
        data-copy={props.id}
        data-copied={text.copied}
        data-needs-script
      >
        {text.copy}
      </button>
    </div>
  );
}

/** One step of the checklist. A finished step shows only its title; an open one says what to do. */
function Step(props: {
  number: number;
  ok: boolean;
  title: string;
  /** The names to set. Groups are alternatives, shown with "or" between them. */
  names: string[][];
  hint: string;
  /** A command that makes the value, with its own copy field. */
  command?: string;
}) {
  const { t } = useI18n();
  const text = t.next.auth.setup;
  const id = `setup-step-${props.number}`;
  return (
    <li class={props.ok ? "pub-step is-done" : "pub-step"}>
      <span class="pub-step-no num" aria-hidden="true">
        {props.number}
      </span>
      <div class="pub-step-main">
        <div class="pub-step-head">
          <h3 class="pub-step-title">{props.title}</h3>
          <span class="pub-step-state">
            <StatusDot tone={props.ok ? "ok" : "warn"} label={false} />
            {props.ok ? text.done : text.todo}
          </span>
        </div>
        {props.ok ? null : (
          <div class="pub-step-body">
            <p class="pub-text">{props.hint}</p>
            <dl class="pub-facts pub-facts-stack">
              <dt>{text.variablesLabel}</dt>
              <dd>
                {props.names.map((group, index) => (
                  <>
                    {index > 0 ? <span class="pub-or">{text.or}</span> : null}
                    {group.map((name) => (
                      <CopyField id={`${id}-${name}`} label={name} value={name} />
                    ))}
                  </>
                ))}
              </dd>
              {props.command ? (
                <>
                  <dt>{text.commandLabel}</dt>
                  <dd>
                    <CopyField
                      id={`${id}-command`}
                      label={text.commandLabel}
                      value={props.command}
                    />
                  </dd>
                </>
              ) : null}
              <dt>{text.whereLabel}</dt>
              <dd>{text.where}</dd>
            </dl>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Shown until the deployment has everything it needs. A checklist with one step per check of the
 * old page. It lists names only, never values.
 */
export function SetupPage(props: { status: SetupStatus }) {
  const { status } = props;
  const { t } = useI18n();
  const text = t.next.auth.setup;
  const steps: { ok: boolean; node: (number: number) => Child }[] = [
    {
      ok: status.accessConfigured,
      node: (number) => (
        <Step
          number={number}
          ok={status.accessConfigured}
          title={text.steps.access}
          names={[["ALLOWED_EMAILS"], ["ALLOWED_DOMAINS"], ["ADMIN_EMAILS"]]}
          hint={text.hints.access}
        />
      ),
    },
    {
      ok: status.sessionSecret,
      node: (number) => (
        <Step
          number={number}
          ok={status.sessionSecret}
          title={text.steps.session}
          names={[["SESSION_SECRET"]]}
          hint={text.hints.session}
          command="openssl rand -base64 48"
        />
      ),
    },
    {
      ok: status.tokenEncryptionKey,
      node: (number) => (
        <Step
          number={number}
          ok={status.tokenEncryptionKey}
          title={text.steps.key}
          names={[["TOKEN_ENCRYPTION_KEY"]]}
          hint={text.hints.key}
          command="openssl rand -base64 32"
        />
      ),
    },
    {
      ok: status.signIn,
      node: (number) => (
        <Step
          number={number}
          ok={status.signIn}
          title={text.steps.provider}
          names={[
            ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
            ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
          ]}
          hint={
            status.unknownSignInEntries.length > 0
              ? text.hints.providerInvalid(status.unknownSignInEntries.join(","))
              : text.hints.provider
          }
        />
      ),
    },
  ];
  const done = steps.filter((step) => step.ok).length;
  return (
    <PublicLayout title={text.title} lead={text.lead} languageSwitch>
      <p class="pub-progress num">{text.progress(done, steps.length)}</p>
      <ol class="pub-steps">{steps.map((step, index) => step.node(index + 1))}</ol>
      <Notice kind="info">{text.jurisdictionNote}</Notice>
      <div class="pub-actions">
        <a
          class="btn btn-secondary"
          href={QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {text.docsLink}
        </a>
      </div>
      <p class="pub-hint">{text.next}</p>
    </PublicLayout>
  );
}
