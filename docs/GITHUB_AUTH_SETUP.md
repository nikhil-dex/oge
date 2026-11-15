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
- **Accounts are NOT automatically linked by matching email.** Using a different provider can create a separate OgeNotes workspace even if both providers supply the same verified email. Any future provider linking needs an explicit, authenticated, identity-verified workflow and migration policy.
- Existing account data stays unchanged. Password sign-in is available only when an account explicitly enables an OgeNotes password. Profile password setup supports reauthentication with the account's own OAuth provider.
- The eventual mandatory GitHub **notes-vault connection** is a separate project requiring explicit repository authorization; GitHub sign-in alone is not a vault connection.

## Security and release checks

- Keep OAuth credentials in server-side secret settings; do not put them in browser extension code or Git.
- Verify sign-in, sign-out, same-provider return visits, mismatched emails, revoked credentials, and provider-specific reauthentication in a real OAuth environment before production.
- Review GitHub OAuth application policies, rate limits, required permissions, consent, account deletion and privacy disclosures before rollout.
- OAuth can fail when an organization's or user's policies restrict app authorization.
