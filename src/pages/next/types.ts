import type { Provider } from "../../config";
import type { RuleOutcome } from "../../audit";
import type { EditorState } from "../../editor";
import type { CurrentUser } from "../../users";

/** A line of feedback above a page: information or an error. */
export type Notice = { kind: "info" | "error"; text: string };

/** What every page of the app gets from its route. */
export interface PageBase {
  user: CurrentUser;
  state: EditorState;
  /** Latest finished run or failure per rule (see `latestRuleOutcomes`). */
  outcomes: RuleOutcome[];
  /** Which providers this deployment can connect. */
  providers: Record<Provider, boolean>;
  /** The operator's notice. Empty: none. */
  operatorNotice: string;
  notice?: Notice;
}
