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

## Planned feature: Oge Learning Tracks (future roadmap)

> **Status: Planned only — not implemented.** This is a proposed post-core feature to build **after the next prioritized OgeNotes work**. It does not introduce YouTube integration, modify the current Notes UI, or change the extension today.

**Product idea:** *Your playlist. Your pace. Your progress.* Turn a public YouTube learning playlist into a subject-owned study track with topic-based notes, flexible daily targets, and context-aware note capture from the existing floating OgeNotes extension.

### Where it lives

`Notes → Subject (for example, ML) → Playlists / Learning Tracks → Selected playlist`

- The subject continues to show its ordinary notes; **Playlists** is an additional subsection inside that subject, not a replacement for Notes or a top-level dashboard module.
- Opening a playlist shows the **current/unfinished topic note first**, today's suggested videos, overall course progress, and a way to resume.
- A single subject can contain multiple tracks; each track stays associated with its owner's subject.

### Planned student experience

1. **Capture a playlist:** while browsing YouTube, use the floating `O` extension widget to capture a playlist URL/ID, then choose the OgeNotes subject to associate with it. Allow manual paste/import in the website too.
2. **Import and review:** retrieve the ordered public video list and available durations/metadata. Propose topic groups based on actual video titles/descriptions; let the student review, split, merge, rename, and reorder them before creating notes.
3. **Create topic notes:** make **one reusable note per learning topic, not automatically one note per video**. Link each video to its topic note. For example, a 138-video course could yield far fewer topic notes; the exact count depends on the course.
4. **Plan a manageable pace:** let the student select a preferred videos-per-day count **and/or minutes per day**, optional rest days, and a start date. Show the estimated duration of the proposed daily assignment, not just the video count.
5. **Study flexibly:** place today's current/unfinished topic note at the top. Show target videos with duration and watch links. If three assigned videos total two hours but the student watches only two, accept that as progress without penalizing the student; carry the remainder forward and recompute upcoming targets.
6. **Watch and capture:** selecting a target opens the **specific YouTube video** in playlist context. The extension recognizes that course/video and offers the **existing matching topic note as the save destination**, rather than creating duplicate notes or making the user reselect the subject.
7. **Resume and revise:** next visit highlights unfinished videos/topic notes; track progress separately for the daily goal, topic, and full playlist. Later connect completed topic notes to Oge's existing revision schedule.

### Core behavior and safeguards

- Keep mappings `playlistId → ordered videoId → topicId → noteId`, with every record scoped to the authenticated account and subject. The extension must resolve a video's note from the active video and authenticated track, **not** a global “last selected note” value (multiple YouTube tabs must not corrupt the destination).
- Preserve the student's note content when refreshing playlist information; never silently overwrite or duplicate topic notes.
- Track **user-confirmed video completion** separately from merely clicking a watch link. Skipped, unfinished, unavailable, deleted, private, or reordered videos need explicit handling.
- Estimates depend on actual video durations when available. Offer a clear fallback and manual editing when metadata or topic classification is incomplete; AI-generated groupings are suggestions, not authoritative outlines.
- Use official YouTube APIs subject to quota, terms, attribution, and retention requirements. Keep API secrets server-side; do not bypass private/restricted videos or scrape YouTube pages.
- **No PDF/media download or hosted video storage is part of this proposal.** YouTube remains the video player; Oge stores course metadata, schedules, progress, and text notes.

### Proposed delivery phases

- [ ] **A — Playlist import and topic mapping:** subject-level Playlists subsection, secure import, metadata refresh, preview/edit topic groups, video-to-note mappings.
- [ ] **B — Flexible learning planner:** configurable video/minute targets, current note prioritization, progress, roll-forward for unfinished videos, resume and completion controls.
- [ ] **C — YouTube extension course mode:** open target video, securely identify the current track/topic and route note edits to the correct existing topic note; handle multiple tabs safely.
- [ ] **D — Revision integration and polish:** surface due revisions from completed topics, playlist updates, accessibility/mobile UX, and privacy/quotas/performance testing.

**Out of scope now:** this roadmap is intentionally deferred; it must not displace the next planned feature or be described as already shipped. The engineering plan and release gates remain in [ROADMAP.md](./ROADMAP.md).

## Current status

The dashboard, Google sign-in scaffolding, news-interest onboarding, and MongoDB foundation are merged into `main`. The core-workspace milestone is on `implementation/notes-module`: it adds owner-scoped Notes, Quick Notes, AirNotes, and Saved Links APIs/workspaces, plus initial Revision/Revision History, personalized News, Dictionary, and a Manifest V3 browser-extension MVP. The extension uses a revocable 90-day token; a manual Chrome smoke test and runtime multi-account isolation tests are still required. It includes bounded request bodies, URL validation, tags, favorites, owner-scoped review scheduling, and previous-version snapshots. This is a first implementation, not full parity with every advanced feature in `ogenotes`; multi-account security tests and live app validation remain required. See [ROADMAP.md](./ROADMAP.md) and [Google OAuth setup](./docs/GOOGLE_AUTH_SETUP.md).

## Security and configuration

- Never commit secrets, OAuth credentials, database connection strings, session secrets, or production environment files.
- Keep database access and privileged operations on the server.
- Do not deploy publicly until the release gates in `ROADMAP.md` have passed.
