//! What the user reads when sign-in fails, and what the sign-in form says it
//! is for. A port of src/lib/auth-errors.ts, word for word, so Markie RS and
//! the Electron app say the same sentence for the same failure.
use crate::error::CloudError;

/// Which request failed. Mirrors `AuthContext` in auth-errors.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthContext {
    PasswordSignIn,
    PasswordSignUp,
    OtpSend,
    OtpVerify,
    ResetRequest,
    ResetVerify,
}

/// What sent the user to the sign-in form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInReason {
    Share,
    Sync,
    Account,
}

pub const OFFLINE: &str = "Can't reach Markie's server. Check your connection.";
pub const RATE_LIMITED: &str = "Too many attempts. Wait a minute and try again.";
pub const BAD_CODE: &str = "That code isn't right, or it expired. Send a new one.";
pub const GENERIC: &str = "Something went wrong. Try again.";
pub const INVITE_ONLY: &str = "This server is invite-only. Ask its owner for an invite.";
pub const SIGNUP_CLOSED: &str = "This server isn't taking new accounts.";

/// The HTTP status the JS sees for a failure: 0 when nothing reached the
/// server, the status for a server answer, and None for failures that never
/// had one (an answer this app could not read, a refused request).
fn status_of(err: &CloudError) -> Option<u16> {
    match err {
        CloudError::Offline => Some(0),
        CloudError::Status { status, .. } => Some(*status),
        _ => None,
    }
}

/// `authErrorMessage(status, context)`.
pub fn auth_error_message(err: &CloudError, context: AuthContext) -> &'static str {
    let Some(status) = status_of(err) else { return GENERIC };
    message_for_status(status, context)
}

pub fn message_for_status(status: u16, context: AuthContext) -> &'static str {
    if status == 0 {
        return OFFLINE;
    }
    if status == 429 {
        return RATE_LIMITED;
    }
    match context {
        AuthContext::PasswordSignIn => {
            if status == 401 || status == 403 {
                return "That email and password don't match.";
            }
        }
        AuthContext::PasswordSignUp => {
            if status == 409 {
                return "That email already has an account. Sign in instead.";
            }
            if status == 422 {
                return "That password is too short. Use at least 8 characters.";
            }
            if status == 400 {
                return "That email doesn't look right.";
            }
        }
        AuthContext::OtpSend => {
            if status == 400 {
                return "That email doesn't look right.";
            }
        }
        AuthContext::OtpVerify | AuthContext::ResetVerify => {
            if status == 400 || status == 401 {
                return BAD_CODE;
            }
        }
        // Deliberately does not say "no such account": that would confirm
        // which addresses exist.
        AuthContext::ResetRequest => return "Couldn't send that code. Try again in a moment.",
    }
    GENERIC
}

/// `signupRefusal(status, data)`: a sign-up the server refused on policy.
pub fn signup_refusal(err: &CloudError) -> Option<&'static str> {
    if err.status() != Some(403) {
        return None;
    }
    match err.code() {
        Some("signup_invite_required") => Some(INVITE_ONLY),
        Some("signup_closed") => Some(SIGNUP_CLOSED),
        _ => None,
    }
}

/// `signInReasonCopy(reason)`: the title and line at the top of the form.
pub fn reason_copy(reason: SignInReason) -> (&'static str, &'static str) {
    match reason {
        SignInReason::Share => (
            "Sign in to share",
            "Sharing needs an account so the other person has somewhere to read it. Your file stays on this Mac until you invite someone.",
        ),
        SignInReason::Sync => (
            "Sign in to sync",
            "Sync keeps your documents on every device you use. Your files stay on this Mac until you turn sync on.",
        ),
        SignInReason::Account => (
            "Sign in to Markie",
            "For syncing and sharing across your devices. Markie works fully without an account, and your files stay on this Mac either way.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(s: u16) -> CloudError {
        CloudError::Status { status: s, message: None, code: None }
    }

    #[test]
    fn statuses_read_as_the_electron_sentences() {
        assert_eq!(auth_error_message(&CloudError::Offline, AuthContext::PasswordSignIn), OFFLINE);
        assert_eq!(auth_error_message(&status(429), AuthContext::OtpVerify), RATE_LIMITED);
        assert_eq!(auth_error_message(&status(401), AuthContext::PasswordSignIn), "That email and password don't match.");
        assert_eq!(auth_error_message(&status(403), AuthContext::PasswordSignIn), "That email and password don't match.");
        assert_eq!(auth_error_message(&status(409), AuthContext::PasswordSignUp), "That email already has an account. Sign in instead.");
        assert_eq!(auth_error_message(&status(422), AuthContext::PasswordSignUp), "That password is too short. Use at least 8 characters.");
        assert_eq!(auth_error_message(&status(400), AuthContext::PasswordSignUp), "That email doesn't look right.");
        assert_eq!(auth_error_message(&status(400), AuthContext::OtpSend), "That email doesn't look right.");
        assert_eq!(auth_error_message(&status(401), AuthContext::OtpVerify), BAD_CODE);
        assert_eq!(auth_error_message(&status(400), AuthContext::ResetVerify), BAD_CODE);
        assert_eq!(auth_error_message(&status(404), AuthContext::ResetRequest), "Couldn't send that code. Try again in a moment.");
        assert_eq!(auth_error_message(&status(500), AuthContext::OtpSend), GENERIC);
        assert_eq!(auth_error_message(&CloudError::Unreadable, AuthContext::OtpSend), GENERIC);
    }

    #[test]
    fn policy_refusals_have_their_own_line() {
        let refused = |code: &str| CloudError::Status { status: 403, message: None, code: Some(code.into()) };
        assert_eq!(signup_refusal(&refused("signup_invite_required")), Some(INVITE_ONLY));
        assert_eq!(signup_refusal(&refused("signup_closed")), Some(SIGNUP_CLOSED));
        assert_eq!(signup_refusal(&refused("other")), None);
        assert_eq!(signup_refusal(&status(403)), None);
        assert_eq!(signup_refusal(&CloudError::Status { status: 400, message: None, code: Some("signup_closed".into()) }), None);
    }

    #[test]
    fn the_account_reason_reads_like_settings() {
        assert_eq!(reason_copy(SignInReason::Account).0, "Sign in to Markie");
    }
}
