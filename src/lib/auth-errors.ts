// What the user reads when auth fails.
//
// The old Settings form rendered `Request failed (${status}).` for everything it
// didn't special-case, which meant the single most common sign-up failure — an
// email that already has an account — surfaced as "Request failed (409)." A
// status code is a fact about a protocol, not an instruction to a person, and
// the person is usually one sentence away from succeeding.
//
// So every failure maps to a sentence that says what happened and what to do.

export type AuthContext =
  | "password-signin"
  | "password-signup"
  | "otp-send"
  | "otp-verify"
  | "reset-request"
  | "reset-verify";

export type SignInReason = "share" | "sync" | "account";

const OFFLINE = "Can't reach Markie's server. Check your connection.";
const RATE_LIMITED = "Too many attempts. Wait a minute and try again.";
const BAD_CODE = "That code isn't right, or it expired. Send a new one.";
const GENERIC = "Something went wrong. Try again.";

export function authErrorMessage(status: number, context: AuthContext): string {
  // A fetch that threw never reached the server, so nothing about the account
  // is actually known here.
  if (status === 0) return OFFLINE;
  if (status === 429) return RATE_LIMITED;

  switch (context) {
    case "password-signin":
      if (status === 401 || status === 403) return "That email and password don't match.";
      break;
    case "password-signup":
      if (status === 409 || status === 422) {
        // better-auth answers 422 for "user already exists" on some paths and
        // 409 on others, so both land on the message that unblocks the user.
        return status === 409
          ? "That email already has an account. Sign in instead."
          : "That password is too short. Use at least 8 characters.";
      }
      if (status === 400) return "That email doesn't look right.";
      break;
    case "otp-send":
      if (status === 400) return "That email doesn't look right.";
      break;
    case "otp-verify":
    case "reset-verify":
      if (status === 400 || status === 401) return BAD_CODE;
      break;
    case "reset-request":
      // Deliberately does not distinguish "no such account". Confirming which
      // addresses exist turns this form into an enumeration oracle for anyone
      // working through a list of emails.
      return "Couldn't send that code. Try again in a moment.";
  }

  return GENERIC;
}

interface ReasonCopy {
  title: string;
  body: string;
}

// Sign-in is never the user's goal; it is in the way of something they asked
// for. Naming that something is the difference between a demand and an answer.
export function signInReasonCopy(reason: SignInReason): ReasonCopy {
  switch (reason) {
    case "share":
      return {
        title: "Sign in to share",
        body: "Sharing needs an account so the other person has somewhere to read it. Your file stays on this Mac until you invite someone.",
      };
    case "sync":
      return {
        title: "Sign in to sync",
        body: "Sync keeps your documents on every device you use. Your files stay on this Mac until you turn sync on.",
      };
    case "account":
      return {
        title: "Sign in to Markie",
        body: "For syncing and sharing across your devices. Markie works fully without an account, and your files stay on this Mac either way.",
      };
  }
}
