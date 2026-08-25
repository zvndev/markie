// Windows code signing through Azure Artifact Signing, called by
// electron-builder as `win.signtoolOptions.sign`.
//
// electron-builder has its own Azure signing support and this deliberately does
// not use it. That path insists on an AZURE_CLIENT_SECRET, an
// AZURE_CLIENT_CERTIFICATE_PATH, or an AZURE_USERNAME before it will even
// start, which forces a long-lived credential into CI. The precondition is
// stricter than the thing it is guarding: Invoke-TrustedSigning authenticates
// through DefaultAzureCredential, which picks up the session `azure/login`
// already established from a GitHub OIDC token. Calling the module directly
// keeps the credential short-lived and repo-scoped, at the cost of this file.
//
// Signing here is all-or-nothing on purpose. A build that quietly produced an
// unsigned installer would look exactly like a successful one right up until a
// user sees SmartScreen, so every failure below throws.

const { spawnSync } = require("node:child_process");

const REQUIRED = [
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME",
  "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME",
];

// PowerShell single-quoted strings escape a quote by doubling it. Paths come
// from electron-builder rather than from user input, but a build directory with
// an apostrophe in it should not be able to change the command being run.
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

exports.default = async function signWindowsFile(configuration) {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Azure Artifact Signing is missing ${missing.join(", ")}`);
  }

  const file = configuration.path;
  const command = [
    "Invoke-TrustedSigning",
    "-Endpoint",
    quote(process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT),
    "-CodeSigningAccountName",
    quote(process.env.AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME),
    "-CertificateProfileName",
    quote(process.env.AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME),
    "-Files",
    quote(file),
    "-FileDigest",
    "SHA256",
    // Artifact Signing certificates are valid for about three days and rotate
    // on their own. Without a countersignature the signature dies with the
    // certificate and every existing install starts failing its trust check.
    "-TimestampRfc3161",
    quote("http://timestamp.acs.microsoft.com"),
    "-TimestampDigest",
    "SHA256",
  ].join(" ");

  console.log(`[win-sign] signing ${file}`);
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Invoke-TrustedSigning failed for ${file} with exit code ${result.status}`);
  }
};
