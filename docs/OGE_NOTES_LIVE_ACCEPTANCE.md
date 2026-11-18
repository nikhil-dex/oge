# Oge Notes — real-account smoke test (M110)

**Status: not yet executed against a connected GitHub account.**
This is a simple user-flow checklist, not a security attestation or release gate.
Green CI verifies code tests, not this live journey.

## Preconditions

- Run Oge locally with a working signed-in user, MongoDB user/subject
  metadata, and the existing private GitHub App Vault connection.
- Set the already-required `OGE_VAULT_MAIN_PREVIEW=true` and
  `OGE_VAULT_HYBRID_DRAFT_PREVIEW=true` in the local runtime.
- Confirm the GitHub App can write to the private **owner's** Vault.
- Do not paste tokens, private Note text, or passwords into test reports.
- Use a throwaway subject and ordinary disposable Note text. Historical
  Quick Notes and AirNotes are **not** automatically migrated.

## Live journey A — create, Save, reload, edit

1. Sign in and open **Home → Notes** (should open `/vault/notes`).
2. Add a subject, create a Note with a title and body, then press
   **Save to GitHub** or ⌘/Ctrl+Enter.
3. Reload the page and confirm the Note appears with identical text.
4. Repeat with a slow first Save: type additional words while the
   request is pending, then press Save again and confirm GitHub updates
   **the same Note ID** without a duplicate or 409 conflict. Retry
   with an existing Note and a fast reload to check newer browser text.
5. Open it, choose **Edit note**, update its body and Save.
6. Reload again, verify the updated text, and inspect the private GitHub
   repository to confirm the file exists.
7. Confirm that the corresponding content was not inserted permanently
   into MongoDB's legacy `notes` collection.

**Pass only if** the committed text survives the full reload and edit cycle.

## Live journey B — local browser copy before temporary autosave

1. Open **Quick Notes** or **AirNotes** while Vault is connected; this
   should route to `/vault/capture`.
2. Select a subject (a single available subject selects automatically).
3. Type a one-line thought and reload immediately, before the 900 ms
   autosave timer can finish. The browser may have a local copy even if
   no encrypted server draft exists.
4. Accept **Recover your browser-only note?** when offered.
5. Confirm the exact text is present and **writable**; edit the text and
   Save. Reload **GitHub Notes** and verify the final content.
6. Repeat after allowing the server draft autosave to finish. Recovery
   should preserve the text, not duplicate the first line.
7. If the same Note was already committed but local cleanup failed, the
   recovery flow should detect it instead of creating a second copy.

**Pass only if** the original text is retained and a valid GitHub
commit/reload follows the recovery. Note failures and the browser behavior.

## Live journey C — extension, larger libraries and mobile

1. Reload the local **unpacked** extension from `extension/`, reconnect
   using its existing extension token, and open the floating widget on
   a permitted HTTP(S) page.
2. The connected account should see a subject and **Save to GitHub Vault**.
   Type a one-line thought and Save, then reload `/vault/notes` and
   find the Note under the chosen subject.
3. Click **View last saved GitHub Note** in the extension. The
   actual Note reader should open automatically (not just the Notes
   page/subject). Click **Edit note**, Save, and ensure the old reader
   does not reopen after the list refresh.
4. Attempt a slow or interrupted Save. The widget must keep the text
   until success is confirmed; a retry with identical input should not
   create a duplicate.
5. Test continued typing while Save is pending. The newer text must
   remain and be labeled as needing a separate Save. Press Save again,
   then reload the linked Note: the same Note ID should contain the
   updated text, with no second Note created. Repeat after starting
   another Save and typing a different thought: choose **Save this as a
   separate Note instead**, then Save. Confirm the second Note has a
   different UUID, in the same subject, and the first Note was not
   overwritten.
6. Create or use at least 21 Notes; search for a later-page Note using
   **Search remaining GitHub Notes**. Also select a subject whose Notes
   are absent from the initial 20 GitHub files: select
   **Find older Notes in this subject** and confirm committed Notes
   appear instead of being mistaken for an empty new subject.
7. At a mobile viewport, open an existing Note, edit, Save and reload.
   The Save button should remain accessible.

**Pass only if** the extension Save and later-page/mobile editing all
roundtrip correctly with a real GitHub account.

## Results

| Journey | Live result | What to record |
| --- | --- | --- |
| A · Save → reload → edit | NOT RUN | App URL/environment, steps, expected vs actual |
| B · Local draft recovery | NOT RUN | Before/after text, recovery choice, final GitHub result |
| C · Chrome + larger library + mobile | NOT RUN | Chrome version, extension behavior, Note roundtrip |

Do not mark a journey passed on the strength of a mocked response,
a GitHub Actions check, or a code inspection. Record actual user-visible
results. If any step fails, fix the concrete issue first.

## Mac development commands

```bash
git fetch origin
git switch feature/oge-vault-foundation
git pull --ff-only origin feature/oge-vault-foundation
npm install
npm test
npm run dev
```

Use your normal local environment files and existing Vault App setup.
Never commit secrets. Launch `http://localhost:3000` only if that is
your configured local origin.
