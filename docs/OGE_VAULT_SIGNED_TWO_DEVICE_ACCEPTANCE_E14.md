# Oge Vault — E14 / Milestone #82: signed-in staging acceptance observation

**Status:** implemented protected, default-OFF, READ-ONLY staging-only
endpoint and regression tests. This is a prerequisite for real OAuth and
GitHub App two-physical-device staging acceptance, **not signoff**. No
production login, live OAuth, physical devices or provider fault injection
has been executed as part of this milestone.

## New authenticated staging endpoint

POST /api/vault/acceptance/signed-device-read

Independently default OFF:
OGE_VAULT_SIGNED_DEVICE_ACCEPTANCE_READ_PREVIEW=false

Explicitly enable only in disposable, independently reviewed HTTPS
same-origin staging, with MONGODB_DB=oge_vault_restore_staging_<disposable>,
OGE_STAGING_URL=AUTH_URL, matching OGE_VAULT_BASE_URL origin,
checkVaultStagingReadiness passing with dedicated staging OAuth and
GitHub App credentials and appropriate Vault preview flags. All
destructive/cutover flags and **standalone restore COMMIT/write ACK
must remain OFF**. The gate rejects wrong Origin, wrong callback origin,
production DB, non-HTTPS, incomplete staging setup, and unsafe flags
before connecting to private data.

The POST route requires a CURRENT signed-in Auth.js owner session
and a matching private GitHub App repo/account/installation binding.
It obtains two independent contents:read-only GitHub App clients for
the SAME signed owner. Reusing the existing M61 provider read-only pair
probe, it checks the same private Git branch HEAD, immutable commit
tree, unchanged repository identity and owner identity with
revalidation, then returns a redacted no-store report. It reads no
private Notes or draft bodies and requests no write-scoped token.

## Request: fresh challenge, one browser at a time

The JSON object has precisely challenge and deviceSlot:

~~~json
{
  "challenge": "<64 lowercase hex characters, 32 bytes random>",
  "deviceSlot": "device-a"
}
~~~

Allowed labels: device-a and device-b only. These are UNTRUSTED caller
claims and DO NOT prove separate physical hardware. No nonce replay
ledger is maintained; the SHA-256 domain-separated challenge fingerprint
in the response is merely a correlation value, not a signature.

After independent operator verification of the HTTPS staging URL and
existing signed-in disposable session, on each physical device use:

~~~js
const random = crypto.getRandomValues(new Uint8Array(32));
const challenge = Array.from(random, x => x.toString(16).padStart(2, '0')).join('');
const deviceSlot = 'device-a'; // use device-b on the other device
const response = await fetch('/api/vault/acceptance/signed-device-read', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ challenge, deviceSlot }),
});
const observation = await response.json();
console.log(response.status, observation);
~~~

Never log raw passwords, cookies, OAuth tokens, GitHub tokens, private
notes, user IDs or signing keys. Keep captured response and
physical-device verification artifacts in private redacted operator
storage, not in public GitHub issues or CI.

The endpoint response includes only the operator-declared slot and
the challenge fingerprint, booleans and classification. It never
returns raw nonce, GitHub SHA, owner/repo ID, OAuth account name,
Note content or tokens. Response Cache-Control is private, no-store.

## What is observed and what is NOT proven

Positive status:
SIGNED_SESSION_PRIVATE_GITHUB_READ_OBSERVED_PENDING_EXTERNAL_ACCEPTANCE

This means the application accepted a currently signed-in Auth.js
session and performed two separately scoped, immutable private GitHub
App contents:read checks against a stable owner mapping. It does NOT
independently authenticate the upstream OAuth issuer or prove that
two physical devices or two distinct Auth.js sessions were used.

Every report explicitly includes:
- deviceSlotProvesPhysicalDevice:false
- actualOAuthProviderIndependentlyVerified:false
- physicalDeviceIdentityIndependentlyVerified:false
- twoDistinctPhysicalDeviceSessionsVerified:false
- multiDeviceAutosaveAndConflictFlowVerified:false
- realProviderFaultMatrixVerified:false
- completeStagingAcceptanceSignedOff:false
- canAuthorizeGitHubWrites:false
- canAuthorizeRestore:false
- canReleaseImportLock:false
- canRetryUnknownWrite:false
- githubWritesPerformed:false
- mongodbWritesPerformed:false

Two read-only GitHub App tokens under one signed-in session do NOT
constitute a two-device acceptance test. A user can arbitrarily choose
device-a/device-b, repeat challenges or fabricate an exported JSON
report. An independent real-device operator must validate network
captures and signed-in sessions; this endpoint is not a remotely
signed, hardware-attested proof.

## Real acceptance checklist — still PENDING

1. Provision dedicated nonproduction OAuth/App and private disposable
   vault installation/repository, HTTPS staging deployment and
   isolated Mongo replica. Verify Auth.js callback mapping and
   GitHub App permissions against the real provider, no write flags.
2. On TWO PHYSICAL browser devices separately sign in, verify actual
   OAuth issuer and fresh signed Auth.js owner mapping, record private
   browser network evidence and submit different random M82 challenges.
3. Repeat with permission revocation/reconnection; independently verify
   the operator's physical devices, session provenance and the real
   GitHub App installation permissions. Execute existing M61
   read-only provider probe and M67/M68 redacted two-device evidence
   manifest and file hash verifier. Those tools are only evidence
   inspectors, never automatic acceptance signoff.
4. Separately authorize only disposable test data before exercising
   multi-device autosave, stale Git CAS 409/422, 429 throttling,
   App revocation 403, lost response/write uncertainty, encrypted
   backup restore or retention scenarios. No write/failure scenario
   is executed by M82.
5. Have an independent security operator review actual data,
   original OAuth sessions and credible source capture. Until
   completed, do NOT mark live acceptance signed off, merge, deploy,
   enable production or clear an uncertain github-write-possible lock.

## Synthetic regression suite

~~~sh
node --test tests/oge-vault-signed-device-acceptance.test.js
npm run lint
npm test
npm run build
~~~

Covers signed owner mapping, independent read-only GitHub clients,
moving HEAD, changed tree, provider permissions, revoked owner,
invalid challenge, wrong client/installation, unsafe staging/Origin,
write-flag denial and no mutation endpoints.

No real user Notes or drafts were modified. No staging acceptance flag
was enabled. PR #35 remains DRAFT and UNMERGED.

## E15 / Milestone #83 — M82 two-device observation pairing with M67/M68

A distinct default-OFF **offline** command,
`npm run vault:staging:review-signed-device-pair`, correlates the
exact private M67 run UUID and M68 verified on-disk artifact hashes
for the 12-scenario live-staging checklist with **two separately
captured M82 redacted signed-in read-only response objects**. The
original 32-byte random challenges for A and B and the M67 run UUID
must come from an independent protected operator channel, NOT from
the pair file. Rejects duplicated/swapped/cross-run device labels,
wrong challenge fingerprints, fabricated positive acceptance flags,
missing/failed scenarios, changed artifact file bytes and unsafe
private paths. Uses the SAME validated M67 manifest object that M68
used to verify all private scenario file bytes, preventing an
intermediate re-read from mismatching observed run metadata.
Even the best case yields **HOLD exit 2, indexed for MANUAL review**;
incomplete is **HOLD exit 3**, malformed/unsafe is **exit 1**. No exit
0, no network calls, GitHub/Mongo mutations, private Notes, OAuth
or import-lock release. The M82 reports are not signed source
proofs, and self-reported M67 session markers are NOT independently
bound to real M82 devices. Real GitHub OAuth/App and two physical
device acceptance remain unperformed.
See docs/OGE_VAULT_SIGNED_TWO_DEVICE_ACCEPTANCE_PAIR_E15.md.
