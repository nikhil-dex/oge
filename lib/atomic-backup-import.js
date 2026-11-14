/**
 * Backup imports span several collections. A transaction prevents a provider
 * outage or validation/write conflict from leaving a partially restored
 * workspace. Require replica-set/Atlas transaction support; fail closed on
 * standalone MongoDB rather than silently falling back to partial writes.
 */
export async function withAtomicBackupImport(db, work) {
  const session = db.client.startSession();
  try {
    return await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}
