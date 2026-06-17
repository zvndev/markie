// Fail closed: production MUST set BETTER_AUTH_SECRET (it signs session tokens).
// A hardcoded fallback in a public repo would let anyone forge sessions against
// a misconfigured deployment, so refuse to boot in production without it.
export function resolveAuthSecret(env: NodeJS.ProcessEnv): string {
  const s = env.BETTER_AUTH_SECRET;
  if (!s) {
    if (env.NODE_ENV === "production") {
      throw new Error("BETTER_AUTH_SECRET is required in production");
    }
    return "markie-dev-secret-not-for-prod";
  }
  return s;
}
