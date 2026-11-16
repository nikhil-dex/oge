# Oge Vault — E8 / Milestone #76: one-time signed standalone restore approval

**Status:** independent, default-OFF, isolated staging-only 10-minute HMAC
approval receipt, bound to the signed account and the exact M75 one-kind
Quick Notes/AirNotes source/selection/target. Atomic one-time claim and
metadata-only confirmation integrated into the M75 owner-exclusive GitHub
CAS writer. **NOT a production restore UI, independently authenticated
source backup, or operator lock-release authorization.**

## Threat model

The M75 selection fingerprint is an ordinary SHA-256 digest of untrusted
source JSON, not a secret, OAuth identity, signed owner approval or bearer
token. M76 requires a separate **HMAC-SHA256** approval issued only after
the signed user submits an explicit authorization request on the exact
HTTPS staging origin. It binds:

- Auth.js `ownerId` and current `sessionVersion` incarnation
- Verified private GitHub App `repoId`, `installationId`, `repoName`,
  `githubAccountId` and `githubLogin`
- Exactly one resource kind (`quick-notes` or `airnotes`), 1–12 distinct
  canonical UUIDs, expected GitHub destination HEAD, source commit SHA,
  complete M73 source archive SHA-256 and the exact reviewed M75
  `expectedSelectionFingerprint`
- Unique UUID nonce, absolute issuance time and a **10-minute expiry**

Ticket is HMAC-SHA256 using an **independently generated 64-hex-character
32-byte server-only key** `OGE_VAULT_STANDALONE_RESTORE_APPROVAL_KEY`.
The HMAC domain prefix is **different** from legacy Notes M59 tickets.
Changing any bound value, impersonating a different session/owner/repo,
changing kind or selected UUIDs, using a Notes restore receipt, changing
HMAC, or submitting an expired receipt is rejected. This receipt is
**not authentication of the contents of a third-party backup**.

## Staging-only configuration (ALL DEFAULT OFF)

```sh
OGE_VAULT_STANDALONE_RESTORE_APPROVAL_PREVIEW=false
# OGE_VAULT_STANDALONE_RESTORE_APPROVAL_KEY=<dedicated secure 64-hex secret>
OGE_VAULT_STANDALONE_RESTORE_INTENT_PREVIEW=false
OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW=false
OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK=NO
```

For authorized disposable staging testing only, the M70/M71/M73/M74/M75
preview flags, isolated staging `MONGODB_DB`, verified private GitHub App,
`checkVaultStagingReadiness`, and exact `AUTH_URL=OGE_STAGING_URL`
are also required. HTTP request URL and `Origin` must exactly match
the configured staging **HTTPS** origin. The issuer needs the independent
approval flag. The writer needs the approval flag, commit flag AND
`OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK=YES_DISPOSABLE_SIGNED_STAGING_ONLY`.
No production URL, broad GitHub token, public callback or ordinary user
Notes path may satisfy these gates. The key is not checked in to Git.

## 3-stage explicit workflow

1. **Review only:** `POST /api/vault/backup-current-resources/intent`
   using the full M73 archive and `confirmation:
   "PREPARE_SELECTED_STANDALONE_CREATE_ONLY"`. It returns the exact
   fingerprint of a reviewed safe-to-create candidate set, but no write
   authority, as implemented in M75.
2. **Issue one-time signed approval (NO GitHub write):**
   `POST /api/vault/backup-current-resources/authorize` with the
   **same complete in-memory M73 archive**, kind, selectedIds, expected
   target HEAD and `expectedSelectionFingerprint`, but confirmation
   `"AUTHORIZE_SELECTED_STANDALONE_CREATE_ONLY"`. The server validates
   the entire archive **and redoes the fresh M74 plan and exact selected-kind
   GitHub/draft check**, checks the fingerprint, verifies current owner
   and privately signed repo mapping, issues the HMAC ticket and durably
   records hashed nonce/approval metadata only. The response includes the
   ticket and expiration (no raw note text, no GitHub write).
3. **Commit only with the receipt:**
   `POST /api/vault/backup-current-resources/commit` with the **same M75
   commit request** and an additional `ticket` string. Confirmation must
   be `"COMMIT_SELECTED_STANDALONE_CREATE_ONLY"`. M76 verifies ticket
   MAC, exact signed identity, archived content fingerprint/IDs/type/HEAD,
   and expiry **before** acquiring the existing owner import lock. INSIDE
   the durable exclusive owner lock, it atomically transitions exactly
   one matching receipt `pending → claimed` in MongoDB, then calls the
   M75 create-only writer after independent GitHub target/draft rechecks.
   A confirmed GitHub write is followed by an in-lock metadata-only
   receipt update `claimed → confirmed`, binding the verified commit SHA.
   Only then may the existing import fence release successfully.

The `authorize` request shape is the exact M75 commit request except for
the distinct `AUTHORIZE_` confirmation. The `commit` request shape is
the exact M75 commit request plus the issued `ticket`. Never embed note
bodies directly in a ticket or copy raw backup JSON into issue trackers.

## One-time / failure policy

MongoDB contains only **`vault_standalone_restore_approvals`** documents:
owner ID, session incarnation, GitHub repo/install IDs, SHA-256 nonce hash,
SHA-256 approval binding hash, timestamps, state and eventual Git commit SHA.
**NO** note bodies, archive JSON, source text, OAuth credentials, raw HMAC
key, raw signed ticket or draft ciphertext. Separate legacy Notes M59
`vault_restore_approvals` records remain untouched.

Claim uses a single conditional atomic `findOneAndUpdate` (same owner,
session, repo and installation; nonce and approval hash match; `state:
pending`; `expiresAt > now`). Concurrent duplicates have at most
one success; all replays fail. A confirmed receipt is never reusable.

An earlier **claimed but unconfirmed** standalone restore blocks issuance
of another ticket AND claim of any previously issued pending ticket for
that owner/repo/installation. This disallows re-login and parallel ticket
workarounds for a possible GitHub write. A failed claim or prewrite attempt
is consumed, not automatically reset or reissued.

If GitHub's CAS response is ambiguous or the final receipt confirmation
fails, the existing durable `vaultImportLock.github-write-possible` state
is retained to quarantine the account; no blind retry, automatic unlock,
silent repair, overwrite, or draft clearing. A private operator must
compare exact owner, repo/installation, selected IDs, original request
and immutable Git commit/tree/blob evidence before considering future
reconciliation. A later milestone must supply a safe, independently
audited operator read-only reconciliation and one-time controlled release
workflow. **This milestone does NOT authorize releasing the lock.**

MongoDB TTL removes old receipt history after seven days for bounded
staging retention. TTL is **never** relied on for the 10-minute claim
authorization; expiration is checked in every claim query. A GitHub
write-suspect import lock has NO automatic TTL.

## Testing and limitations

- `tests/oge-vault-standalone-restore-ticket.test.js` checks HMAC expiry,
  owner/session/repo/installation/account binding, UUID/kind/content
  fingerprint, tampering, source scope, one-time route sequencing and
  isolation from legacy Notes approval.
- `tests/mongodb-vault-standalone-restore-ticket.test.js` uses a
  disposable local MongoDB replica set to check atomic concurrency,
  duplicate nonce, source-content-free metadata, revoked session,
  changed GitHub installation, held import lock and expiry.
- M75 GitHub CAS regression suite still checks exact file/draft/HEAD
  guards, single force:false PATCH, read-only recovery after a lost
  acknowledgement and no automatic replay.

**Still NOT done:** live GitHub OAuth/App two-physical-device acceptance,
actual user-facing 3-step restore UX, independent backup-source
provenance/signature, operator recovery and lock release, complete account
backup beyond 300 standalone items/8 MiB, legacy extension/Learning
Tracks storage cutover, independent crypto/security review and production
rollout.

**Keep PR #35 DRAFT and UNMERGED. All staged restore and write flags
remain OFF. No live user data was changed.**
