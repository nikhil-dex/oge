# Oge Notes — implementation progress scorecard

**Updated 18 November 2026, after milestone #106 code changes.**
This progress measure is deliberately about the practical note-taking MVP,
not the previous uncalibrated ~96% prototype number.

## Progress snapshot

- **Implementation checkpoints: 7/10 (70%) implemented in the draft branch.**
  This is a count of agreed deliverables, NOT a percentage estimate of
  engineering effort, production readiness, or operational reliability.
- **Real-account end-to-end journeys independently verified here: 0/3 (0%).**
  Automated CI, synthetic MongoDB integration and browser smoke tests do not
  prove that signing in and committing to GitHub work on a deployed site.
- **Production released: No.** PR #35 remains draft and unmerged. Deployment
  is the last item. Check the current GitHub Actions run before declaring
  final CI success.

## Exactly what 7/10 means

| # | Concrete user outcome / delivery checkpoint | Implementation | Live connected-account proof |
| --- | --- | --- | --- |
| 1 | Sign in and connect a personal private GitHub Vault | Built | Pending |
| 2 | Create, read, edit, favorite and delete committed GitHub Notes | Built | Pending |
| 3 | Create and select study subjects | Built | Pending |
| 4 | Temporary draft autosave plus explicit GitHub Save | Built | Pending |
| 5 | Quick Capture: first-line title, subject selector, ready next note | Built | Pending |
| 6 | Find Notes beyond first 20 via progressive GitHub page loading | Built | Pending |
| 7 | Visible draft-versus-GitHub Save state, word counts, direct reader Edit, accessible Save and keyboard shortcut | M106 implemented | Pending |
| 8 | Quick Notes, AirNotes and browser extension converge on GitHub | Not yet | Pending |
| 9 | Real-account create/edit/save/reload/recover/search/mobile journeys verified | Not yet | Pending |
| 10 | Production cutover, merge and deployment with no lost Notes | Not yet | Pending |

The original Notes and independent Quick Notes/AirNotes/extension paths still
exist. M106 is editor/UI development; it does not turn on deployment or
migrate historical test notes.

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
2. Convert legacy Quick Notes, AirNotes and extension saves to the same
   GitHub destination without duplicating permanent Note content in MongoDB.
3. Fix genuine reported editor/mobile defects, then perform cutover last.

**Rule:** Do not inflate implementation progress after adding tests or
documentation alone. Advance a checkpoint only after its user-facing
function exists in code. Live acceptance is separately recorded.
