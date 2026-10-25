# Local setup and Google sign-in

This project is under active development. Do not use production credentials or real user data until the release gates in `ROADMAP.md` are complete.

## Requirements

- Node.js 20.9 or newer (Node.js 22 is used in CI).
- npm.
- A MongoDB Atlas database and a dedicated application database user.
- A Google Cloud OAuth client for a Web application.

## Install

```bash
npm install
cp .env.example .env.local
```

Generate a random Auth.js secret and place it in `.env.local`:

```bash
openssl rand -base64 32
```

Set the output as `AUTH_SECRET`. Fill in `MONGODB_URI` and `MONGODB_DB=oge_notes`.

## Configure Google OAuth

1. In Google Cloud Console, configure the OAuth consent screen and create an OAuth client ID of type **Web application**.
2. Add this authorized redirect URI for local development:

   `http://localhost:3000/api/auth/callback/google`

3. For production, add the exact deployed callback URI:

   `https://YOUR_PRODUCTION_HOST/api/auth/callback/google`

4. Copy the OAuth client ID to `AUTH_GOOGLE_ID` and client secret to `AUTH_GOOGLE_SECRET` in `.env.local` and the deployment's secret settings.
5. Do not request Drive or other Google API scopes for sign-in. The current sign-in flow only needs Google identity.
6. Until applicable Google verification requirements are completed, the consent screen may be limited to configured test users. Do not open public registration before the roadmap release gates pass.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`. Unauthenticated users are redirected to `/register`. After Google sign-in, the app creates or updates a user record in the configured MongoDB database and asks for optional news interests.

## Important security notes

- Never commit `.env.local`, OAuth secrets, the MongoDB URI, or `AUTH_SECRET`.
- Use separate OAuth credentials for development and production.
- Use a dedicated Atlas database user with the minimum required permissions and restrict Atlas network access to the deployment's supported outbound path.
- The initial authentication scaffolding has not yet passed a full real-provider security review. Do not treat a successful local login as production approval.
- Feature APIs must independently enforce the signed-in user's ownership; proxy redirects are not a substitute for API authorization.

See [ROADMAP.md](../ROADMAP.md) for remaining work and release blockers.
