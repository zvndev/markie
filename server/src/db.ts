import Database from "better-sqlite3";

const DEFAULT_PATH = "./markie.db";

// Every handle openDatabase gave out, so a stopping server can close them all.
const handles = new Set<Database.Database>();

// Every module opens its own handle on the one database. This is the one
// place they get it, so a pragma set here holds on all of them.
//
// secure_delete overwrites freed content with zeros as it is freed. Without it
// a document whose row was purged keeps living in free pages until the next
// VACUUM, and "deleted from the cloud" has to mean deleted.
//
// journal_mode = WAL is what Litestream replicates from. Litestream switches a
// database to WAL itself when it starts, and WAL is stored in the file, so the
// deployed database is already in it and this changes nothing there. Saying it
// here means the server never depends on a replicator having opened the file
// first. An in-memory database answers "memory" and stays as it is.
//
// better-sqlite3 sets busy_timeout to 5000 ms on every handle, so a write that
// meets another handle's write waits rather than failing at once.
export function openDatabase(path = process.env.DB_PATH ?? DEFAULT_PATH): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("secure_delete = ON");
  handles.add(db);
  return db;
}

/**
 * Closes every handle openDatabase opened. For a stopping server only: any
 * module that still runs a query after this throws. Returns how many it closed.
 */
export function closeAllDatabases(): number {
  let closed = 0;
  for (const db of handles) {
    if (db.open) {
      db.close();
      closed += 1;
    }
  }
  handles.clear();
  return closed;
}
