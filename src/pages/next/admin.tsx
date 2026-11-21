import { appPath } from "../../app-base";
import type { TestAlertOutcome } from "../../alerts";
import { parseDetail, type ActivityRow } from "../../audit";
import { parseRuleOptions } from "../../config";
import type { DetailCaps } from "../../detail-policy";
import type { EditorState } from "../../editor";
import { useI18n } from "../../i18n";
import type { AdminUser } from "../../next-admin";
import { can, type McpForMembers } from "../../permissions";
import type { CompareRunDetail } from "../../sync/compare";
import type { CurrentUser } from "../../users";
import { ActivityRowItem, groupActivity } from "./activity";
import { activityHref } from "./activity-link";
import { describeCompareDetail } from "./describe";
import { BackField, ConfirmStep, DangerSection, DoneNote } from "./admin-parts";
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

export const ADMIN_TABS = ["people", "access", "health"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** Rows of the log on the health tab; the old page shows all of them. */
export const ADMIN_ACTIVITY_ROWS = 10;

/** What a finished action of a panel says. */
export type AdminDone = "reset" | "revoked" | "deleted";

export function parseAdminTab(value: string | undefined): AdminTab {
  return ADMIN_TABS.find((tab) => tab === value) ?? "people";
}

export function parseAdminDone(value: string | undefined): AdminDone | undefined {
  return (["reset", "revoked", "deleted"] as const).find((done) => done === value);
}

/** The address of an admin view: a tab, or the panel of one person, optionally its confirmation. */
export function adminHref(
  view: { tab?: AdminTab; u?: string; confirm?: "delete"; done?: AdminDone } = {},
): string {
  const params = new URLSearchParams();
  if (view.u) params.set("u", view.u);
  else if (view.tab && view.tab !== "people") params.set("tab", view.tab);
  if (view.u && view.confirm) params.set("confirm", view.confirm);
  if (view.done) params.set("done", view.done);
  const text = params.toString();
  return text ? `${appPath("/admin")}?${text}` : appPath("/admin");
}

export interface AdminProps {
  user: CurrentUser;
  tab: AdminTab;
  /** People tab. */
  users?: AdminUser[];
  /** The person whose panel is open, from `?u=`; validated against the org. */
  selected?: AdminUser;
  confirm?: "delete";
  done?: AdminDone;
  /** Access tab. */
  caps?: DetailCaps;
  org?: { domains: string[]; tenantCount: number };
  /** The org's MCP setting; null while the deployment has MCP off. */
  mcpForMembers?: McpForMembers | null;
  saved?: boolean;
  invalidChoice?: boolean;
  /** Health tab. */
  compares?: ActivityRow[];
  compareStart?: { started: number; open: number; failed: number } | null;
  alertsConfigured?: boolean;
  testAlert?: TestAlertOutcome | null;
  activity?: ActivityRow[];
  /**
   * The signed-in admin's calendars and mirrorings. The log names calendars and mirrorings from
   * it, as the Activity page does; without it the rows use the generic words.
   */
  state?: EditorState;
  /** Calendars with blocks of deleted people, on every tab. */
  cleanups: number;
  /** Nav dots, from the admin's own state and outcomes. */
  attention?: ShellAttention;
}

/** A state with no calendars, for a log without the admin's own state: names stay generic. */
const NO_STATE: EditorState = {
  accounts: [],
  directions: [],
  settings: parseRuleOptions("{}"),
  others: [],
  rules: [],
};

function Tabs(props: { active: AdminTab }) {
  const { t } = useI18n();
  const text = t.next.admin;
  return (
    <nav class="adm-tabs" aria-label={text.tabsLabel}>
      <span class="seg">
        {ADMIN_TABS.map((tab) =>
          tab === props.active ? (
            <a class="seg-item" href={adminHref({ tab })} aria-current="page">
              {text.tabs[tab]}
            </a>
          ) : (
            <a class="seg-item" href={adminHref({ tab })}>
              {text.tabs[tab]}
            </a>
          ),
        )}
      </span>
    </nav>
  );
}

/** The admin page: People, Access, Health. The person's panel is addressed by `?u=`. */
export function AdminPage(props: AdminProps) {
  const { t } = useI18n();
  const text = t.next.admin;
  const selected = props.tab === "people" ? props.selected : undefined;
  return (
    <Shell
      title={text.title}
      user={props.user}
      attention={props.attention}
      active="admin"
      actions={<Tabs active={props.tab} />}
      panel={
        selected ? (
          <PersonPanel
            user={props.user}
            person={selected}
            confirm={props.confirm}
            done={props.done}
          />
        ) : undefined
      }
      styles={
        props.tab === "health" ? ["/next/admin.css", "/next/activity.css"] : ["/next/admin.css"]
      }
    >
      <div class="adm">
        <p class="muted adm-intro">{text.intro}</p>
        {props.cleanups > 0 ? (
          <div class="adm-notices">
            <Notice
              kind="warn"
              action={
                <a class="btn btn-secondary" href="/cleanup">
                  {text.cleanupsLink}
                </a>
              }
            >
              {text.cleanupsText(props.cleanups)}
            </Notice>
          </div>
        ) : null}
        {props.tab === "people" ? <PeopleTab {...props} /> : null}
        {props.tab === "access" ? <AccessTab {...props} /> : null}
        {props.tab === "health" ? <HealthTab {...props} /> : null}
      </div>
    </Shell>
  );
}

// People ---------------------------------------------------------------------------------------

function PeopleTab(props: AdminProps) {
  const { t, formatRelative, formatTimestamp } = useI18n();
  const text = t.next.admin;
  const users = props.users ?? [];
  const affected = users.filter((row) => row.needsReconnect > 0).length;
  return (
    <>
      {props.done === "deleted" ? (
        <div class="adm-notices">
          <DoneNote>{text.doneDeleted}</DoneNote>
        </div>
      ) : null}
      {affected > 0 ? (
        <div class="adm-notices">
          <Notice kind="warn">{text.reconnectSummary(affected)}</Notice>
        </div>
      ) : null}
      {users.length === 0 ? (
        <EmptyState title={text.peopleEmpty} text={text.addPeople} />
      ) : (
        <>
          <div class="list adm-list">
            <ListGroup title={text.peopleLabel} hint={text.peopleHint} label={text.peopleLabel}>
              {users.map((row) => {
                const isSelected = props.selected?.id === row.id;
                return (
                  <ListRow
                    selected={isSelected}
                    title={
                      <a
                        class="row-open"
                        href={adminHref({ u: row.id })}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={text.openPerson(row.email)}
                      >
                        {row.email}
                      </a>
                    }
                    tags={
                      <>
                        {row.role === "admin" ? <Tag>{t.roles.admin}</Tag> : null}
                        <Tag>{text.calendarsCount(row.accounts)}</Tag>
                        {row.apiTokens > 0 ? <Tag>{text.tokensCount(row.apiTokens)}</Tag> : null}
                      </>
                    }
                    status={
                      row.needsReconnect > 0 ? (
                        <>
                          <StatusDot tone="danger" label={false} />
                          <span class="is-danger">{text.needsReconnect(row.needsReconnect)}</span>
                        </>
                      ) : row.lastSignInAt ? (
                        <span class="num" title={formatTimestamp(row.lastSignInAt)}>
                          {text.signedIn(formatRelative(row.lastSignInAt))}
                        </span>
                      ) : (
                        <span>{text.neverSignedIn}</span>
                      )
                    }
                  />
                );
              })}
            </ListGroup>
          </div>
          <p class="muted adm-quiet">{text.addPeople}</p>
        </>
      )}
    </>
  );
}

/** The panel of one person: facts, the two reversible actions, and the removal. */
function PersonPanel(props: {
  user: CurrentUser;
  person: AdminUser;
  confirm?: "delete";
  done?: AdminDone;
}) {
  const { t, formatTimestamp } = useI18n();
  const text = t.next.admin;
  const { person } = props;
  const isSelf = person.id === props.user.id;
  const here = adminHref({ u: person.id });
  const manage = can(props.user, "users:manage") && !isSelf;

  if (manage && props.confirm === "delete") {
    return (
      <Panel title={text.confirmDeleteTitle(person.email)} closeHref={here}>
        <Section>
          <ConfirmStep
            action={`${appPath("/admin")}/users/${encodeURIComponent(person.id)}/delete`}
            back={adminHref({ done: "deleted" })}
            sentence={text.confirmDelete(person.email, person.accounts)}
            note={text.confirmDeleteNote}
            button={text.confirmDeleteButton}
            cancel={text.cancel}
            cancelHref={here}
          />
        </Section>
      </Panel>
    );
  }

  const doneText =
    props.done === "reset" ? text.doneReset : props.done === "revoked" ? text.doneRevoked : null;
  return (
    <Panel title={person.email} closeHref={adminHref()}>
      {doneText ? <DoneNote>{doneText}</DoneNote> : null}
      <Section title={text.sectionPerson}>
        <PropertyRow label={text.role}>{t.roles[person.role]}</PropertyRow>
        <PropertyRow label={text.calendars}>
          <span class="num">{person.accounts}</span>
        </PropertyRow>
        {person.needsReconnect > 0 ? (
          <PropertyRow label={text.reconnect}>
            <span class="num is-danger">{person.needsReconnect}</span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={text.lastSignIn}>
          <span class="num">
            {person.lastSignInAt ? formatTimestamp(person.lastSignInAt) : text.neverSignedIn}
          </span>
        </PropertyRow>
        <PropertyRow label={text.tokensAndApps}>
          <span class="num">{person.apiTokens > 0 ? person.apiTokens : text.none}</span>
        </PropertyRow>
      </Section>
      {isSelf ? (
        <Section>
          <p class="muted">{text.you}</p>
        </Section>
      ) : manage ? (
        <>
          <Section title={text.sectionSignIn}>
            <form
              method="post"
              action={`${appPath("/admin")}/users/${encodeURIComponent(person.id)}/reset-sign-in`}
            >
              <BackField to={adminHref({ u: person.id, done: "reset" })} />
              <button type="submit" class="btn btn-secondary">
                {text.resetSignIn}
              </button>
            </form>
            <p class="prop-hint adm-hint">{text.resetSignInHint}</p>
          </Section>
          <Section title={text.sectionApi}>
            {person.apiTokens > 0 ? (
              <>
                <form
                  method="post"
                  action={`${appPath("/admin")}/users/${encodeURIComponent(person.id)}/revoke-tokens`}
                >
                  <BackField to={adminHref({ u: person.id, done: "revoked" })} />
                  <button type="submit" class="btn btn-secondary">
                    {text.revokeTokens(person.apiTokens)}
                  </button>
                </form>
                <p class="prop-hint adm-hint">{text.revokeTokensHint}</p>
              </>
            ) : (
              <p class="muted">{text.noApiAccess}</p>
            )}
          </Section>
          <DangerSection
            title={text.sectionRemove}
            hint={text.deleteHint}
            label={text.deletePerson}
            href={adminHref({ u: person.id, confirm: "delete" })}
          />
        </>
      ) : null}
    </Panel>
  );
}

// Access -----------------------------------------------------------------------------------------

function AccessTab(props: AdminProps) {
  const { t } = useI18n();
  const text = t.next.admin;
  const caps = props.caps;
  const org = props.org ?? { domains: [], tenantCount: 0 };
  const orgList = [
    ...org.domains.map((domain) => `@${domain}`),
    ...(org.tenantCount > 0 ? [text.tenants(org.tenantCount)] : []),
  ];
  const capText = (level: DetailCaps["toExternal"]) =>
    level === "full" ? text.limitNone : text.limitAtMost(text.limitLevels[level]);
  const mcp = props.mcpForMembers;
  return (
    <div class="adm-blocks">
      <section class="adm-block">
        <h2 class="adm-title">{text.limitsTitle}</h2>
        <p class="muted adm-lead">{text.limitsLead}</p>
        <p class="adm-org">
          {orgList.length > 0 ? text.orgAccounts(orgList.join(", ")) : text.orgNone}
        </p>
        {caps ? (
          <div class="adm-props">
            <PropertyRow label={text.limitToExternal}>{capText(caps.toExternal)}</PropertyRow>
            <PropertyRow label={text.limitFromExternal}>{capText(caps.fromExternal)}</PropertyRow>
          </div>
        ) : null}
        <p class="muted adm-hint">{text.limitsHow}</p>
      </section>

      {mcp && can(props.user, "org:policy") ? (
        <section class="adm-block">
          <h2 class="adm-title">{text.mcpTitle}</h2>
          <p class="muted adm-lead">{text.mcpLead}</p>
          {props.invalidChoice ? <Notice kind="danger">{text.mcpInvalid}</Notice> : null}
          <form class="adm-form" method="post" action={`${appPath("/admin")}/mcp-policy`}>
            <BackField to={`${appPath("/admin")}?tab=access&saved=1`} />
            <Segmented
              name="mcpForMembers"
              label={text.mcpTitle}
              value={mcp}
              options={[
                { value: "off", label: text.mcpChoices.off },
                { value: "all", label: text.mcpChoices.all },
              ]}
            />
            <button type="submit" class="btn btn-primary">
              {text.save}
            </button>
            {props.saved ? <DoneNote>{text.saved}</DoneNote> : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}

// Health -----------------------------------------------------------------------------------------

function HealthTab(props: AdminProps) {
  const i18n = useI18n();
  const { t, formatRelative, formatTimestamp } = i18n;
  const text = t.next.admin;
  const compares = props.compares ?? [];
  // The same sentences and the same joining of quiet runs as the Activity page.
  const days = groupActivity(
    (props.activity ?? []).slice(0, ADMIN_ACTIVITY_ROWS),
    props.state ?? NO_STATE,
    i18n,
  );
  const operate = can(props.user, "org:operate");
  return (
    <div class="adm-blocks">
      <section class="adm-block">
        <div class="adm-block-head">
          <div>
            <h2 class="adm-title">{text.compareTitle}</h2>
            <p class="muted adm-lead">{text.compareLead}</p>
          </div>
          {operate ? (
            <form method="post" action={`${appPath("/admin")}/compare`}>
              <button type="submit" class="btn btn-secondary">
                {text.compareStart}
              </button>
            </form>
          ) : null}
        </div>
        {props.compareStart ? (
          <div class="adm-notices">
            <Notice kind="info">
              {text.compareCounts(
                props.compareStart.started,
                props.compareStart.open,
                props.compareStart.failed,
              )}
            </Notice>
          </div>
        ) : null}
        {compares.length === 0 ? (
          <p class="muted adm-empty">{text.compareEmpty}</p>
        ) : (
          <div class="list adm-list">
            <ul class="list-body" aria-label={text.compareTitle}>
              {compares.map((row) => {
                const { mode } = parseDetail(row.detail) as Partial<CompareRunDetail>;
                return (
                  <ListRow
                    title={mode ? text.compareModes[mode] : ""}
                    meta={describeCompareDetail(row, t)}
                    status={
                      <span class="num" title={formatTimestamp(row.createdAt)}>
                        {row.email ? `${row.email} · ` : ""}
                        {formatRelative(row.createdAt)}
                      </span>
                    }
                  />
                );
              })}
            </ul>
          </div>
        )}
        <p class="muted adm-hint">{text.compareHorizon}</p>
      </section>

      <section class="adm-block">
        <div class="adm-block-head">
          <div>
            <h2 class="adm-title">{text.alertsTitle}</h2>
            <p class="muted adm-lead">
              {props.alertsConfigured ? text.alertsLead : text.alertsOff}
            </p>
          </div>
          {props.alertsConfigured && operate ? (
            <form method="post" action={`${appPath("/admin")}/test-alert`}>
              <button type="submit" class="btn btn-secondary">
                {text.testAlertSend}
              </button>
            </form>
          ) : null}
        </div>
        {props.testAlert ? (
          <div class="adm-notices test-alert-result">
            <Notice kind={props.testAlert === "sent" ? "info" : "warn"}>
              {text.testAlertResults[props.testAlert]}
            </Notice>
          </div>
        ) : null}
      </section>

      {can(props.user, "org:audit") ? (
        <section class="adm-block">
          <div class="adm-block-head">
            <div>
              <h2 class="adm-title">{text.activityTitle}</h2>
              <p class="muted adm-lead">{text.activityLead(ADMIN_ACTIVITY_ROWS)}</p>
            </div>
            <a class="btn btn-secondary" href={activityHref({ scope: "org" })}>
              {text.activityAll}
            </a>
          </div>
          {days.length === 0 ? (
            <p class="muted adm-empty">{text.activityEmpty}</p>
          ) : (
            <div class="list adm-list act-list">
              {days.map((day) => (
                <ListGroup
                  title={day.heading}
                  level={3}
                  label={`${text.activityTitle}: ${day.heading}`}
                >
                  {day.items.map((item) => (
                    <ActivityRowItem item={item} showUser showDuration />
                  ))}
                </ListGroup>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
