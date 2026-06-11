// Idempotent auth-schema migration, run at container boot. Uses the
// installed better-auth directly so it can never drift from the runtime.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth.ts";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
  auth.options
);
if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log("auth schema up to date");
} else {
  await runMigrations();
  console.log(
    `auth schema migrated (${toBeCreated.length} created, ${toBeAdded.length} altered)`
  );
}
process.exit(0);
