#!/usr/bin/env node
/**
 * Explicit, read-only Phase C legacy note inventory.
 * NEVER call getDatabase() here: its initialization creates indexes.
 * Requires a separately provided database name and operator acknowledgment.
 *
 * No content, note titles, owner IDs, credentials or connection strings are
 * printed, copied or persisted. Does not delete, migrate, or modify data.
 */
import { MongoClient } from 'mongodb';
import { inspectVaultLegacyData } from '../lib/oge-vault-legacy-inventory.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
if (process.env.OGE_VAULT_INVENTORY_READ_ONLY !== 'YES_COUNTS_ONLY' ||
    typeof uri !== 'string' || !uri ||
    typeof dbName !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(dbName)) {
  console.error('BLOCKED: explicitly set MONGODB_DB, MONGODB_URI and OGE_VAULT_INVENTORY_READ_ONLY=YES_COUNTS_ONLY to inspect counts.');
  process.exitCode = 1;
} else {
  const client = new MongoClient(uri, {
    appName: 'oge-vault-inventory-read-only', serverSelectionTimeoutMS: 8000,
    maxPoolSize: 2,
  });
  try {
    await client.connect();
    const report = await inspectVaultLegacyData(client.db(dbName));
    console.log(JSON.stringify(report, null, 2));
    // Even a synthetic legacy fixture blocks automatic cleanup/cutover;
    // an operator must separately document its provenance.
    if (report.total > 0) process.exitCode = 2;
  } catch (error) {
    // Never show the driver error message; it may contain connection details.
    console.error('Vault count-only inventory failed: ' +
      (error instanceof Error ? error.name : 'UnknownError'));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}
