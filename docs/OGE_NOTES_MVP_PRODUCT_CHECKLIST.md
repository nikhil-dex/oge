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
5. From **Home → Quick Capture**, add a subject inline if needed. A single
   available subject is chosen automatically; otherwise select one.
6. Type a simple thought, **or** write a title on line one and details below.
   A one-line capture derives a useful title and keeps the full text in its
   body. Temporary drafts save during typing; press **Save** to commit to
   the private GitHub repo. After success the subject stays selected and
   a fresh capture is ready.
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

## M108 — Quick Capture one-line usability

- A one-line text such as `Buy milk tomorrow` now creates a valid
  GitHub Note with an automatically derived title and the original sentence
  preserved in its body. Multi-line title-and-body Notes are unchanged.
- With one existing subject, Quick Capture chooses it without another click.
  The existing draft recovery prompt is still shown if necessary.
- Quick Capture's navigation now returns directly to **GitHub Notes**,
  avoiding an unexpected jump into the older Notes page.
- The floating extension shares the same text conversion on the server;
  an ordinary quick thought is enough to save into a selected subject.
- Run this real-account test: open Quick Notes, type one sentence, Save,
  reload GitHub Notes and check its title and body. Repeat from Chrome's
  floating extension, and with a two-line Note.

**Progress unchanged:** 8/10 implementation checkpoints and 0/3 real
user journeys independently verified. This fixes usability within an
existing checkpoint; no new checkpoint is claimed.

## M109 — Prevent accidental text loss in everyday capture

- Write a single-line Note in GitHub Quick Capture and wait for temporary
  draft autosave. Reload the same tab; choosing to recover its saved draft
  should restore that exact single line, not two copies.
- With the Chrome floating extension, enter a subject Note and press
  **Save to GitHub Vault**. If the request is slow, typing something new
  must not be erased by the previous Save response. The widget explains
  that the new text still needs its own Save.
- Retry the same unchanged capture after a connection error: the same
  UUID is reused and the note text remains in the editor until confirmed.
- Verify a rapid double-click or subject refresh during Save does not send
  two simultaneous commits.

**Implementation progress remains 8/10 (80%); real connected-account
verification remains 0/3.** These improvements fix existing flows.
CI tests exercise deterministic simulated responses, but live Chrome and
GitHub App behavior still needs testing.

## M110 — Finish browser-only note recovery and provider Save check

1. Open Quick Capture, type an unfinished Note, then reload immediately
   before the normal 900 ms encrypted autosave.
2. Recover the browser-only copy. It should be **editable** and allow an
   explicit GitHub Save; the old flow blocked further editing.
3. If the previous capture was already committed to GitHub, the
   owner-scoped `/api/vault/notes-main?id=...` check prevents treating a
   confirmed same-content Save as a new Note.
4. If that UUID holds an older/different saved Note, the browser text
   becomes a new capture while the earlier Note remains untouched.
5. If GitHub is temporarily unreachable, the browser text remains
   available for editing. The UI warns that a previous Save cannot be
   ruled out until GitHub is available.

**Acceptance remains unproven on a live account.** Follow the
step-by-step test in `docs/OGE_NOTES_LIVE_ACCEPTANCE.md` before marking
the Save/reload/draft-recovery journey as passed. Synthetic unit tests
do not satisfy live acceptance. Progress remains **8/10 (80%) in code**,
**0/3 real account journeys verified**.

## M111 — Visible recently saved Notes

- When the Vault contains over 20 Notes, Save a fresh Note from the main
  editor. Reload the page and confirm it is still in the visible results,
  even if its random UUID would place it outside GitHub's first file page.
- Repeat with **Quick Capture**; the saved Note should appear in the
  normal GitHub Notes workspace without requiring a full paginated scan.
- From the floating browser extension, Save to GitHub and click
  **View last saved GitHub Note**. It should open the specific Note in
  the correct subject. The extension does not automatically open tabs.
- On edit, verify a new reload shows the **current GitHub content**,
  not a stale cached browser body. Browsers store only up to five UUID
  navigation hints, not the Note text.
- On another device, recent IDs are not synchronized; use
  **Search remaining GitHub Notes** to find older/unloaded files.

The provider fixture tests this create/reload/edit/reload path against a
mock GitHub tree. Live owner account verification still must be done.
**Implementation: 8/10 (80%); live journeys: 0/3.**

## M112 — Extension saved Note opens in reader

After saving from the floating extension, select **View last saved GitHub
Note**. The app should load the Note by UUID from GitHub, automatically
open its reader, select the correct subject, and let the user choose
**Edit note**. Save changes and confirm the reader stays closed until
explicitly reopened; an ordinary refresh should allow opening the linked
Note again. If the note was deleted or temporarily inaccessible, the app
should display an error and never fabricate a Note.

This specific UI behavior now has an automated regression test, but
remains to be verified in a real connected Chrome session. Overall
score **8/10 implemented, 0/3 real-account journeys verified**.

## M113 — Extension Save while typing should update one Note

1. Type a Note in the floating Chrome widget and click **Save to GitHub
   Vault**. While it is saving, continue typing extra details.
2. When the earlier Save confirms, keep the newer text in the editor.
   The message must explain that pressing Save again **updates the same
   GitHub Note**.
3. Click Save again. Reload the linked Note in Oge: confirm the new text
   replaced the old Note body and **no second Note was created**.
4. Repeat after an interrupted GitHub Update response; retry should
   check/update the same Note ID without creating an unrelated Note.
5. If the subject changes between Saves, treat the new subject as a
   distinct capture and do not rewrite the earlier subject's Note.

Automated simulated extension tests cover these steps; the actual
connected Chrome/GitHub test remains **NOT RUN**. Implementation remains
**8/10 (80%)**; real-account verification remains **0/3**.

## M114 — Keep writing or save a different Note

In the floating extension, start a GitHub Vault Save and type more
while it runs. After success, verify two distinct actions are offered:

- **Update saved GitHub Note:** Pressing the primary Save updates the
  original Note's GitHub content using its confirmed revision.
- **Save this as a separate Note instead:** Select this action if the
  newer text should be a second Note in the *same* subject. The text
  must remain in the editor. Press Save once to create a distinct
  Note ID; confirm the earlier Note is not overwritten.

Neither option should issue a GitHub write until the user presses
the actual Save button. While a request is in flight, switching intent
must be ignored. These cases have scripted tests; **real connected
Chrome/GitHub verification remains pending**. MVP implementation is
**8/10 (80%)**, live tests **0/3**.

## M115 — Subject tabs must not hide older committed Notes

In a private GitHub Vault with at least 21 Notes, create a subject
whose Notes are not in the first loaded UUID-sorted page. Select
that subject. Instead of incorrectly saying **Add your first note**,
the empty state should explain that some Notes may be on later
pages. Click **Find older Notes in this subject**; the Notes should
appear without entering any search phrase.

For larger libraries, search is bounded to 12 pages per click,
with repeated clicks continuing the scan. If the subject genuinely
has no committed Notes, the UI must not invent any.

Simulated pagination tests cover this behavior; live GitHub/Chrome
acceptance is **NOT RUN**. Progress remains **8/10 implemented,
0/3 real-account journeys**.

## M116 — Continue typing during Save in the full Notes editor

1. Create a **new** Note in GitHub Notes and start Save.
2. While GitHub responds, add more text in the same editor.
3. When Save confirms the submitted version, check that the editor
   **stays open** with the extra text and says another Save will
   **update the same Note**.
4. Press Save again. Reload the library and confirm the final text
   survives in **one Note ID**, without a duplicate or a 409 conflict.
5. Repeat while **editing an existing Note** to confirm the new
   GitHub SHA is used for the second Save.
6. Repeat with a fast reload between the confirmed first Save and
   the 700 ms temporary-draft autosave. Open that committed Note
   and accept browser draft recovery; the newer text should remain.

These sequences have scripted provider and source tests, but still
require actual connected-account verification. Overall score:
**8/10 built, 0/3 live journeys independently passed**.

## Explicitly not doing next

Do not add new physical-device attestation, HMAC chains, cryptographic report
signatures, quarantine controls, or arbitrary release-evidence milestones just
because the number of milestones increases. Keep normal account isolation,
owner-scoped Notes, explicit Save, and non-destructive handling of failures.
Security work is triggered by a real defect, not by a milestone quota.

**No invented completion percentage.** A product is ready when its user
journeys have been tested successfully. A passing CI build is not a claim
that the browser-to-GitHub flow has been exercised with real credentials.
