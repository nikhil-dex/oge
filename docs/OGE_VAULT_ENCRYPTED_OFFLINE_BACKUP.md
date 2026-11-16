# Oge Vault — Milestone #65: Encrypted offline Notes backup retention (staging)

**Status:** implemented behind existing default-off isolated staging gates, synthetic tests only. NOT live signed GitHub two-device acceptance, audited production cryptography, encrypted-file operator restore, or a disaster-recovery guarantee. PR #35 remains draft/unmerged.

## What changed

The M64 browser download offered plain JSON. M65 makes the owner-facing staging download **encrypt each verified chunk with AES-256-GCM before offering a local file**, named part-0001.oge.json through at most part-0016.oge.json. The owner enters and confirms a **unique long passphrase of at least 16 characters**. Each authorized GitHub Notes page is read over HTTPS and verified in memory, then encrypted before the browser creates a downloadable Blob. No plaintext file is offered by this new owner download control.

The browser does not POST passwords, backup contents, or private notes to Oge. It does not persist the password or the backup in MongoDB, localStorage, sessionStorage, or IndexedDB. **The signed HTTPS GET still delivers plaintext note data to the authorized browser JavaScript**, so encryption protects offline files at rest, *not* against a compromised server, page script, browser extension, or endpoint.

## Version 1 encrypted file envelope

Each encrypted JSON file has exactly these fields: format, version, algorithm, kdf, iterations, salt, iv, part, plainBytes and ciphertext.

- Format: oge-vault-offline-encrypted-notes-part; version: 1.
- Algorithm: AES-256-GCM with 128-bit authentication tag.
- KDF: PBKDF2 SHA-256; 600,000 iterations.
- Salt: 16 cryptographically random bytes generated once per new export session, encoded as 32 lowercase hexadecimal characters.
- IV/nonce: fresh cryptographically random 12 bytes for every part, 24 lowercase hexadecimal characters. Repeated IVs are rejected.
- Part number: 1–16; source plaintext length: 2 bytes through 4 MiB.
- Ciphertext: canonical unpadded URL-safe base64 of AES-GCM ciphertext **including appended tag**. Maximum complete encrypted envelope: 6 MiB per part.

The one nonextractable AES-256 key is derived from the password and the per-backup salt. The additional authenticated data (AAD) is UTF-8 JSON.stringify of the ordered header keys: format, version, algorithm, kdf, iterations, salt, iv, part and plainBytes. Thus the version, KDF, salt, IV, page number and declared size are cryptographically bound to the ciphertext. The visible header does NOT include note titles, answers, source Git commit SHAs or user identity; approximate file length and number remain visible.

**Password security:** a password shorter than 16 characters is rejected, but length is not a substitute for entropy. Choose a strong, unique, unpredictable passphrase; PBKDF2 does not prevent offline guessing of weak/reused passwords. Keep it in a password manager separate from backup files. **There is no recovery key, password reset or server escrow.** Lost passwords permanently prevent decrypting the backup.

## Staging owner review of encrypted backups

On the hidden authenticated staging restore review page, select the **complete encrypted file set** and enter the same offline password. The browser verifies exact consecutive file names, maximum sizes, version, common salt, distinct IV, strict format and authenticated AES-GCM per file. It converts each file into a **temporary in-memory decrypted File-like view**, never saving a plaintext file. The existing independent M63 local verifier then rechecks the complete Notes-only chunk sequence, original inventory, selected note content SHA-256 and the exact reviewed M57 fingerprint.

Wrong passwords, tampered ciphertext or header, mixed backup sets, missing/duplicate/renamed parts, unexpected original content, changed selection and malformed Notes fail closed. The password input is cleared after a local verification attempt. Plaintext part-NNNN.json files remain accepted only for controlled older staging review, but the M65 browser export no longer offers them as downloads.

**Critical operator limitation:** the existing M58/M59 restricted restore CLI still requires private 0700 directories with owner-only 0600 PLAINTEXT part-NNNN.json files. It **cannot directly consume encrypted .oge.json files**. A separately security-reviewed operator conversion and temporary-file lifecycle is future work. No signed GitHub provider proof, GitHub write authorization, import-lock release or production restoration follows from merely decrypting locally.

## Data and release limitations

- Current Notes only: up to 1,024 Notes / 16 parts; not revision history, Quick Notes, AirNotes, encrypted drafts or learning progress.
- A browser can block multiple automatic downloads. Successfully encrypting responses is NOT proof that all encrypted files were actually written to disk. Select and verify all saved files independently.
- Individual files are NOT a complete backup; the full ordered inventory and selected fingerprint must verify.
- GitHub source SHA fields embedded in backup files are untrusted claims until the signed owner App operator reads original Git blobs. AES-GCM integrity is not a GitHub signature.
- The current source verification policy cannot authenticate an offline backup after the original GitHub repo and its access disappear. Backup recovery after source deletion and independently attested detached source provenance are **not implemented**.
- A malicious browser extension or injected script can access plaintext/passphrase in the running browser. Restrict use to protected, trusted disposable staging devices.
- This is an experimental versioned cryptographic envelope using standard algorithms but **not independently audited**; review, cross-platform compatibility and real authenticated browser file download/restore testing are release requirements.

## Automated acceptance

Tests include encrypted roundtrip through the actual M63 verifier for 130 Notes and **520 Notes greater than 8 MiB**, wrong password, header/ciphertext tamper, IV/salt/part mismatch, weak KDF, mixed/partial files, no plaintext note text in sealed JSON and read-only no-persistent-storage UI. CI generic Chromium smoke is NOT a live authenticated multi-download staging drill.

Keep PR #35 draft, all production flags off, and real user Notes unchanged.
