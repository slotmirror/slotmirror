import type { Child } from "hono/jsx";
import type { CurrentUser } from "../../../users";
import { PUBLIC_STYLES, PublicLayout } from "../public-layout";
import { Shell, type ShellPage } from "../shell";

/**
 * The frame of a page that visitors and signed-in users can both see (message, privacy). A
 * signed-in user gets the app shell, so the page does not look like a way out of the app; a
 * visitor gets the public layout. The page passes its content once.
 */
export function PageFrame(props: {
  title: string;
  user?: CurrentUser | null;
  /** Navigation entry to mark in the shell; none for a page such as "Delete my data". */
  nav?: ShellPage;
  lead?: Child;
  /** The language switch in the public layout; the shell has its own in the user menu. */
  languageSwitch?: boolean;
  children: Child;
}) {
  if (props.user) {
    return (
      <Shell
        title={props.title}
        user={props.user}
        active={props.nav}
        lead={props.lead}
        styles={PUBLIC_STYLES}
      >
        <div class="pub-flow">{props.children}</div>
      </Shell>
    );
  }
  return (
    <PublicLayout title={props.title} lead={props.lead} languageSwitch={props.languageSwitch}>
      {props.children}
    </PublicLayout>
  );
}
