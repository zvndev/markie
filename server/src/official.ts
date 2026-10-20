// MARKIE_OFFICIAL, read in one place. Unset means the official Markie Cloud,
// so the live deployment keeps every guard it has without setting anything;
// a self-hosted server declares itself with MARKIE_OFFICIAL=0. See deployment.ts.
export function officialFlag(env: { MARKIE_OFFICIAL?: string }): boolean {
  const raw = env.MARKIE_OFFICIAL?.trim();
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  throw new Error("MARKIE_OFFICIAL must be 1 (the official Markie Cloud) or 0 (a self-hosted server).");
}
