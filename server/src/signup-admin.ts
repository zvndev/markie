// The sign-up allowlist from a shell on the server, for when there is no admin
// session to hand (or no admin yet). Run through the entrypoint:
//
//   ./docker-entrypoint.sh signup list
//   ./docker-entrypoint.sh signup allow guest@example.org
//   ./docker-entrypoint.sh signup remove guest@example.org
//
// Holding a shell in the container is already holding the database, so this
// asks for nothing more.
import { openDatabase } from "./db.ts";
import { adminEmail, adminUserId, allowEmail, allowlist, disallowEmail, signupMode } from "./signup.ts";

const [command, email] = process.argv.slice(2);
const db = openDatabase();
const usage = "usage: signup list | signup allow <email> | signup remove <email>";

try {
  if (command === "list") {
    const admin = adminUserId(db);
    const row = admin ? (db.prepare('SELECT email FROM "user" WHERE id = ?').get(admin) as { email: string }) : null;
    console.log(`sign-up mode: ${signupMode()}`);
    console.log(`admin: ${row?.email ?? adminEmail() ?? "none yet (the first account to sign up)"}`);
    const emails = allowlist(db);
    console.log(emails.length ? `allowed:\n${emails.map((e) => `  ${e.email}`).join("\n")}` : "allowed: none");
  } else if (command === "allow" && email) {
    console.log(`allowed ${allowEmail(db, email, null)}`);
  } else if (command === "remove" && email) {
    console.log(disallowEmail(db, email) ? `removed ${email.trim().toLowerCase()}` : `${email} was not on the list`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`signup: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
