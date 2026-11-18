# Oge Notes — practical MVP checklist

**Priority: a usable note-taking product, not another security-review framework.**
This checklist supersedes the earlier prototype-percentage milestones as the
working definition of "done." Use real browser flows and report what actually
works; do not mark unexecuted steps successful.

## Simple daily workflow

1. Sign in to Oge using an existing supported account method.
2. Connect a personal GitHub Vault once (if not connected already).
3. From **Home → Notes**, open the familiar GitHub-backed Notes editor when
   the main Vault workspace is enabled for that account.
4. **Add subject** (e.g. Machine Learning). Create, edit and delete Notes
   through the existing editor and confirm the saved Notes appear after reload.
5. From **Home → Quick Capture**, add a subject inline if needed. Selecting
   a subject creates an empty ready-to-type capture automatically.
6. Type `Title` on line one and a body below. Temporary drafts save during
   typing; press **Save** to commit to the private GitHub repo. After success
   the same subject remains selected and a fresh capture is ready.
7. Reload, sign in again and confirm committed Notes are still present.
8. Test the existing editor's favorites, Markdown, search, tags, pagination,
   undo/confirm behavior and the draft recovery prompt.
9. Verify Notes navigation from the editor and home never silently switches
   a connected owner from GitHub Notes to the legacy MongoDB editor.
10. Confirm failed GitHub Saves show a useful error and retain the text rather
    than falsely showing success.

The existing environment must already have a functioning Auth.js session,
MongoDB user/subject metadata, a connected GitHub App-backed Vault and the
main Notes plus hybrid-draft features enabled. No extra Quick Capture-only
flag, staging database or staging-preflight configuration is required just to
open the Quick Capture page.

## MVP feature priorities

| Priority | Outcome | Status |
| --- | --- | --- |
| P0 | Open GitHub-backed Notes from Home when connected | Implemented in M104; live browser verification pending |
| P0 | Add subject, type first note, Save to GitHub | Connected workflows wired; live GitHub verification pending |
| P0 | Quick Capture automatically becomes writable and stays ready after Save | Implemented M104; live verification pending |
| P0 | Clear error and recoverable draft on failed Save | Existing behavior; verify in browser |
| P1 | Reliable search across larger collections | M105: explicit on-demand search loads the remaining GitHub pages in batches (up to 300 notes per click), with Stop/Continue; real account test pending |
| P1 | New Quick Notes / AirNotes / extension captures to one GitHub Vault | M107: implemented for connected owners; legacy historical records unchanged; real-account extension test pending |
| P1 | Comfortable mobile editor and keyboard shortcuts | M106 code: sticky Save action, word count, explicit GitHub vs draft state, reader Edit, automatic title focus and Ctrl/⌘+Enter; live mobile test pending |
| P2 | Learning Tracks: stable progress when playlist order changes | Planned |
| P2 | Deployment and production cutover | Last, after real workflows work |

## M105 — Everyday Notes search and keyboard Save

When the GitHub workspace contains more than the first 20 displayed Notes,
typing a search shows **Search remaining GitHub Notes**. Click it to load
additional owner-owned Notes directly from GitHub and search them in the
browser; no permanent note text is put into MongoDB. Progress is visible.
Each click loads at most 12 pages of up to 25 Notes (300 more notes). For very
large Vaults, select **Search remaining GitHub Notes** again to continue.
**Stop search** pauses requests and preserves the last fully loaded page.
Search only reports no matches for all Notes after all pages are loaded;
until then, it says no matches in loaded Notes **yet**.

In the Notes editor, use **Ctrl+Enter** on Windows/Linux or **⌘+Enter**
on macOS to submit the current note through the existing Save handler.
This does not skip draft recovery, GitHub Save confirmation or form
validation.

**Still to verify with a live account:** Create, edit, Save, reload, search
beyond 20 Notes, Stop/Continue, keyboard Save, provider errors and mobile
editor usability. Automated tests are not a substitute for the real flow.

## M106 — Notes editor usability and explicit Save feedback

The existing modal now shows a message for unsaved changes, temporarily
autosaved drafts, GitHub Save in progress, a confirmed saved version or an
error. A MongoDB/sessionStorage draft is not called a GitHub Save. A sticky
footer on long or mobile Notes keeps the **Save to GitHub** button visible,
along with a word/character count. On opening a note, the heading receives
keyboard focus after temporary draft recovery finishes.

The read-only Note viewer now offers **Edit note** directly, avoiding the
need to find the card again. Existing Ctrl/⌘+Enter Save is preserved. No
new content store, extra security gate or GitHub commit path was added.

Progress and validation status: see
`docs/OGE_NOTES_MVP_PROGRESS.md` for the explicit **7/10 (70%)
implemented-checkpoint** measure and the separate **0/3 real live account
journeys verified** measure. Passing CI does not prove live provider access.

## M107 — Unified destination for new standalone and browser captures

- **Connected GitHub Vault owners:** Opening Quick Notes or AirNotes uses
  the same subject-based `/vault/capture` editor as the main Notes workspace
  when both the existing Notes and hybrid-draft features are enabled.
  Selecting a new subject starts a writable draft immediately (fixed an
  overlooked empty-subject flow in M104).
- **Connected extension:** The floating widget loads the user's existing
  subject list, selects one when available, and sends an explicit Save to
  `/api/extension/vault-note`. This uses the existing GitHub App-private
  Vault Notes writer, **not** MongoDB permanent content storage. On an unknown
  result, the widget keeps its note text and capture ID for a safe retry.
- **Older extension builds:** A connected owner gets an update instruction
  rather than accidentally writing another permanent MongoDB Quick Note.
- **Disconnected users:** All existing Quick Notes, AirNotes and extension
  functionality stays on its legacy API and data store.
- **Not a migration:** Old Quick Notes and AirNotes remain in their existing
  MongoDB records. No old records were deleted or copied automatically.
  The new GitHub-based path is for **new captures only**.

**Progress:** 8/10 (80%) implementation checkpoints after M107, 0/3
required real-account workflows verified. These two numbers are independent.
See `docs/OGE_NOTES_MVP_PROGRESS.md`.

## Explicitly not doing next

Do not add new physical-device attestation, HMAC chains, cryptographic report
signatures, quarantine controls, or arbitrary release-evidence milestones just
because the number of milestones increases. Keep normal account isolation,
owner-scoped Notes, explicit Save, and non-destructive handling of failures.
Security work is triggered by a real defect, not by a milestone quota.

**No invented completion percentage.** A product is ready when its user
journeys have been tested successfully. A passing CI build is not a claim
that the browser-to-GitHub flow has been exercised with real credentials.
