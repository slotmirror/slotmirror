import type { Child } from "hono/jsx";
import { Section } from "./components";

/**
 * Pieces that the admin and the API tokens pages share. They emit the classes of
 * `public/next/admin.css` and `base.css`, which both pages load.
 */

/** A hidden `back` field: where a POST of the redesign returns to (checked by `backPath`). */
export function BackField(props: { to: string }) {
  return <input type="hidden" name="back" value={props.to} />;
}

/** A finished action: a check mark and one line, announced to assistive technology. */
export function DoneNote(props: { children: Child }) {
  return (
    <p class="adm-done" role="status" data-saved>
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
      {props.children}
    </p>
  );
}

/**
 * The confirmation step of a destructive action, as the body of a panel. It names in one sentence
 * what happens and that it cannot be undone. The danger button posts to `action`; the cancel link
 * returns to the panel as it was.
 */
export function ConfirmStep(props: {
  action: string;
  back: string;
  sentence: Child;
  note?: Child;
  button: string;
  cancel: string;
  cancelHref: string;
}) {
  return (
    <div class="confirm-step">
      <p class="confirm-text">{props.sentence}</p>
      {props.note ? <p class="muted confirm-note">{props.note}</p> : null}
      <form class="row-flow" method="post" action={props.action}>
        <BackField to={props.back} />
        <button type="submit" class="btn btn-danger">
          {props.button}
        </button>
        <a class="btn btn-ghost" href={props.cancelHref}>
          {props.cancel}
        </a>
      </form>
    </div>
  );
}

/**
 * The bottom section of a panel with the one destructive action. A link opens the confirmation
 * step, so that it works without script; nothing is deleted by this click.
 */
export function DangerSection(props: { title: string; hint: string; label: string; href: string }) {
  return (
    <Section title={props.title}>
      <div class="adm-danger">
        <a class="btn btn-ghost btn-danger-ghost" href={props.href}>
          {props.label}
        </a>
        <p class="prop-hint">{props.hint}</p>
      </div>
    </Section>
  );
}

/**
 * A value to copy, in a monospace field that selects with one click. The copy button needs
 * script, so the stylesheet hides it until the `js` class is set; without script the value is still
 * selectable. `public/next/tokens.js` does the copy and swaps the label for a moment.
 */
export function SecretField(props: {
  id: string;
  label: string;
  value: string;
  copy: string;
  copied: string;
}) {
  return (
    <div class="adm-secret">
      <div class="adm-secret-head">
        <span class="adm-secret-label" id={`${props.id}-label`}>
          {props.label}
        </span>
        <button
          type="button"
          class="btn btn-secondary adm-copy"
          data-needs-script
          data-copy-target={props.id}
          data-copy-label={props.copy}
          data-copied-label={props.copied}
        >
          {props.copy}
        </button>
      </div>
      <code
        class="adm-secret-value"
        id={props.id}
        tabindex={0}
        aria-labelledby={`${props.id}-label`}
      >
        {props.value}
      </code>
    </div>
  );
}
