import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const script = resolve(import.meta.dir, "../macos/scripts/install-preview.sh")
const commit = "a".repeat(40)
const workflowCommit = "b".repeat(40)
const digest = createHash("sha256").update("authenticated DMG").digest("hex")

// Exercise the actual shell installer while replacing native macOS commands and
// the cryptographic verifier boundary. Native CI separately tests real attestations.
const mock = `#!/usr/bin/env python3
import hashlib, json, os, pathlib, shutil, signal, subprocess, sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
root=pathlib.Path(os.environ['MOCK_ROOT'])
remote=root/'remote'
failure=os.environ.get('MOCK_FAIL','')
with (root/'calls').open('a') as f: f.write(json.dumps({'command':name,'args':args})+'\\n')
def value(flag): return args[args.index(flag)+1]
if name=='uname': print('Darwin')
elif name=='curl':
    target=pathlib.Path(value('-o'))
    tag,file=args[-1].rsplit('/',2)[-2:]
    # A release folder (remote/<tag>/) overrides the shared fixture files.
    source=remote/tag/file if (remote/tag/file).exists() else remote/file
    if not source.exists(): sys.exit(22)
    shutil.copyfile(source,target)
elif name=='gh':
    if '--help' in args:
        print('--bundle --cert-identity --source-ref --source-digest --deny-self-hosted-runners --jq')
        sys.exit(0)
    artifact=pathlib.Path(args[2])
    if failure==('manifest-proof' if artifact.name=='preview.manifest' else 'dmg-proof'): sys.exit(1)
    ref=os.environ.get('MOCK_REF','refs/heads/main')
    sha=os.environ.get('MOCK_WORKFLOW_COMMIT','a'*40)
    expected='https://github.com/dbuldum4/zsearch/.github/workflows/macos-app.yml@'+ref
    if value('--repo')!='dbuldum4/zsearch' or value('--cert-identity')!=expected or value('--source-ref')!=ref: sys.exit(1)
    if '--source-digest' in args and value('--source-digest')!=sha: sys.exit(1)
    cert={'sourceRepositoryIdentifier':os.environ.get('MOCK_REPO_ID','1410815604'),
          'sourceRepositoryOwnerIdentifier':os.environ.get('MOCK_OWNER_ID','59258696'),
          'buildTrigger':os.environ.get('MOCK_EVENT','push'),'sourceRepositoryDigest':sha,
          'runInvocationURI':os.environ.get('MOCK_INVOCATION','https://github.com/dbuldum4/zsearch/actions/runs/100/attempts/1')}
    result=[{'verificationResult':{'signature':{'certificate':cert}}}]
    # jq tests the installer's additional numeric-identity and event policy itself.
    filtered=subprocess.run(['jq','-r',value('--jq')],input=json.dumps(result),text=True,capture_output=True)
    print(filtered.stdout,end='')
    sys.exit(filtered.returncode)
elif name=='hdiutil':
    if args[0]=='attach':
        for bundle in ['zsearch.app','zsearch-meaning.app']:
            if (remote/bundle).exists(): shutil.copytree(remote/bundle,pathlib.Path(value('-mountpoint'))/bundle)
elif name=='codesign':
    if failure=='codesign' or (failure=='staged-signature' and '.zsearch-stage.' in args[-1]): sys.exit(1)
elif name=='ditto':
    if failure=='copy': sys.exit(1)
    shutil.copytree(args[-2],args[-1])
elif name=='plutil':
    if value('-extract')=='ZSearchCommit': print(os.environ.get('MOCK_APP_COMMIT','a'*40))
    else: print(os.environ.get('MOCK_APP_ID','io.github.dbuldum4.zsearch'))
elif name=='xattr':
    if failure=='quarantine':
        if args[0]=='-dr': sys.exit(1)
        print('com.apple.quarantine')
    elif failure=='attributes': sys.exit(1)
elif name=='pgrep': sys.exit(0 if failure in ['running','quit-denied'] else 1)
elif name=='osascript' and failure=='quit-denied':
    sys.stderr.write('execution error: Not authorized to send Apple events (-1743)\\n'); sys.exit(1)
elif name in ['osascript','sleep','open']: pass
elif name=='mv':
    source,dest=args[-2:]
    swap=pathlib.Path(source).name=='zsearch.app' and '.zsearch-stage.' in source and '.zsearch-stage.' not in dest
    if failure in ['swap','restore','interrupt'] and swap:
        if failure=='interrupt': os.kill(os.getppid(),signal.SIGTERM)
        sys.exit(1)
    if failure=='state' and pathlib.Path(source).name=='state': sys.exit(1)
    if failure=='state-interrupt' and pathlib.Path(source).name=='state':
        # The rename completes, then the signal arrives before the install commits.
        subprocess.run([os.environ['REAL_MV']]+args,check=True)
        os.kill(os.getppid(),signal.SIGTERM)
        sys.exit(0)
    if failure=='restore' and pathlib.Path(source).name=='previous.app': sys.exit(1)
    os.execv(os.environ['REAL_MV'],['mv']+args)
else: sys.exit(1)
`

interface Call { command: string; args: string[] }
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup()
  try { run(f) } finally { rmSync(f.root, { recursive: true, force: true }) }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "zsearch-installer-"))
  const bin = join(root, "bin")
  const remote = join(root, "remote")
  const dest = join(root, "Applications with spaces")
  for (const d of [bin, remote, join(remote, "zsearch.app/Contents"), join(dest, "zsearch.app")]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dest, "zsearch.app/version"), "old")
  writeFileSync(join(remote, "zsearch.app/version"), "new")
  writeFileSync(join(remote, "zsearch.app/Contents/Info.plist"), "fixture")
  writeFileSync(join(remote, "zsearch.dmg"), "authenticated DMG")
  writeFileSync(join(remote, "provenance.jsonl"), "verifier fixture")
  writeFileSync(join(bin, "mock"), mock, { mode: 0o755 })
  for (const command of ["uname", "curl", "gh", "hdiutil", "codesign", "ditto", "plutil", "xattr", "pgrep", "osascript", "sleep", "open", "mv"]) symlinkSync(join(bin, "mock"), join(bin, command))
  const manifest = (changes: Record<string, string> = {}, extra = "") => {
    const values = { format: "1", repository: "dbuldum4/zsearch", owner_id: "59258696", repository_id: "1410815604", channel: "main", source_commit: commit, workflow_commit: commit, source_ref: "refs/heads/main", run_id: "100", run_attempt: "1", run_number: "10", dmg_sha256: digest, ...changes }
    writeFileSync(join(remote, "preview.manifest"), Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join("") + extra)
  }
  manifest()
  const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim()
  const install = (options: Record<string, string> = {}, args = ["main"]) => {
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_ROOT: root, REAL_MV: realMv, ZSEARCH_APP_DIR: dest, ...options }
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN
    return spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 15_000 })
  }
  const calls = (): Call[] => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
  const version = () => readFileSync(join(dest, "zsearch.app/version"), "utf8")
  return { root, remote, dest, manifest, install, calls, version }
}

describe("authenticated preview installer", () => {
  test("authenticates before mounting, stages replacement, removes quarantine and is idempotent", () => fixture((f) => {
    const result = f.install()
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(f.version()).toBe("new")
    const calls = f.calls()
    const mount = calls.findIndex((c) => c.command === "hdiutil" && c.args[0] === "attach")
    const verification = calls.map((c, i) => c.command === "gh" && c.args.includes("--bundle") ? i : -1).filter((i) => i >= 0)
    expect(verification).toHaveLength(2)
    expect(verification.every((i) => i < mount)).toBe(true)
    expect(calls.filter((c) => c.command === "curl").every((c) => c.args.includes("--proto-redir") && c.args.includes("=https") && c.args.includes("--max-filesize"))).toBe(true)
    expect(calls.some((c) => c.command === "xattr" && c.args[0] === "-dr")).toBe(true)
    expect(calls.some((c) => c.command === "xattr" && c.args[0] === "-w")).toBe(false)
    expect(statSync(join(f.dest, ".zsearch-preview-state/main")).mode & 0o777).toBe(0o600)
    expect(f.install().status).toBe(0)
    expect(readdirSync(f.dest).some((n) => n.startsWith(".zsearch-stage.") || n === ".zsearch-install-lock")).toBe(false)
  }))

  test("meaning-only selects the authenticated second bundle and can switch back", () => fixture((f) => {
    const app = join(f.remote, "zsearch-meaning.app")
    mkdirSync(join(app, "Contents"), { recursive: true })
    writeFileSync(join(app, "version"), "meaning-only")
    writeFileSync(join(app, "Contents/Info.plist"), "fixture")
    expect(f.install({}, ["main", "--meaning-only"]).status).toBe(0)
    expect(f.version()).toBe("meaning-only")
    expect(f.calls().some(c => c.command === "ditto" && c.args.at(-2)?.endsWith("/zsearch-meaning.app"))).toBe(true)
    expect(f.install().status).toBe(0)
    expect(f.version()).toBe("new")
  }))

  for (const failure of ["manifest-proof", "dmg-proof", "copy", "codesign", "staged-signature", "quarantine", "attributes", "running", "quit-denied", "swap", "state", "interrupt", "state-interrupt"]) {
    test(`${failure} leaves the previous app intact`, () => fixture((f) => {
      expect(f.install({ MOCK_FAIL: failure }).status).not.toBe(0)
      expect(f.version()).toBe("old")
      expect(existsSync(join(f.dest, ".zsearch-preview-state/main"))).toBe(false)
    }))
  }

  test("the latest alias resolves to its versioned build before anything is verified", () => fixture((f) => {
    // A newer build replaced the alias's files while this install was running.
    mkdirSync(join(f.remote, "preview-main"))
    writeFileSync(join(f.remote, "preview-main/zsearch.dmg"), "a newer DMG")
    writeFileSync(join(f.remote, "preview-main/provenance.jsonl"), "a newer bundle")
    const result = f.install()
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    const urls = f.calls().filter((c) => c.command === "curl").map((c) => c.args.at(-1)!)
    expect(urls[0]).toEndWith("/releases/download/preview-main/preview.manifest")
    expect(urls.slice(1).map((u) => u.split("/").slice(-2).join("/"))).toEqual(["preview-main-100-1/preview.manifest", "preview-main-100-1/provenance.jsonl", "preview-main-100-1/zsearch.dmg"])
  }))

  test("an alias without a build identifier is rejected", () => fixture((f) => {
    mkdirSync(join(f.remote, "preview-main"))
    writeFileSync(join(f.remote, "preview-main/preview.manifest"), "format=1\nrun_id=$(touch injected)\nrun_attempt=1\n")
    expect(f.install().stderr).toContain("could not resolve the latest main preview")
    expect(f.calls().filter((c) => c.command === "curl")).toHaveLength(1)
  }))

  test("a denied quit request explains what to do", () => fixture((f) => {
    expect(f.install({ MOCK_FAIL: "quit-denied" }).stderr).toContain("quit it and run the installer again")
  }))

  test("an interrupt after the state write restores the previous build history", () => fixture((f) => {
    expect(f.install().status).toBe(0)
    writeFileSync(join(f.remote, "zsearch.app/version"), "newer")
    f.manifest({ run_number: "11" })
    expect(f.install({ MOCK_FAIL: "state-interrupt" }).status).toBe(143)
    expect(f.version()).toBe("new")
    expect(readFileSync(join(f.dest, ".zsearch-preview-state/main"), "utf8")).toBe(`10 1 ${digest}\n`)
    f.manifest()
    expect(f.install().status).toBe(0)
  }))

  test("tampered DMG fails before mounting", () => fixture((f) => {
    writeFileSync(join(f.remote, "zsearch.dmg"), "tampered DMG")
    expect(f.install().stderr).toContain("checksum verification failed")
    expect(f.calls().some((c) => c.command === "hdiutil")).toBe(false)
    expect(f.version()).toBe("old")
  }))

  const rejectedIdentities: Record<string, string>[] = [{ MOCK_OWNER_ID: "999" }, { MOCK_REPO_ID: "999" }, { MOCK_EVENT: "workflow_dispatch" }, { MOCK_REF: "refs/heads/other" }]
  for (const options of rejectedIdentities) {
    test(`rejects unexpected certificate ${JSON.stringify(options)}`, () => fixture((f) => {
      expect(f.install(options).status).not.toBe(0)
      expect(f.calls().some((c) => c.command === "hdiutil")).toBe(false)
    }))
  }

  test("PR channel binds its merge-workflow identity and actual app head commit", () => fixture((f) => {
    f.manifest({ channel: "pr-12", workflow_commit: workflowCommit, source_ref: "refs/pull/12/merge" })
    const options = { MOCK_REF: "refs/pull/12/merge", MOCK_EVENT: "pull_request", MOCK_WORKFLOW_COMMIT: workflowCommit }
    expect(f.install(options, ["12", "--build", "100-1"]).status).toBe(0)
    expect(f.install(options).status).not.toBe(0)
  }))

  test("app commit and bundle identity must match the authenticated manifest", () => fixture((f) => {
    expect(f.install({ MOCK_APP_COMMIT: workflowCommit }).status).not.toBe(0)
    expect(f.install({ MOCK_APP_ID: "other.app" }).status).not.toBe(0)
    expect(f.version()).toBe("old")
  }))

  test("malformed or extra authenticated metadata is rejected without executing it", () => fixture((f) => {
    f.manifest({}, "source_commit=$(touch injected)\n")
    expect(f.install().status).not.toBe(0)
    f.manifest({ run_number: "99999999999999999999999999" })
    expect(f.install().status).not.toBe(0)
    expect(f.calls().some((c) => c.command === "hdiutil")).toBe(false)
  }))

  test("blocks rollback and digest reuse; explicit downgrade preserves the high-water mark", () => fixture((f) => {
    expect(f.install().status).toBe(0)
    f.manifest({ run_number: "9" })
    expect(f.install().stderr).toContain("older build blocked")
    expect(f.install({}, ["main", "--allow-downgrade"]).status).toBe(0)
    expect(readFileSync(join(f.dest, ".zsearch-preview-state/main"), "utf8")).toBe(`10 1 ${digest}\n`)
    const changed = "another authenticated DMG"
    writeFileSync(join(f.remote, "zsearch.dmg"), changed)
    f.manifest({ dmg_sha256: createHash("sha256").update(changed).digest("hex") })
    expect(f.install().stderr).toContain("same build number has a different digest")
  }))

  test("failed recovery retains the backup instead of deleting it", () => fixture((f) => {
    expect(f.install({ MOCK_FAIL: "restore" }).stderr).toContain("previous app retained")
    const stage = readdirSync(f.dest).find((n) => n.startsWith(".zsearch-stage."))!
    expect(readFileSync(join(f.dest, stage, "previous.app/version"), "utf8")).toBe("old")
  }))

  test("rejects repository overrides, wrong requested builds and symlinked destinations", () => fixture((f) => {
    expect(f.install({ ZSEARCH_REPO: "other/zsearch" }).status).not.toBe(0)
    expect(f.install({}, ["main", "--build", "101-1"]).status).not.toBe(0)
    rmSync(join(f.dest, "zsearch.app"), { recursive: true })
    symlinkSync(join(f.remote, "zsearch.app"), join(f.dest, "zsearch.app"))
    expect(f.install().stderr).toContain("symlinked app")
  }))
})
