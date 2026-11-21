import { appPath } from "../../app-base";
import {
  DAILY_TOOL_CALLS,
  DEFAULT_TOKEN_DAYS,
  MAX_TOKEN_NAME_LENGTH,
  MAX_TOKENS_PER_USER,
  TOKEN_DAYS,
  type ApiToken,
} from "../../api-tokens";
import { useI18n } from "../../i18n";
import type { ConnectedApp } from "../../mcp-oauth";
import type { CurrentUser } from "../../users";
import { ConfirmStep, DangerSection, SecretField } from "./admin-parts";
import {
  EmptyState,
  ListGroup,
  ListRow,
  Notice,
  Panel,
  PropertyRow,
  Section,
  Segmented,
  StatusDot,
  Tag,
} from "./components";
import { Shell, type ShellAttention } from "./shell";

/** The address of a view of the tokens page: a token, an app or the form for a new token. */
export function tokensHref(
  view: { k?: string; a?: string; confirm?: "revoke" | "disconnect"; new?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (view.k) params.set("k", view.k);
  else if (view.a) params.set("a", view.a);
  else if (view.new) params.set("new", "1");
  if ((view.k || view.a) && view.confirm) params.set("confirm", view.confirm);
  const text = params.toString();
  return text ? `${appPath("/tokens")}?${text}` : appPath("/tokens");
}

export interface TokensProps {
  user: CurrentUser;
  /** Nav dots, from the user's own state and outcomes. */
  attention?: ShellAttention;
  tokens: ApiToken[];
  apps: ConnectedApp[];
  endpoint: string;
  /** False while the org has MCP off for members: the lists stay, the form goes. */
  canCreate: boolean;
  /** The token whose panel is open, from `?k=`; validated against the user's own tokens. */
  selectedToken?: ApiToken;
  /** The app whose panel is open, from `?a=`; validated against the user's own grants. */
  selectedApp?: ConnectedApp;
  confirm?: "revoke" | "disconnect";
  /** Show the form for a new token (`?new=1`). */
  creating?: boolean;
  /** A new token. Only the answer to the POST that made it holds this. */
  created?: string;
  /** Why a token was not created, shown in the form's panel. */
  problem?: string;
  /** What the user typed into the form after a refusal. */
  draft?: { name: string; days: number };
}

function Plus() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** API tokens and connected apps of the signed-in user, with a detail panel. */
export function TokensPage(props: TokensProps) {
  const { t, formatDate, formatRelative, formatTimestamp } = useI18n();
  const text = t.next.tokens;
  const now = Date.now();
  const expired = (token: ApiToken) => Date.parse(token.expiresAt) <= now;

  let panel;
  if (props.created !== undefined) panel = <CreatedPanel {...props} secret={props.created} />;
  else if (props.selectedToken) panel = <TokenPanel {...props} token={props.selectedToken} />;
  else if (props.selectedApp) panel = <AppPanel {...props} app={props.selectedApp} />;
  else if (props.creating && props.canCreate) panel = <NewPanel {...props} />;

  return (
    <Shell
      title={text.title}
      user={props.user}
      attention={props.attention}
      active="tokens"
      width="narrow"
      actions={
        props.canCreate ? (
          <a class="btn btn-secondary" href={tokensHref({ new: true })}>
            <Plus />
            {text.newToken}
          </a>
        ) : undefined
      }
      panel={panel}
      styles={["/next/admin.css"]}
    >
      <div class="adm">
        <p class="muted adm-intro">{text.intro}</p>
        {props.canCreate ? null : (
          <div class="adm-notices">
            <Notice kind="info">{text.membersOff}</Notice>
          </div>
        )}
        {props.tokens.length === 0 ? (
          <EmptyState title={text.tokensEmpty} text={text.tokensEmptyText}>
            {props.canCreate ? (
              <a class="btn btn-secondary" href={tokensHref({ new: true })}>
                <Plus />
                {text.newToken}
              </a>
            ) : null}
          </EmptyState>
        ) : (
          <div class="list adm-list">
            <ListGroup
              title={text.tokensLabel}
              hint={text.tokensHint(props.endpoint)}
              label={text.tokensLabel}
            >
              {props.tokens.map((token) => {
                const isSelected = props.selectedToken?.id === token.id;
                return (
                  <ListRow
                    selected={isSelected}
                    title={
                      <a
                        class="row-open"
                        href={tokensHref({ k: token.id })}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={text.openToken(token.name)}
                      >
                        {token.name}
                      </a>
                    }
                    meta={<code>{`…${token.lastFour}`}</code>}
                    tags={
                      <Tag>
                        {expired(token) ? text.expired : text.expires(formatDate(token.expiresAt))}
                      </Tag>
                    }
                    status={
                      <>
                        <StatusDot tone={expired(token) ? "idle" : "ok"} label={false} />
                        {token.lastUsedAt ? (
                          <span class="num" title={formatTimestamp(token.lastUsedAt)}>
                            {text.lastUsed(formatRelative(token.lastUsedAt))}
                          </span>
                        ) : (
                          <span>{text.neverUsed}</span>
                        )}
                      </>
                    }
                  />
                );
              })}
            </ListGroup>
          </div>
        )}

        <div class="list adm-list adm-apps">
          <ListGroup title={text.appsLabel} hint={text.appsHint} label={text.appsLabel}>
            {props.apps.map((app) => {
              const name = app.name || text.unnamedApp;
              const isSelected = props.selectedApp?.id === app.id;
              return (
                <ListRow
                  selected={isSelected}
                  title={
                    <a
                      class="row-open"
                      href={tokensHref({ a: app.id })}
                      aria-current={isSelected ? "true" : undefined}
                      aria-label={text.openApp(name)}
                    >
                      {name}
                    </a>
                  }
                  meta={text.connectedAt(formatDate(app.createdAt))}
                  status={
                    app.refreshedAt ? (
                      <span class="num" title={formatTimestamp(app.refreshedAt)}>
                        {text.refreshedAt(formatRelative(app.refreshedAt))}
                      </span>
                    ) : (
                      <span>{text.neverRefreshed}</span>
                    )
                  }
                />
              );
            })}
          </ListGroup>
          {props.apps.length === 0 ? (
            <p class="muted adm-empty adm-apps-empty">{text.appsEmpty}</p>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

/** The form for a new token: name and lifetime, one button. */
function NewPanel(props: TokensProps) {
  const { t } = useI18n();
  const text = t.next.tokens;
  const days = props.draft?.days ?? DEFAULT_TOKEN_DAYS;
  const common = t.next.shell.common;
  return (
    <Panel
      title={text.createTitle}
      closeHref={tokensHref()}
      form={{ action: appPath("/tokens"), saveMode: "foreground" }}
      footer={
        // The bar stays open (`data-forced`): a new token is the one change of this form.
        <div
          class="savebar"
          data-savebar
          data-forced
          data-one={common.changesOne}
          data-many={common.changesMany}
        >
          <div class="savebar-notes" role="status">
            <div class="savebar-note-list" />
          </div>
          <span class="savebar-text num" data-count />
          <button type="button" class="btn btn-ghost" data-discard hidden>
            {common.discard}
          </button>
          <button type="submit" class="btn btn-primary" data-save data-label={text.create}>
            {text.create}
          </button>
        </div>
      }
    >
      {props.problem ? (
        <div class="adm-notices">
          <Notice kind="danger">{props.problem}</Notice>
        </div>
      ) : null}
      <Section>
        <PropertyRow label={text.name} for="token-name" stacked hint={text.nameHint}>
          <input
            class="input"
            id="token-name"
            type="text"
            name="name"
            required
            maxlength={MAX_TOKEN_NAME_LENGTH}
            value={props.draft?.name ?? ""}
            autocomplete="off"
          />
        </PropertyRow>
        {/* Radios, not a select: the panel script counts a select as changed from the start. */}
        <PropertyRow label={text.lifetime}>
          <Segmented
            name="days"
            label={text.lifetime}
            value={String(days)}
            options={TOKEN_DAYS.map((option) => ({
              value: String(option),
              label: text.days(option),
            }))}
          />
        </PropertyRow>
        <p class="prop-hint adm-hint">{text.limitsHint(MAX_TOKENS_PER_USER, DAILY_TOOL_CALLS)}</p>
      </Section>
    </Panel>
  );
}

/**
 * The new token, in the answer to the POST that made it. No later page shows it: the store holds
 * only a hash. The command for Claude Code carries the token too, so it is as secret as the token.
 */
function CreatedPanel(props: TokensProps & { secret: string }) {
  const { t } = useI18n();
  const text = t.next.tokens;
  const command = `claude mcp add --transport http slotmirror ${props.endpoint} --header "Authorization: Bearer ${props.secret}"`;
  return (
    <Panel title={text.createdTitle} closeHref={tokensHref()} escape="off">
      <Section>
        <p class="confirm-text">{text.createdHint}</p>
        <SecretField
          id="token-secret"
          label={text.tokenLabel}
          value={props.secret}
          copy={text.copy}
          copied={text.copied}
        />
      </Section>
      <Section>
        <SecretField
          id="token-command"
          label={text.claudeCode}
          value={command}
          copy={text.copy}
          copied={text.copied}
        />
      </Section>
      <Section>
        <a class="btn btn-primary" href={tokensHref()}>
          {text.done}
        </a>
      </Section>
    </Panel>
  );
}

function TokenPanel(props: TokensProps & { token: ApiToken }) {
  const { t, formatTimestamp, formatDate } = useI18n();
  const text = t.next.tokens;
  const { token } = props;
  const here = tokensHref({ k: token.id });
  if (props.confirm === "revoke") {
    return (
      <Panel title={text.confirmRevokeTitle(token.name)} closeHref={here}>
        <Section>
          <ConfirmStep
            action={`${appPath("/tokens")}/${encodeURIComponent(token.id)}/revoke`}
            back={appPath("/tokens")}
            sentence={text.confirmRevoke(token.name)}
            button={text.confirmRevokeButton}
            cancel={text.cancel}
            cancelHref={here}
          />
        </Section>
      </Panel>
    );
  }
  const ended = Date.parse(token.expiresAt) <= Date.now();
  return (
    <Panel title={token.name} closeHref={tokensHref()}>
      <Section title={text.sectionToken}>
        <PropertyRow label={text.name}>{token.name}</PropertyRow>
        <PropertyRow label={text.endsInLabel}>
          <code>{`…${token.lastFour}`}</code>
        </PropertyRow>
        <PropertyRow label={text.access}>{text.readOnly}</PropertyRow>
        <PropertyRow label={text.created}>
          <span class="num">{formatDate(token.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={text.expiresLabel}>
          <span class="num">{ended ? text.expired : formatTimestamp(token.expiresAt)}</span>
        </PropertyRow>
        <PropertyRow label={text.lastUsedLabel}>
          <span class="num">
            {token.lastUsedAt ? formatTimestamp(token.lastUsedAt) : text.never}
          </span>
        </PropertyRow>
        <PropertyRow label={text.endpoint} stacked>
          <code class="adm-endpoint">{props.endpoint}</code>
        </PropertyRow>
      </Section>
      <DangerSection
        title={text.sectionRevoke}
        hint={text.revokeHint}
        label={text.revoke}
        href={tokensHref({ k: token.id, confirm: "revoke" })}
      />
    </Panel>
  );
}

function AppPanel(props: TokensProps & { app: ConnectedApp }) {
  const { t, formatTimestamp } = useI18n();
  const text = t.next.tokens;
  const { app } = props;
  const name = app.name || text.unnamedApp;
  const here = tokensHref({ a: app.id });
  if (props.confirm === "disconnect") {
    return (
      <Panel title={text.confirmDisconnectTitle(name)} closeHref={here}>
        <Section>
          <ConfirmStep
            action={`${appPath("/tokens")}/apps/${encodeURIComponent(app.id)}/revoke`}
            back={appPath("/tokens")}
            sentence={text.confirmDisconnect(name)}
            button={text.confirmDisconnectButton}
            cancel={text.cancel}
            cancelHref={here}
          />
        </Section>
      </Panel>
    );
  }
  return (
    <Panel title={name} closeHref={tokensHref()}>
      <Section title={text.sectionApp}>
        <PropertyRow label={text.app}>{name}</PropertyRow>
        <PropertyRow label={text.access}>{text.readOnly}</PropertyRow>
        <PropertyRow label={text.connected}>
          <span class="num">{formatTimestamp(app.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={text.refreshed}>
          <span class="num">
            {app.refreshedAt ? formatTimestamp(app.refreshedAt) : text.neverRefreshed}
          </span>
        </PropertyRow>
      </Section>
      <DangerSection
        title={text.disconnect}
        hint={text.disconnectHint}
        label={text.disconnect}
        href={tokensHref({ a: app.id, confirm: "disconnect" })}
      />
    </Panel>
  );
}
