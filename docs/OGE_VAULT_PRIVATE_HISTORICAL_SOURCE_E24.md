# Oge Vault — E24 / Milestone #92
## Bounded private GitHub historical archive source authentication

**Scope:** owner-only, isolated HTTPS staging, independent opt-in; no import, restore, post-write quarantine release, or GitHub mutation.

### Operator flow and security model

1. The signed-in owner selects two separate local JSON files in `/vault/recovery`: a **historical backup candidate** and a **current reference**. Each file is capped at 8 MiB and independently validated using M88 exact UTF-8/canonical JSON, row/schema/count constraints and embedded inventory+archive SHA-256 digests. No network request occurs before both pass.
2. With `OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW=true` and ALL M91/M89/M87 gates satisfied, the browser POSTs **only the historical backup's 10-field claim** (format/version/confirmation, snapshot/tree Git SHA, archive+inventory SHA-256, three counts) to `/api/vault/backup-current-resources/history-check`. No Note body/title/subject/UUID or archive bytes go to the server.
3. After independent owner-session and private GitHub App `contents:read` acquisition, the server walks at most **20 single-parent edges** from the authenticated owner's **current HEAD**. Missing/inaccessible commits, merged branch parents, unsigned/unreachable detached snapshots, stale HEAD and provider errors fail closed.
4. Once the claimed commit is proven to be on that bounded path, the existing canonical M73 exporter reads its immutable historical tree and all Notes, Quick Notes and AirNotes blobs, checking **actual Git blob bytes against Git SHA-1 object IDs** and rebuilding full inventory/archive SHA-256 digests. It enforces current owner subject ownership and checks the LIVE HEAD remains stable at the end of the scan.
5. The API rechecks the signed owner/session/repository/installation binding and emits **only a redacted match/HOLD boolean and immutable negative permission flags**. A separate rate limit restricts historical scans to 2 per owner/hour (MongoDB transient metadata only).
6. Only if historical authentication passes does the browser call M89's independent authenticated **current** reference comparison. When BOTH source checks match, it displays local redacted aggregate additions/conflicts/unchanged/current-only resources. On either hold/error, it shows no authoritative plan.

### Capabilities NOT implied by a match

- This is **GitHub-source authentication conditional on the trusted Oge server and GitHub App**, not a detached cryptographically signed attestation, timeless proof or a transactional restore lock. Bounded ancestry deliberately does not attest commits beyond 20 linear parents, rebased/deleted histories, complex merges, and detached snapshots; those fail closed.
- The historical and current checks are **two separate point-in-time operations**, so another writer can change the repository between or after checks. Recheck current HEAD immediately before any future authorized write; no such write path is enabled here.
- A valid historical file is not a complete account backup: revisions, encrypted drafts, Learning Tracks and legacy Mongo notes are excluded. Historical subject deletion can cause conservative HOLD.
- There is no import/delete/merge, automatic retry of uncertain GitHub writes, manual lock release, draft cleanup, production cutover or post-write quarantine unlock.
- The browser can temporarily hold plaintext during inspection; secure erasure cannot be promised. The interface stores only counts/booleans in React state.
- Tests for this milestone use synthetic GitHub clients. **Live provider OAuth, two physical devices, provider fault/timeout/403/429 acceptance and external security review remain pending.** Never turn this on for actual production users.

### Flags

```env
OGE_VAULT_RECOVERY_CENTER_PREVIEW=false
OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW=false
OGE_VAULT_RESTORE_SOURCE_PREVIEW=false
OGE_VAULT_HISTORICAL_SOURCE_CHECK_PREVIEW=false
```

Enabling the final flag without all underlying isolated staging prerequisites leaves the historical feature unavailable. The server independently enforces every gate and signed-owner read access.

### Next

M93 should focus on **stale-state and multi-step recovery guardrails**: require independent revalidation of both sources before any future owner-reviewed write proposal, explicitly document operator decision states, and complete real GitHub OAuth/App provider acceptance. Keep restore disabled until audited authorization and unknown-write quarantine protections are demonstrated.
