-- The scope that the user allowed on the consent page, carried from the code to its grant. A code
-- from before this column allows the read scope only, which is what every grant had until then.
-- `oauth_grants.scope` exists since 0023. Personal tokens keep their scope in `api_tokens.scope`.
ALTER TABLE oauth_codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'mcp:read';
