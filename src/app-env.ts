import type { SignedInUser } from "./users";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SignedInUser | null;
    /** The stored scope of the MCP request's token or grant. Unset outside `/mcp`. */
    credentialScope?: string;
    language: string;
    /** One more origin that a form on this page may submit to, for a redirect after the form. */
    formAction?: string;
  };
};
