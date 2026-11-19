/**
 * M67: strictly redacted operator-side TWO-device live staging EVIDENCE MATRIX.
 *
 * A manifest is only an untrusted inventory of external observations. It
 * cannot independently authenticate GitHub, OAuth, physical devices or logs.
 * It NEVER authorizes a GitHub write, production cutover or lock release.
 *
 * Pure: no fetch, env, MongoDB, filesystem, browser storage or credentials.
 */
const FORMAT = 'oge-vault-two-device-external-evidence';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const expectedFields = (obj, keys) => Boolean(
  obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...keys].sort().join(','));
const SCENARIOS = Object.freeze({
  'oauth-device-a': 'device-a',
  'oauth-device-b': 'device-b',
  'private-app-installation-read': 'operator',
  'read-only-app-write-denial': 'operator',
  'create-only-git-cas': 'operator',
  'stale-git-head-409-422': 'operator',
  'provider-rate-limit-429': 'operator',
  'installation-revocation-403': 'operator',
  'lost-write-response-quarantine': 'operator',
  'second-device-autosave-fence': 'device-b',
  'encrypted-backup-reopen': 'device-a',
  'physical-file-download-check': 'device-a',
});
const MANIFEST_FIELDS = ['format','version','runId','origin','startedAt','records'];
const RECORD_FIELDS = [
  'scenario','channel','observedAt','outcome','evidenceSha256','sessionMarker',
];
const fail = () => {
  throw new TypeError('Invalid or unsafe external staging evidence manifest');
};
const parseTime = (value) => {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    fail();
  const ts = Date.parse(value);
  if (!Number.isFinite(ts) || new Date(ts).toISOString() !== value) fail();
  return ts;
};
const parseOrigin = (input) => {
  try {
    const value = new URL(input);
    if (value.protocol !== 'https:' || value.origin !== input ||
        value.username || value.password || value.search || value.hash ||
        value.pathname !== '/' || value.hostname === 'localhost' ||
        value.hostname === '127.0.0.1')
      fail();
    return value.origin;
  } catch { fail(); }
};

/**
 * Review submitted metadata from *outside* the application.
 * A matching case/hash/session marker is NEVER verification of genuine
 * captured evidence or proof of two physically separate browser devices.
 */
export function inspectVaultTwoDeviceEvidenceManifest(manifest, {
  expectedOrigin, now = Date.now(),
} = {}) {
  if (!expectedFields(manifest, MANIFEST_FIELDS) ||
      manifest.format !== FORMAT || manifest.version !== 1 ||
      !UUID.test(manifest.runId || '') ||
      !Number.isFinite(now) ||
      !Array.isArray(manifest.records) ||
      manifest.records.length > Object.keys(SCENARIOS).length ||
      parseOrigin(manifest.origin) !== parseOrigin(expectedOrigin))
    fail();
  const start = parseTime(manifest.startedAt);
  if (start < now - WINDOW_MS || start > now + FUTURE_SKEW_MS) fail();

  const used = new Set();
  const artifacts = new Set();
  const witness = {};
  const failed = [];
  for (const item of manifest.records) {
    if (!expectedFields(item, RECORD_FIELDS) ||
        !Object.hasOwn(SCENARIOS, item.scenario) ||
        SCENARIOS[item.scenario] !== item.channel ||
        used.has(item.scenario) || !DIGEST.test(item.evidenceSha256 || '') ||
        artifacts.has(item.evidenceSha256) ||
        !['observed-pass', 'observed-fail'].includes(item.outcome))
      fail();
    const observed = parseTime(item.observedAt);
    if (observed < start || observed > now + FUTURE_SKEW_MS) fail();
    if (item.channel === 'operator') {
      if (item.sessionMarker !== null) fail();
    } else {
      if (!UUID.test(item.sessionMarker || '')) fail();
      const current = witness[item.channel];
      if (current && current !== item.sessionMarker) fail();
      witness[item.channel] = item.sessionMarker;
    }
    used.add(item.scenario);
    artifacts.add(item.evidenceSha256);
    if (item.outcome === 'observed-fail') failed.push(item.scenario);
  }
  if (witness['device-a'] && witness['device-b'] &&
      witness['device-a'] === witness['device-b']) fail();

  const missing = Object.keys(SCENARIOS).filter((id) => !used.has(id));
  const complete = !missing.length && !failed.length &&
    Boolean(witness['device-a'] && witness['device-b']);
  return Object.freeze({
    format: 'oge-vault-two-device-evidence-inventory-report', version: 1,
    status: complete ? 'EVIDENCE_INDEX_READY_FOR_INDEPENDENT_REVIEW'
      : 'EVIDENCE_INCOMPLETE_OR_FAILED',
    observedScenarioCount: used.size,
    requiredScenarioCount: Object.keys(SCENARIOS).length,
    missingScenarios: missing,
    reportedFailedScenarios: failed,
    differentSessionMarkersReported: Boolean(
      witness['device-a'] && witness['device-b'] &&
      witness['device-a'] !== witness['device-b']),
    evidenceHashesIndependentlyChecked: false,
    physicalDevicesIndependentlyVerified: false,
    realGitHubProviderIndependentlyVerified: false,
    externalOperatorAttestationVerified: false,
    completeStagingAcceptanceSignedOff: false,
    canAuthorizeGitHubWrites: false,
    canEnableProduction: false,
    canReleaseImportLock: false,
    canRetryUnknownWrite: false,
    privacySensitiveValuesReturned: false,
    noDatabaseOrGitHubRequestsPerformed: true,
  });
}

export const VAULT_TWO_DEVICE_SCENARIO_IDS = Object.freeze(
  Object.keys(SCENARIOS));
