# GitHub OAuth sign-in setup

OgeNotes supports **Continue with GitHub** alongside **Continue with Google** on the sign-in page. This is **identity authentication only**. It does not authorize Oge Vault, create a notes repository, or transfer existing notes to GitHub.

## Configure an OAuth App

1. In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the application homepage to your OgeNotes origin.
3. For local testing, set **Authorization callback URL** to `http://localhost:3000/api/auth/callback/github`. Use `https://YOUR_PRODUCTION_HOST/api/auth/callback/github` for the production OAuth App.
4. Copy the **Client ID** and generate a **Client secret**. Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in the server environment (for local development, in uncommitted `.env.local`).
5. Ensure `AUTH_SECRET` and MongoDB configuration are present. Configure separate OAuth Apps/credentials for development and production.

OgeNotes requests `read:user user:email` for sign-in and calls GitHub's authenticated email endpoint to require a **verified primary email**. The OAuth token is used server-side only during sign-in and is not saved to MongoDB or placed in the session.

## Identity and account behavior

- Google continues to identify existing accounts by their original stable Google `sub`.
- GitHub sign-in identifies accounts by the stable GitHub numerical account ID with a `github:` prefix. This maintains the existing owner-key storage model without treating matching email addresses as the same identity.
- **Accounts are not linked automatically by matching email.** GitHub-created accounts can connect Google explicitly from Profile. The connection requires a fresh Google OAuth verification and matching verified email, with a short-lived one-use link challenge.
- **Google connection is always optional.** Even if a verified GitHub email matches an existing Google-backed OgeNotes account, the GitHub user can continue in their own independent workspace; matching emails alone do not grant access to the Google user's notes. A verified explicit link is required before sharing the original Google workspace.
- After verification, both OAuth providers resolve to the same established Oge workspace. Existing Google notes and ownership stay unchanged. If the separate GitHub workspace already has notes, a password, username, or other personalized data, linking stops safely with a migration-required message; no content is silently combined or deleted.
- Google OAuth for login is separate from future Oge Vault GitHub App permission grants. Linking identity does not authorize repository creation, GitHub contents access, or notes migration.
- Existing account data stays unchanged. Password sign-in is available only when an account explicitly enables an OgeNotes password. Profile password setup supports reauthentication with the account's own OAuth provider.
- The eventual mandatory GitHub **notes-vault connection** is a separate project requiring explicit repository authorization; GitHub sign-in alone is not a vault connection.

## Security and release checks

- Keep OAuth credentials in server-side secret settings; do not put them in browser extension code or Git.
- Verify sign-in, sign-out, same-provider return visits, matching/mismatched verified emails, expired/replayed link intents, revoked credentials, account deletion, and provider-specific reauthentication in a real OAuth environment before production.
- GitHub/Google linked account deletion must remove both sign-in identities; do not treat a separate GitHub source record as a second independent workspace after linking.
- Cross-device concurrent links and accounts containing data require dedicated staging validation. In the latter case, a migration flow is a future task rather than automatically transferring personal data.
- Review GitHub OAuth application policies, rate limits, required permissions, consent, account deletion and privacy disclosures before rollout.
- OAuth can fail when an organization's or user's policies restrict app authorization.
