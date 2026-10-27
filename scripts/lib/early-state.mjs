// State for the early-access stage of a release: what was published to the
// beta feed, when it may become stable, and whether Kirby has held it.
//
// Pure on purpose. Nothing here reads the network, the bucket, or git, so the
// rules that decide whether a build reaches every user can be tested by
// handing them a clock and a few objects. scripts/release.mjs does the I/O and
// asks this module what to do.
//
// One file per version, at .release/<version>/early.json (gitignored):
//
//   {
//     schemaVersion: 1,
//     version, commit, approval,
//     soakDays, publishedAt, soakUntil,
//     held, heldAt, holdReason,
//     platforms: { mac?: {...}, win?: {...}, linux?: {...} },
//     promotedAt, withdrawnAt, supersededAt, supersededBy
//   }

export const EARLY_STATE_FILE = "early.json";
export const DEFAULT_SOAK_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SOAK_DAYS = 60;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isStableVersion = (version) => /^\d+\.\d+\.\d+$/.test(version ?? "");

/**
 * The soak length for one release. A flag wins, then the manifest default,
 * then three days. Fractions are allowed (0.5 is twelve hours) because a
 * hotfix may deserve a shorter soak, and zero is allowed because "promote at
 * the next scheduler run" is a legitimate thing to ask for. Anything that is
 * not a plain non-negative number is refused rather than read as zero.
 */
export function resolveSoakDays(flagValue, manifestDefault) {
  const raw = flagValue ?? manifestDefault ?? DEFAULT_SOAK_DAYS;
  const days = typeof raw === "number" ? raw : Number(String(raw).trim() || Number.NaN);
  assert(
    Number.isFinite(days) && days >= 0 && days <= MAX_SOAK_DAYS,
    `soak must be between 0 and ${MAX_SOAK_DAYS} days, got ${raw}`
  );
  return days;
}

export function soakUntilFrom(isoTime, soakDays) {
  const start = Date.parse(isoTime);
  assert(Number.isFinite(start), `invalid timestamp: ${isoTime}`);
  return new Date(start + soakDays * DAY_MS).toISOString();
}

/**
 * Fold one platform's early publish into the release state.
 *
 * The clock is per release, not per platform, and it restarts from the latest
 * platform publish: a Windows build that reaches early users a day after the
 * Mac one has had one day less of soak, and both promote together. A release
 * that has already been promoted cannot take a new early publish; that version
 * is stable now, and anything new is a new version.
 */
export function recordEarlyPublish(previous, update) {
  const { version, commit, platform, publishedAt, soakDays, platformRecord, approval } = update;
  assert(isStableVersion(version), `early releases carry a stable version, got ${version}`);
  assert(["mac", "win", "linux"].includes(platform), `unknown early platform: ${platform}`);
  if (previous) {
    assert(previous.version === version, `early state for ${previous.version} cannot record ${version}`);
    assert(!previous.promotedAt, `${version} was already promoted to stable at ${previous.promotedAt}`);
    assert(
      previous.commit === commit,
      `${version} was published early from ${previous.commit}; refusing a second commit under the same version`
    );
  }
  const days = soakDays ?? previous?.soakDays ?? DEFAULT_SOAK_DAYS;
  return {
    schemaVersion: 1,
    version,
    commit,
    approval: approval ?? previous?.approval ?? null,
    soakDays: days,
    publishedAt: previous?.publishedAt ?? publishedAt,
    soakUntil: soakUntilFrom(publishedAt, days),
    held: previous?.held === true,
    heldAt: previous?.heldAt ?? null,
    holdReason: previous?.holdReason ?? null,
    platforms: { ...(previous?.platforms ?? {}), [platform]: { ...platformRecord, publishedAt } },
    promotedAt: null,
    supersededAt: null,
    supersededBy: null,
    // A fresh publish of the same version after a withdrawal puts it back in
    // front of early users, so it is live again and its clock restarts.
    withdrawnAt: null,
  };
}

export function setHold(state, held, { now, reason } = {}) {
  assert(state, "no early release recorded for that version");
  assert(!state.promotedAt, `${state.version} is already stable; a hold no longer means anything`);
  return {
    ...state,
    held: held === true,
    heldAt: held === true ? new Date(now).toISOString() : null,
    holdReason: held === true ? (reason ?? null) : null,
  };
}

export function markPromoted(state, now) {
  return { ...state, promotedAt: new Date(now).toISOString() };
}

export function markWithdrawn(state, now) {
  return { ...state, withdrawnAt: new Date(now).toISOString() };
}

/**
 * The bucket says this version is no longer the one to promote: the early feed
 * names something else, or stable has already moved past it. Recorded so the
 * hourly scheduler stops retrying it.
 */
export function markSuperseded(state, now, by) {
  return { ...state, supersededAt: new Date(now).toISOString(), supersededBy: by ?? null };
}

/** Milliseconds of soak left, never negative. */
export function soakRemainingMs(state, now) {
  return Math.max(0, Date.parse(state.soakUntil) - new Date(now).getTime());
}

/**
 * Why this release may not be promoted right now, or null if it may.
 *
 * `force` is `--now`: it skips the soak and nothing else. A hold is Kirby's
 * explicit "not yet", and a withdrawn or prerelease build was never meant for
 * stable, so no flag overrides those. Whether the live early feed still names
 * this version is checked by the caller against the bucket, because only the
 * bucket knows.
 */
export function promotionBlocker(state, now, { force = false } = {}) {
  if (!state) return "no early release is recorded for that version";
  if (!isStableVersion(state.version)) {
    return `${state.version} is a prerelease; only stable-numbered early builds promote`;
  }
  if (state.promotedAt) return `${state.version} was already promoted at ${state.promotedAt}`;
  if (state.withdrawnAt) return `${state.version} was withdrawn from early access at ${state.withdrawnAt}`;
  if (state.supersededAt) {
    return `${state.version} was superseded${state.supersededBy ? ` by ${state.supersededBy}` : ""} at ${state.supersededAt}`;
  }
  if (state.held) {
    return `${state.version} is held${state.holdReason ? ` (${state.holdReason})` : ""}; run release:unhold first`;
  }
  if (!state.platforms || Object.keys(state.platforms).length === 0) {
    return `${state.version} has no published platforms`;
  }
  if (!force && soakRemainingMs(state, now) > 0) {
    return `${state.version} is soaking until ${state.soakUntil}; pass --now to promote early`;
  }
  return null;
}

function compareStable(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/**
 * What the hourly scheduler should do, given every recorded early release.
 *
 * Returns the one release to promote (or null) and a single summary line. A
 * pending release is skipped as superseded when any newer version has been
 * published early, whatever became of that newer one: a newer early release
 * restarts the clock, and a withdrawn newer release is a reason for a human
 * to look, not for the old build to slip out automatically.
 */
export function planPromoteDue(states, now) {
  const recorded = states.filter((state) => state && isStableVersion(state.version));
  const pending = recorded.filter(
    (state) => !state.promotedAt && !state.withdrawnAt && !state.supersededAt
  );
  const newest = (version) => recorded.some((other) => compareStable(other.version, version) > 0);
  const superseded = pending.filter((state) => newest(state.version)).map((state) => state.version);
  const live = pending.filter((state) => !newest(state.version));
  // At most one is live by construction; sort anyway so the answer never
  // depends on directory order.
  live.sort((left, right) => compareStable(right.version, left.version));
  const candidate = live[0] ?? null;

  if (!candidate) {
    const tail = superseded.length ? ` (superseded: ${superseded.join(", ")})` : "";
    return { due: null, superseded, summary: `nothing pending${tail}` };
  }
  const blocker = promotionBlocker(candidate, now);
  if (blocker) {
    const remaining = soakRemainingMs(candidate, now);
    const summary = candidate.held
      ? `${candidate.version} held${candidate.holdReason ? ` (${candidate.holdReason})` : ""}`
      : remaining > 0
        ? `${candidate.version} soaking until ${candidate.soakUntil} (${formatDuration(remaining)} left)`
        : `${candidate.version} not promotable: ${blocker}`;
    return { due: null, superseded, summary };
  }
  return { due: candidate, superseded, summary: `${candidate.version} is due` };
}

export function formatDuration(ms) {
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
