import { MongoClient } from 'mongodb';

const options = { maxPoolSize: 10, minPoolSize: 0, appName: 'oge-notes' };
let clientPromise;
let indexesPromise;

export async function getDatabase() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB || 'oge_notes';
  if (!uri) throw new Error('MONGODB_URI is not configured on the server.');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new Error('MONGODB_DB contains an invalid database name.');

  if (!globalThis.__ogeMongoClientPromise) {
    const client = new MongoClient(uri, options);
    globalThis.__ogeMongoClientPromise = client.connect().catch((error) => {
      globalThis.__ogeMongoClientPromise = undefined;
      throw error;
    });
  }
  clientPromise = globalThis.__ogeMongoClientPromise;
  const client = await clientPromise;
  const db = client.db(databaseName);

  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection('users').createIndex({ googleSub: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }),
      db.collection('notes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('notes').createIndex({ ownerId: 1, reviewDueAt: 1 }),
      db.collection('subjects').createIndex({ ownerId: 1, name: 1 }, { unique: true }),
      db.collection('quickNotes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('personalQuickNotes').createIndex({ ownerId: 1, updatedAt: -1 }),
      db.collection('savedLinks').createIndex({ ownerId: 1, createdAt: -1 }),
    ]).catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }
  await indexesPromise;
  return db;
}
