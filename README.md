# OgeNotes

OgeNotes is the production-focused evolution of the existing `ogenotes` study-notes application. The goal is to preserve the original app's visual design and reuse its working code selectively, while adding the agreed dashboard features and a secure multi-user architecture.

## Project principles

1. **Reuse before rewriting:** inspect `ogenotes`, identify reusable pages, components, styles, utilities, and working features, then port only what OgeNotes needs.
2. **Preserve the original design:** keep the same visual language, layout, responsive behavior, and interaction patterns.
3. **Keep the repositories separate:** `ogenotes` is the reference project and must not be modified as part of this work. All changes belong in `oge`.
4. **Secure multi-user data:** use Google sign-in and store application data in the project owner's MongoDB Atlas database, with server-enforced per-user access controls.
5. **No file storage in the initial release:** do not implement PDF uploads, image/file attachments, Google Drive, Vercel Blob, or another file-storage integration.

## Home dashboard scope

The dashboard will provide access to:

- Notes
- AirNotes
- Quick Notes
- Saved Links
- Browser Extension
- Revision History
- Dictionary
- News
- Revision

During registration, users can optionally select news interests. They can change these interests later in settings. Users who skip this step should still receive a general news feed.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the phased implementation plan, release gates, and acceptance criteria.

## Current status

The dashboard, Google sign-in scaffolding, news-interest onboarding, and MongoDB foundation are merged into `main`. The core-workspace milestone is on `implementation/notes-module`: it adds owner-scoped Notes, Quick Notes, AirNotes, and Saved Links APIs/workspaces, plus initial Revision/Revision History, personalized News, and Dictionary flows. It includes bounded request bodies, URL validation, tags, favorites, owner-scoped review scheduling, and previous-version snapshots. This is a first implementation, not full parity with every advanced feature in `ogenotes`; multi-account security tests and live app validation remain required. See [ROADMAP.md](./ROADMAP.md) and [Google OAuth setup](./docs/GOOGLE_AUTH_SETUP.md).

## Security and configuration

- Never commit secrets, OAuth credentials, database connection strings, session secrets, or production environment files.
- Keep database access and privileged operations on the server.
- Do not deploy publicly until the release gates in `ROADMAP.md` have passed.
