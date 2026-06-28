# Current Task — F-011

## Selected feature
A visual regression guard prevents future built-in theme contrast regressions across representative Markie surfaces.

## Acceptance criteria
- Turn the light-mode audit/fix workflow into a repeatable test or script that can run headlessly or with a local app window.
- Cover at least one representative shell surface, one editor/content surface, and one modal/panel surface.
- Make the script fail or produce clear findings when key foreground/background pairs fall below the chosen contrast threshold.
- Run the visual regression guard plus `./init.sh`.

## Plan
- Inspect the existing light-mode visual audit harness and package scripts.
- Add a narrow regression-guard entry point around the existing audit so CI/local runs have a clear contrast-gate command.
- Ensure the guard records representative coverage and fails on shell/content/overlay contrast findings below AA.
- Verify with the guard command and the full repo baseline.
