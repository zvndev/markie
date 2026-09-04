// The parts of the update check that differ per platform.
//
// Almost none of that check is platform-specific: the app finding the update on
// its own, the notice appearing, the button, the click, are the same assertions
// driven the same way over CDP. What differs is only how the previous release
// is obtained, how its signature is judged, how to read the version of what is
// on disk, and how to tell it relaunched. Those four live here so the
// assertions can live in one place and neither platform drifts from the other.
import path from "node:path";

/**
 * @param {object} deps
 *  run(cmd, args) -> stdout, mkdir, writeFile, stat, mkdtemp, tmpdir, mounted[]
 */
export function macTarget(deps) {
  const { run, mkdir, stat, tmpdir, mkdtemp, mounted } = deps;
  return {
    platformId: "mac-arm64",
    // What a user would actually download.
    artifactUrl: (base, feedPath, from, arch) =>
      `${base}/${path.posix.dirname(feedPath)}/Markie-${from}-${arch}.dmg`,
    artifactLabel: "DMG",
    minBytes: 50_000_000,

    async stage({ artifactPath, workDir }) {
      const mountPoint = path.join(workDir, "mnt");
      await mkdir(mountPoint, { recursive: true });
      await run("hdiutil", ["attach", artifactPath, "-mountpoint", mountPoint, "-nobrowse", "-quiet"]);
      mounted.push(mountPoint);

      const appDir = path.join(workDir, "Applications");
      await mkdir(appDir, { recursive: true });
      await run("ditto", [path.join(mountPoint, "Markie.app"), path.join(appDir, "Markie.app")]);
      await run("hdiutil", ["detach", mountPoint, "-quiet"]);
      mounted.pop();

      const appPath = path.join(appDir, "Markie.app");
      return { appPath, binary: path.join(appPath, "Contents", "MacOS", "Markie") };
    },

    // Gatekeeper's verdict on the copy that is about to run. A build that
    // cannot launch cannot update.
    async trust({ appPath }) {
      const out = await run("spctl", ["-a", "-vvv", "-t", "install", appPath]).catch((e) => e.message);
      return {
        label: "the previous release is still accepted by Gatekeeper",
        ok: /Notarized Developer ID/.test(out),
        detail: out.split("\n").find((l) => l.includes("source=")) ?? "",
      };
    },

    async versionOnDisk({ appPath }) {
      const v = await run("defaults", [
        "read",
        path.join(appPath, "Contents", "Info.plist"),
        "CFBundleShortVersionString",
      ]).catch(() => "");
      return v.trim() || null;
    },

    async runningPid({ appPath }) {
      const bin = path.join(appPath, "Contents/MacOS/Markie");
      const out = await run("bash", ["-lc", `pgrep -f ${JSON.stringify(bin)} || true`]).catch(() => "");
      return out.trim() ? out.trim().split(/\s+/)[0] : null;
    },

    async profileDir() {
      return mkdtemp(path.join(tmpdir(), "markie-update-profile-"));
    },

    // Anything running out of our temp directory, whoever started it. After an
    // install the app relaunches itself, so the new process is nobody's child
    // and would otherwise survive this script.
    async killStrays(dirs) {
      for (const dir of dirs) {
        const out = await run("bash", ["-lc", `pgrep -f ${JSON.stringify(dir)} || true`]).catch(
          () => ""
        );
        for (const pid of out.split(/\s+/).filter(Boolean)) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },

    // Squirrel keys its state on the bundle id, so a run that installs leaves
    // state behind pointing at a temp bundle this script is about to delete.
    installerStatePath: () =>
      path.join(
        process.env.HOME ?? "",
        "Library/Caches/com.zvn.markie.ShipIt/ShipItState.plist"
      ),

    stat,
  };
}

// PowerShell has no backslash escapes, so JSON.stringify is the wrong quoting
// for it: a Windows path comes out with every separator doubled. .NET quietly
// normalises that for some cmdlets and not others, which is worse than an
// outright failure, because it means the mistake shows up as one check failing
// rather than as everything failing. A single-quoted PowerShell string is
// literal all the way through; the only escape is a doubled quote.
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function windowsTarget(deps) {
  const { run, tmpdir, mkdtemp } = deps;

  // PowerShell rather than cmd: the version of a Windows binary lives in its
  // resource block, and Get-Item is the only way to read it without shipping a
  // tool. -NoProfile so a runner's profile cannot print into stdout.
  //
  // PowerShell 7 (pwsh) when it is there, Windows PowerShell 5.1 otherwise.
  // Not a preference: a 5.1 process spawned from inside a pwsh session
  // inherits pwsh's PSModulePath and then cannot load its own
  // Microsoft.PowerShell.Security, so Get-AuthenticodeSignature fails while
  // Get-Item, a snap-in cmdlet, keeps working. On a GitHub runner every step
  // is a pwsh session. The release workflow verifies signatures with pwsh, and
  // a check that judges the same file with a different tool is a check that
  // can disagree with the gate it is meant to confirm.
  let shell = null;
  const pickShell = async () => {
    if (shell) return shell;
    const probe = await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"]).catch(() => "");
    shell = /^\d+/.test(probe.trim()) ? "pwsh" : "powershell";
    return shell;
  };
  const ps = async (script) =>
    run(await pickShell(), ["-NoProfile", "-NonInteractive", "-Command", script]).catch(() => "");

  return {
    platformId: "windows-x64",
    artifactUrl: (base, feedPath, from) =>
      `${base}/${path.posix.dirname(feedPath)}/Markie-${from}-x64.exe`,
    artifactLabel: "installer",
    minBytes: 50_000_000,

    // NSIS one-click installs per user, and its location is not ours to choose,
    // so the check installs where a real install goes and reads back from
    // there. That is also the only way the updater's own swap is exercised: it
    // replaces what NSIS laid down, not a copy we placed.
    async stage({ artifactPath }) {
      const out = await run(await pickShell(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Start-Process ${psQuote(artifactPath)} -ArgumentList '/S' -PassThru -Wait; ` +
          `Write-Output $p.ExitCode`,
      ]);
      const code = Number.parseInt(out.trim(), 10);
      if (code !== 0) {
        const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
        throw new Error(`installing ${path.basename(artifactPath)} exited with ${code} (${hex})`);
      }

      // A one-click install launches the app when it finishes, silent mode
      // included, and Markie holds a single-instance lock. Left running, the
      // copy this check starts would hand off to it and exit at once, and the
      // check would watch the wrong process.
      await ps("Get-Process Markie -ErrorAction SilentlyContinue | Stop-Process -Force");

      const found = (
        await ps(
          `(Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Filter Markie.exe -Recurse -ErrorAction SilentlyContinue | ` +
            `Select-Object -First 1).FullName`
        )
      ).trim();
      if (!found) throw new Error("installed Markie.exe was not found under LOCALAPPDATA\\Programs");
      return { appPath: found, binary: found };
    },

    // Authenticode is the Windows answer to the Gatekeeper question: would this
    // machine run it without a warning. Valid is the only status that means yes.
    async trust({ appPath }) {
      // One call, not two: a second Get-AuthenticodeSignature can read a
      // different answer if anything touched the file in between, and the
      // subject would then be describing a signature the status did not.
      const raw = (
        await ps(
          `$s = Get-AuthenticodeSignature ${psQuote(appPath)}; ` +
            `Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject`
        )
      ).trim();
      const [status = "", subject = ""] = raw.split(/\r?\n/).map((l) => l.trim());
      return {
        label: "the previous release is still signed and trusted by Windows",
        ok: status === "Valid",
        detail: status
          ? [status, subject].filter(Boolean).join(", ")
          : `Get-AuthenticodeSignature said nothing about ${appPath}`,
      };
    },

    async versionOnDisk({ appPath }) {
      const v = (await ps(`(Get-Item ${psQuote(appPath)}).VersionInfo.ProductVersion`)).trim();
      // Windows pads a resource version to four parts; the feed speaks three.
      return v ? v.split("+")[0].split(/\s/)[0].replace(/^(\d+\.\d+\.\d+)\.0$/, "$1") : null;
    },

    async runningPid() {
      const out = await ps("(Get-Process Markie -ErrorAction SilentlyContinue | Select-Object -First 1).Id");
      return out.trim() || null;
    },

    async profileDir() {
      return mkdtemp(path.join(tmpdir(), "markie-update-profile-"));
    },

    // Matched on the profile directory rather than the process name: this also
    // runs on a machine where somebody has their own Markie open, and killing
    // that would be this script reaching outside its own sandbox.
    async killStrays(dirs) {
      for (const dir of dirs) {
        await ps(
          `Get-CimInstance Win32_Process -Filter "Name='Markie.exe'" -ErrorAction SilentlyContinue | ` +
            `Where-Object { $_.CommandLine -like ${psQuote(`*${dir}*`)} } | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        );
      }
    },

    // NSIS leaves no cross-run state of the kind Squirrel does.
    installerStatePath: () => null,
  };
}

export function targetFor(platform, deps) {
  if (platform === "win32") return windowsTarget(deps);
  if (platform === "darwin") return macTarget(deps);
  throw new Error(`the update check has no support for ${platform}`);
}
