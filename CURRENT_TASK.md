# Current Task — F-003

## Selected item
`F-003`: A safe preflight command verifies release prerequisites without signing, notarizing, uploading, or touching production services.

## Acceptance criteria
1. Run the documented release preflight command on a clean checkout without release credentials.
2. Confirm it checks package metadata, required local files, and build/test prerequisites.
3. Confirm it exits before any publish, notarize, upload, deploy, or credentialed network action.
4. Run `./init.sh`.

## Scope
- Add or wire a local-only release preflight command.
- It may inspect files, package metadata, and run local validation commands.
- It must not sign, notarize, upload, publish, deploy, mutate production services, or require release credentials.
