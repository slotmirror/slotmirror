/**
 * The pages outside the app navigation. A call site imports them from here, so that the design is
 * chosen in one place.
 *
 * `OperatorNotice` is exported for the new sign-in page and for the pages of the redesign.
 */
export { CleanupPage } from "./cleanup";
export { ConsentPage } from "./consent";
export { DeleteUserPage } from "./delete-user";
export { DisconnectPage } from "./disconnect";
export { MessagePage } from "./message";
export { OAuthErrorPage, type AdminRequest, type OAuthErrorProps } from "./oauth-error";
export { OperatorNotice } from "./operator-notice";
export { PrivacyPage } from "./privacy";
export { SetupPage } from "./setup";
export { SignInPage } from "./sign-in";
