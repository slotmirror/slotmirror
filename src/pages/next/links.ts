import type { Provider } from "../../config";

/** The connect flow of the account's provider, with the account preselected. */
export function reconnectUrl(account: { id: string; provider: Provider }): string {
  return `/auth/${account.provider}/connect?account=${encodeURIComponent(account.id)}`;
}
