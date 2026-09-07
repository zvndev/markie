import Database from "better-sqlite3";

const DEFAULT_PATH = "./markie.db";

// Every module opens its own handle on the one database. This is the one
// place they get it, so a pragma set here holds on all of them.
//
// secure_delete overwrites freed content with zeros as it is freed. Without it
// a document whose row was purged keeps living in free pages until the next
// VACUUM, and "deleted from the cloud" has to mean deleted.
export function openDatabase(path = process.env.DB_PATH ?? DEFAULT_PATH): Database.Database {
  const db = new Database(path);
  db.pragma("secure_delete = ON");
  return db;
}
