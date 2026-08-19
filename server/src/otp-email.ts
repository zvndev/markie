// Copy for the one-time-code emails.
//
// This lived inline in the emailOTP plugin config, where it distinguished
// "sign-in" from everything else. Password reset is "everything else", so the
// single email a locked-out user is actively waiting for arrived titled
// "your Markie verification code" — vague enough to read as phishing, and
// silent about what it would do to their account.

export interface OTPEmail {
  subject: string;
  text: string;
}

const EXPIRY = "It expires in 5 minutes.";

export function otpEmail(type: string, otp: string): OTPEmail {
  switch (type) {
    case "sign-in":
      return {
        subject: `${otp} is your Markie sign-in code`,
        text: `Your Markie sign-in code is ${otp}. ${EXPIRY}\n\nIf you didn't try to sign in, you can ignore this email.`,
      };
    case "forget-password":
      return {
        subject: `${otp} is your Markie password reset code`,
        text: `Enter ${otp} in Markie to set a new password. ${EXPIRY}\n\nIf you didn't ask to reset your password, ignore this email — your current password is unchanged and this code does nothing on its own.`,
      };
    default:
      return {
        subject: `${otp} is your Markie verification code`,
        text: `Your Markie verification code is ${otp}. ${EXPIRY}`,
      };
  }
}
