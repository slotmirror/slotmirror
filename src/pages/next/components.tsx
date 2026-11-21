import type { Child } from "hono/jsx";
import { useI18n } from "../../i18n";

/**
 * Shared pieces of the redesign. Each component emits the classes that `public/next/base.css`
 * documents. Pages compose these and add only page-specific CSS in their own stylesheet.
 */

// Small marks -----------------------------------------------------------------------------------

export type Tone = "ok" | "warn" | "danger" | "idle";

/**
 * A status dot. By default it names its state for assistive technology; pass `label={false}` where
 * visible text next to the dot already says it.
 */
export function StatusDot(props: { tone: Tone; label?: string | false }) {
  const { t } = useI18n();
  const label =
    props.label === false ? undefined : (props.label ?? t.next.shell.status[props.tone]);
  return (
    <span
      class={`dot dot-${props.tone}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    />
  );
}

export function Tag(props: { children: Child; title?: string }) {
  return (
    <span class="tag" title={props.title}>
      {props.children}
    </span>
  );
}

// List ----------------------------------------------------------------------------------------

/**
 * A group of rows with a header, for example "Appears in Work". `level` 3 for a group under a
 * heading of its own, such as the day groups under Admin's "Latest entries".
 */
export function ListGroup(props: {
  title: Child;
  hint?: Child;
  label: string;
  level?: 2 | 3;
  children: Child;
}) {
  return (
    <section class="list-group">
      <div class="list-group-head">
        {props.level === 3 ? <h3>{props.title}</h3> : <h2>{props.title}</h2>}
        {props.hint ? <span class="list-group-hint">{props.hint}</span> : null}
      </div>
      <ul class="list-body" aria-label={props.label}>
        {props.children}
      </ul>
    </section>
  );
}

/**
 * One 40 px row. With `href` the whole row is a link; `selected` marks the row whose panel is
 * open (`aria-current="true"`). Parts, left to right: icon, title with meta, tags, a count (a
 * right-aligned number such as "60 copies"), status.
 */
export function ListRow(props: {
  /**
   * A stable id per object, such as `row-m-<from>~<to>`. The in-app merge matches rows by it, so
   * a row that comes or goes does not shift the others (and the focus) by one.
   */
  id?: string;
  href?: string;
  selected?: boolean;
  /** Accessible name of a link row whose parts read badly in sequence. */
  label?: string;
  icon?: Child;
  title: Child;
  meta?: Child;
  tags?: Child;
  count?: Child;
  status?: Child;
}) {
  const parts = (
    <>
      {props.icon ? <span class="row-icon">{props.icon}</span> : null}
      <span class="row-main">
        <span class="row-title">{props.title}</span>
        {props.meta ? <span class="row-meta">{props.meta}</span> : null}
      </span>
      {props.tags ? <span class="row-tags">{props.tags}</span> : null}
      {props.count !== undefined ? <span class="row-count num">{props.count}</span> : null}
      {props.status ? <span class="row-status">{props.status}</span> : null}
    </>
  );
  return (
    <li class="list-item" id={props.id}>
      {props.href ? (
        <a
          class="list-row"
          href={props.href}
          aria-current={props.selected ? "true" : undefined}
          aria-label={props.label}
        >
          {parts}
        </a>
      ) : (
        <div class={props.selected ? "list-row is-selected" : "list-row"}>{parts}</div>
      )}
    </li>
  );
}

// Detail panel ----------------------------------------------------------------------------------

/**
 * The right detail panel. Pass it to `Shell` as `panel`. With `form`, the body and the footer are
 * one form, so the footer's submit button saves everything in the body. On a phone the panel
 * covers the list, and the back link at its top returns to it.
 */
export function Panel(props: {
  title: Child;
  /** Where the close link goes: the list without the selection, for example "/mirroring". */
  closeHref: string;
  /**
   * The panel this one was opened from, for a link in the head back to it: a calendar panel opened
   * from a mirroring's working hours. Below 960 px it takes the place of the back link to the list.
   */
  back?: { href: string; label: string };
  form?: {
    action: string;
    method?: "post" | "get";
    /**
     * "foreground": a save does not end in a redirect (the answer is the page, for example a
     * one-time secret). The script then never saves such a form in the background; it submits it
     * as a normal form.
     */
    saveMode?: "foreground";
  };
  /** "off": Escape does not leave this panel, for a panel that holds something that is shown once. */
  escape?: "off";
  /**
   * One muted line under the head: the state of the object ("8 min · 60 copies · View
   * activity"), as Linear puts state next to a title. Spell a state out only when it is not ok.
   */
  meta?: Child;
  /** The save bar (see `SaveBar`). */
  footer?: Child;
  /** A save just finished: the head shows "Saved" for about four seconds. */
  saved?: boolean;
  children: Child;
}) {
  const { t } = useI18n();
  const shell = t.next.shell;
  const inner = (
    <>
      <div class="detail-body">
        {props.meta ? <p class="detail-meta">{props.meta}</p> : null}
        {props.children}
      </div>
      {props.footer ? <div class="detail-foot">{props.footer}</div> : null}
    </>
  );
  return (
    <aside class="detail" id="detail" aria-labelledby="detail-title" data-escape={props.escape}>
      <div class="detail-head">
        <h2 class="detail-title" id="detail-title" tabindex={-1}>
          {props.title}
        </h2>
        {/* After the heading in the source, first on screen (CSS `order`): the panel opens with
            the focus on the heading, so the next Tab reaches the back link on a phone. */}
        <a class="btn btn-ghost detail-back" href={props.closeHref} aria-label={shell.panel.back}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
          <span>{shell.panel.backShort}</span>
        </a>
        {props.back ? (
          <a class="btn btn-ghost detail-from" href={props.back.href} aria-label={props.back.label}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 5l-7 7 7 7" />
            </svg>
            <span class="detail-from-long">{props.back.label}</span>
            <span class="detail-from-short">{shell.panel.backShort}</span>
          </a>
        ) : null}
        {props.saved ? <SavedNote /> : null}
        <a
          class="btn btn-ghost btn-icon detail-close"
          href={props.closeHref}
          aria-label={shell.panel.close}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </a>
      </div>
      {props.form ? (
        <>
          <form
            class="detail-form"
            id="detail-form"
            method={props.form.method ?? "post"}
            action={props.form.action}
            data-save-mode={props.form.saveMode}
          >
            {inner}
          </form>
          <GuardDialog />
        </>
      ) : (
        <div class="detail-form">{inner}</div>
      )}
    </aside>
  );
}

/** The one place and look of "Saved": in the panel head, next to the title. */
function SavedNote() {
  const { t } = useI18n();
  return (
    <span class="detail-saved" role="status" data-saved>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
      {t.next.shell.common.saved}
    </span>
  );
}

/**
 * The dialog that stops a leave with unsaved changes. Closed, it is not shown, so a page without
 * script never sees it. `public/next/panel.js` opens it with `showModal()`: the browser traps the
 * focus and Escape closes it. "Keep editing" has the initial focus.
 */
function GuardDialog() {
  const { t } = useI18n();
  const text = t.next.shell.panel.guard;
  return (
    <dialog
      class="guard"
      data-guard
      aria-labelledby="guard-title"
      aria-describedby="guard-text"
      data-one={text.titleOne}
      data-many={text.titleMany}
      data-text-one={text.textOne}
      data-text-many={text.text}
    >
      <h2 class="guard-title" id="guard-title" data-guard-title />
      <p class="guard-text" id="guard-text" data-guard-text>
        {text.text}
      </p>
      <div class="guard-actions">
        <button type="button" class="btn btn-ghost btn-danger-ghost" data-guard-discard>
          {text.discard}
        </button>
        <button type="button" class="btn btn-secondary" data-guard-keep autofocus>
          {text.keepEditing}
        </button>
        <button type="button" class="btn btn-primary" data-guard-save>
          {text.saveAndContinue}
        </button>
      </div>
    </dialog>
  );
}

/**
 * The save bar of a panel with a form. Without script it is a plain Save button. With script it
 * shows only while the form holds a change, counts the changes, and shows the notes in `notes`
 * as one line above the row of buttons. A note is a `<Note>`; the script decides when it shows,
 * and a warning note can swap the label of the primary button. `forced` keeps the bar open, for a
 * form that the server refused; `data-refused` then makes the script count the panel as unsaved.
 *
 * The keyboard hint is drawn by CSS after the button label, because the script replaces the label
 * text. It shows once the root carries `data-platform` ("mac" or "other"), never on touch.
 *
 * `refusedCount` is how many changes the refused form holds against the stored values, counted as
 * the script counts them. The script shows it while the refused input is the form's default, so
 * the bar does not read "0 changes" after a refusal (`data-refused-count`).
 *
 * `labels` are the labels of the Save button for the notes that widen what others see, by the
 * note's `data-sentence`. The script sets the label itself; without script, CSS of the page shows
 * the label of the chosen answer (`data-label-for`) instead of the default one.
 */
export function SaveBar(props: {
  notes?: Child;
  forced?: boolean;
  refusedCount?: number;
  /**
   * The form fields of those changes, so that the script counts a refused field that is edited
   * again once (`data-refused-fields`). A checkbox of a group that shares one name, such as the
   * source calendars, is named with its value: "source:<id>".
   */
  refusedFields?: readonly string[];
  labels?: readonly { for: string; text: string }[];
}) {
  const { t } = useI18n();
  const common = t.next.shell.common;
  return (
    <div
      class="savebar"
      data-savebar
      data-forced={props.forced ? "" : undefined}
      data-refused={props.forced ? "" : undefined}
      data-refused-count={
        props.forced && props.refusedCount !== undefined ? String(props.refusedCount) : undefined
      }
      data-refused-fields={
        props.forced && props.refusedFields !== undefined
          ? props.refusedFields.join(" ")
          : undefined
      }
      data-one={common.changesOne}
      data-many={common.changesMany}
    >
      <div class="savebar-notes" role="status">
        <svg
          class="savebar-note-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3.5l9.5 16.5h-19z" />
          <path d="M12 9.5v4.5M12 17.2h.01" />
        </svg>
        <div class="savebar-note-list">
          {props.notes}
          {/* Shown by the script when a save in the background did not work. */}
          <SaveError />
        </div>
      </div>
      <div class="savebar-row">
        <span class="savebar-text num" data-count />
        <button type="button" class="btn btn-ghost" data-discard hidden>
          {common.discard}
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          data-save
          data-label={common.save}
          data-kbd-mac={common.saveKey.mac}
          data-kbd-other={common.saveKey.other}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {props.labels && props.labels.length > 0 ? (
            <>
              <span data-label-default>{common.save}</span>
              {props.labels.map((label) => (
                <span data-label-for={label.for} hidden>
                  {label.text}
                </span>
              ))}
            </>
          ) : (
            common.save
          )}
        </button>
      </div>
    </div>
  );
}

/** The two refusals of a background save. The script shows one of them, never both. */
function SaveError() {
  const { t } = useI18n();
  const text = t.next.shell.panel;
  return (
    <>
      <p data-note data-warn data-save-error="failed" data-default={text.saveFailed} hidden>
        {text.saveFailed}
      </p>
      <p data-note data-warn data-save-error="session" hidden>
        {text.sessionEnded}
      </p>
      <p data-note data-warn data-save-error="stale" hidden>
        {text.savedNotShown}
      </p>
    </>
  );
}

/**
 * A sentence in the save bar about what a save changes. Hidden until the script shows it:
 * `changed` lists field names; the note shows if one of them differs from the saved value.
 * `off` is the id of a switch; the note shows if it was on and is now off. A page script can show
 * a note by its own rule (`data-note` only). `warn` gives it the warning tone and, with `button`,
 * swaps the label of the primary button while it shows. `danger` marks that label as destructive
 * ("Turn off"): the Save button then takes the danger tone.
 */
export function Note(props: {
  children: Child;
  changed?: string[];
  off?: string;
  warn?: boolean;
  button?: string;
  danger?: boolean;
  [data: `data-${string}`]: string | undefined;
}) {
  const { children, changed, off, warn, button, danger, ...data } = props;
  return (
    <p
      data-note
      data-changed={changed?.join(" ")}
      data-off={off}
      data-warn={warn ? "" : undefined}
      data-button={button}
      data-tone={danger && button ? "danger" : undefined}
      hidden
      {...data}
    >
      {children}
    </p>
  );
}

/** A titled block inside a panel body. Sections are separated by a hairline. */
export function Section(props: { title?: Child; children: Child }) {
  return (
    <section class="section">
      {props.title ? <h3 class="section-title">{props.title}</h3> : null}
      {props.children}
    </section>
  );
}

/** The id of a property's hint, for `aria-describedby` on its control. */
export function hintId(id: string): string {
  return `${id}-hint`;
}

/** The id of a property's label, for `aria-labelledby` on a group of controls. */
export function labelId(id: string): string {
  return `${id}-label`;
}

/** The id of a property's error line, for `aria-describedby` on its control. */
export function errorId(id: string): string {
  return `${id}-error`;
}

/**
 * `aria-describedby` and `aria-invalid` for a control: its hint, and its error if the server
 * refused the save because of it. Spread the result onto the control.
 */
export function describedBy(
  id: string,
  options: { hint?: boolean; invalid?: boolean } = {},
): { "aria-describedby"?: string; "aria-invalid"?: "true" } {
  const ids = [options.hint ? hintId(id) : "", options.invalid ? errorId(id) : ""].filter(Boolean);
  return {
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
    "aria-invalid": options.invalid ? "true" : undefined,
  };
}

/**
 * One property of a panel on the panel's property grid: the label in the first column (120 px),
 * the control in the second, the hint under the control. Every property of every panel uses it,
 * so that labels, controls and hints start at the same x and the rows keep one rhythm.
 *
 * - `for`: the id of the one control; the label points at it.
 * - `group`: the id of a group of controls (radio group, swatches, days); the label gets
 *   `labelId(group)`, and the group names itself with `aria-labelledby`.
 * - The hint gets `hintId(for ?? group)`; the control links it with `aria-describedby`.
 * - `stacked`: a control that does not fit the second column, such as a segmented control with
 *   long labels or a row of swatches, goes under its label across both columns, with its hint.
 * - `fields`: the names of the form fields of this property, so that a script can mark the row
 *   as changed (`data-fields`).
 * - `error`: why the server refused the save because of this property. It shows under the
 *   control as `errorId(for ?? group)`; the control links it and sets `aria-invalid` (see
 *   `describedBy`), so that the script can focus it.
 */
export function PropertyRow(props: {
  label: Child;
  for?: string;
  group?: string;
  hint?: Child;
  stacked?: boolean;
  fields?: string[];
  error?: string;
  children: Child;
}) {
  const id = props.for ?? props.group;
  return (
    <div class={props.stacked ? "prop is-stacked" : "prop"} data-fields={props.fields?.join(" ")}>
      {props.for ? (
        <label class="prop-label" for={props.for}>
          {props.label}
        </label>
      ) : (
        <span class="prop-label" id={props.group ? labelId(props.group) : undefined}>
          {props.label}
        </span>
      )}
      <div class="prop-control">{props.children}</div>
      {props.error ? (
        <p class="prop-error" id={id ? errorId(id) : undefined}>
          {props.error}
        </p>
      ) : null}
      {props.hint ? (
        <p class="prop-hint" id={id ? hintId(id) : undefined}>
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

// Controls --------------------------------------------------------------------------------------

/**
 * A segmented control of radio buttons: works without script, and a form submits the selected
 * value under `name`. The group is named by `label`, or by the visible label of its property
 * (`labelledBy`, see `labelId`). `tiles` puts each option's `icon` above its label, for four
 * options with a mark each that would not fit one line.
 *
 * With `multiple`, the items are checkboxes and `value` lists the checked ones: a form submits
 * each under `name`, as for the weekdays of working hours. The group is then one tab stop, and the
 * arrow keys move between the items (`data-roving`, see `panel.js`). An option with `title` shows
 * it on hover and names its box with it, for a short label such as "Mo".
 *
 * `required` asks for an answer before the form submits: the browser refuses a submit while no
 * radio of the group is checked. Not for `multiple`.
 */
export function Segmented(props: {
  name: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  value: string | readonly string[];
  options: readonly {
    value: string;
    label: Child;
    icon?: Child;
    disabled?: boolean;
    /** The full name of a short label, as tooltip and accessible name. */
    title?: string;
  }[];
  /** Fill the width; the free width is shared out. */
  block?: boolean;
  tiles?: boolean;
  /** Controls with the same group count as one change in the save bar. */
  group?: string;
  multiple?: boolean;
  required?: boolean;
  /** More classes on the group, for a page's own layout. */
  class?: string;
  invalid?: boolean;
}) {
  const classes = [
    "seg",
    props.block ? "is-block" : "",
    props.tiles ? "is-tiles" : "",
    props.class ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const chosen = (value: string) =>
    typeof props.value === "string" ? value === props.value : props.value.includes(value);
  return (
    <div
      class={classes}
      role={props.multiple ? "group" : "radiogroup"}
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      aria-required={props.required && !props.multiple ? "true" : undefined}
      aria-invalid={props.invalid ? "true" : undefined}
      data-change-group={props.group}
      data-roving={props.multiple ? "" : undefined}
    >
      {props.options.map((option) => (
        <label class="seg-item" title={option.title}>
          <input
            type={props.multiple ? "checkbox" : "radio"}
            name={props.name}
            value={option.value}
            checked={chosen(option.value)}
            disabled={option.disabled}
            required={props.required && !props.multiple ? true : undefined}
            aria-label={option.title}
          />
          {option.icon}
          <span aria-hidden={option.title ? "true" : undefined}>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * A switch: a checkbox that submits `value` (default "1") under `name` when on. `role="switch"`
 * makes the browser announce it as on or off. `label` is its accessible name; it must contain the
 * visible label of its property.
 */
export function Switch(props: {
  name: string;
  label: string;
  checked?: boolean;
  value?: string;
  id?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      class="switch"
      type="checkbox"
      role="switch"
      id={props.id}
      name={props.name}
      value={props.value ?? "1"}
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.label}
      aria-describedby={props.describedBy}
    />
  );
}

// Notice, empty state ------------------------------------------------------------------------------

const NOTICE_PATH: Record<"info" | "warn" | "danger", string> = {
  info: "M12 11v5M12 8h.01",
  warn: "M12 8v5M12 16h.01",
  danger: "M12 7.5v5.5M12 16.5h.01",
};

/**
 * A short message inside the page. `danger` is announced at once; the others are plain text.
 * `focusable` lets a script move the focus to it (`tabindex="-1"`), for a notice that replaces what
 * the person was doing, such as a refused save.
 */
export function Notice(props: {
  kind: "info" | "warn" | "danger";
  title?: Child;
  children?: Child;
  /** One action on the right, for example a link-button. */
  action?: Child;
  id?: string;
  focusable?: boolean;
  [data: `data-${string}`]: string | undefined;
}) {
  const { t } = useI18n();
  const { kind, title, children, action, id, focusable, ...data } = props;
  return (
    <div
      class={`notice notice-${kind}`}
      role={kind === "danger" ? "alert" : undefined}
      id={id}
      tabindex={focusable ? -1 : undefined}
      {...data}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {kind === "warn" ? <path d="M12 3.5l9.5 16.5h-19z" /> : <circle cx="12" cy="12" r="9" />}
        <path d={NOTICE_PATH[kind]} />
      </svg>
      <div class="notice-body">
        {/* The icon is decorative; the type is read before the text. */}
        <span class="sr-only">{`${t.next.shell.notice[kind]}: `}</span>
        {title ? <div class="notice-title">{title}</div> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

/**
 * The notices at the top of a panel after a refused save. A conflict is a warning that the script
 * focuses and announces (`#panel-conflict`, `data-conflict`): the panel then shows the stored
 * values. A refusal at a field says on top only that nothing was saved; the reason shows at the
 * field (`PropertyRow` `error`). Any other refusal names its reason here.
 */
export function PanelNotices(props: { conflict?: string; error?: string; field?: string }) {
  const { t } = useI18n();
  return (
    <>
      {props.conflict ? (
        <Notice kind="warn" id="panel-conflict" data-conflict="" focusable>
          {props.conflict}
        </Notice>
      ) : null}
      {props.error ? (
        <Notice kind="danger">{props.field ? t.next.shell.panel.notSaved : props.error}</Notice>
      ) : null}
    </>
  );
}

/** Plain words and one action, left aligned. No illustration. Put the actions in `children`. */
export function EmptyState(props: { title: Child; text?: Child; children?: Child }) {
  return (
    <div class="empty">
      <h2 class="empty-title">{props.title}</h2>
      {props.text ? <p class="empty-text">{props.text}</p> : null}
      {props.children ? <div class="empty-actions">{props.children}</div> : null}
    </div>
  );
}
