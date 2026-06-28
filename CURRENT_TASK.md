# Current Task - F-005

## Description
A real-user comments regression verifies thread creation, reply, resolve, reopen, and anchor survival using the existing verifier scripts.

## Acceptance Criteria
1. Run the existing comments verification scripts against the local dev server setup they document.
2. If setup gaps prevent the journey, add the smallest script/docs fix needed for repeatable local verification.
3. Confirm the journey covers create, reply, resolve, reopen, and anchor survival after an edit above the selection.
4. Run the focused comments verifier plus `./init.sh`.

## Scope
- Implement only the smallest verifier/script/docs or narrow product fix needed for this comments regression.
- Do not change comments product UX unless a failing verification requires a focused bugfix.
- Do not touch production, deployment, credentials, or external service configuration.

## Plan
1. Inspect `scripts/comments-api-verify.mjs`, `scripts/comments-e2e-verify.mjs`, and related package scripts.
2. Run the existing verifier in the documented local setup and capture the failure or proof.
3. Patch only the verifier/setup or a narrow comments bug needed to make the journey repeatable.
4. Run the focused verifier and the repo baseline, then update the feature ledger and progress log.
