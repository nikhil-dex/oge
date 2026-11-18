# Oge Notes — implementation progress scorecard

**Updated 18 November 2026, after milestone #108 code changes.**
This progress measure is deliberately about the practical note-taking MVP,
not the previous uncalibrated ~96% prototype number.

## Progress snapshot

- **Implementation checkpoints: 8/10 (80%) implemented in the draft branch.**
  Checkpoint #8 covers **new captures** from Quick Notes, AirNotes and
  extension. It does NOT claim that historical MongoDB notes were migrated.
  This is a count of agreed deliverables, NOT a percentage estimate of
  engineering effort, production readiness, or operational reliability.
- **Real-account end-to-end journeys independently verified here: 0/3 (0%).**
  Automated CI, synthetic MongoDB integration and browser smoke tests do not
  prove that signing in and committing to GitHub work on a deployed site.
- **Production released: No.** PR #35 remains draft and unmerged. Deployment
  is the last item. Check the current GitHub Actions run before declaring
  final CI success.

## Exactly what 8/10 means

| # | Concrete user outcome / delivery checkpoint | Implementation | Live connected-account proof |
| --- | --- | --- | --- |
| 1 | Sign in and connect a personal private GitHub Vault | Built | Pending |
| 2 | Create, read, edit, favorite and delete committed GitHub Notes | Built | Pending |
| 3 | Create and select study subjects | Built | Pending |
| 4 | Temporary draft autosave plus explicit GitHub Save | Built | Pending |
| 5 | Quick Capture: single-line thoughts or title + body, auto-pick sole subject, ready next note | M108 usability improvements | Pending |
| 6 | Find Notes beyond first 20 via progressive GitHub page loading | Built | Pending |
| 7 | Visible draft-versus-GitHub Save state, word counts, direct reader Edit, accessible Save and keyboard shortcut | M106 implemented | Pending |
| 8 | **New** Quick Notes/AirNotes/extension captures use the GitHub Vault for connected owners | M107 built (legacy records not migrated) | Pending |
| 9 | Real-account create/edit/save/reload/recover/search/mobile journeys verified | Not yet | Pending |
| 10 | Production cutover, merge and deployment with no lost Notes | Not yet | Pending |

The original Notes and independent Quick Notes/AirNotes/extension endpoints
still exist for unconnected accounts. M107 routes connected users' new
standalone captures through the existing GitHub Quick Capture editor, and
the updated extension uses a dedicated owner-connected GitHub writer.
**Historical MongoDB records are untouched and not migrated.** This is not a
promise that all prior AirNotes and Quick Notes appear in the Vault.

## Milestone #108 usability improvements (does not increase the denominator)

- A one-line thought is now enough to create a valid GitHub Note. Its
  first nonempty line becomes a recognizable short title, while the full
  original thought stays in the Note body. Explicit title + body still works.
- For accounts with only one subject, Quick Capture automatically selects it,
  while preserving the existing unfinished-draft recovery path.
- Quick Capture's **Notes** navbar now points to the connected GitHub Notes
  editor instead of the older MongoDB workspace.
- The floating extension shares the same one-line conversion and now explains
  it in the editor. No change to destination, authorization or data store.
- Real GitHub and Chrome verification remains pending. This is polish on
  existing checkpoint #5, so the implementation score remains **8/10 (80%)**
  and real account verification remains **0/3**.

## The three mandatory live journeys

1. **Committed Note roundtrip:** Connect real GitHub Vault, create subject,
   write Note, Save, reload/sign in again, edit and confirm GitHub Note content.
2. **Draft interruption and recovery:** Type an unsaved draft, interrupt the
   connection or reload, confirm the draft is recoverable, then explicitly
   Save without claiming GitHub success prematurely.
3. **Large library and mobile editing:** Search for an older Note beyond the
   first 20, Stop/Continue as needed, open in reader, tap Edit, change
   content on mobile, Save, reload and verify the Note.

Record actual environment, reproduction, expected/actual results, and
pass/fail for each live run. No extra cryptographic attestation required.

## Next work, in order

1. Finish merging the everyday GitHub Notes paths from the existing feature
   branch after a successful live smoke run.
2. Verify connected Quick Notes / AirNotes entry and extension subject Save
   with a real account and browser; ensure old extension versions clearly
   reject legacy writes for connected owners. Historical MongoDB records stay
   intact unless a separately requested migration is needed.
3. Fix genuine reported editor/mobile defects, and handle the existing
   legacy-note history if it turns out not to be disposable test data.
   Perform production cutover last.

**Rule:** Do not inflate implementation progress after adding tests or
documentation alone. Advance a checkpoint only after its user-facing
function exists in code. Live acceptance is separately recorded.
