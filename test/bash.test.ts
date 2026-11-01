import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StepCtx, StepError, testStep, type ExecRequest, type ExecResult, type HostExec } from "@perfscale/library-sdk";
import def from "../src/bash.ts";

/**
 * Record every host spawn and answer from a script. The harness fake is a
 * WIT-boundary `HostExec` (env as entry pairs); tests see the ergonomic
 * ExecRequest shape (env as a Record) the component itself uses.
 */
function fakeExec(handler: (req: ExecRequest, call: number) => ExecResult) {
  const calls: ExecRequest[] = [];
  const exec: HostExec = (wreq) => {
    const req: ExecRequest = {
      executable: wreq.executable,
      env: Object.fromEntries(wreq.env ?? []),
    };
    if (wreq.argv !== undefined) req.argv = wreq.argv;
    if (wreq.cwd !== undefined) req.cwd = wreq.cwd;
    if (wreq.timeoutMs !== undefined) req.timeoutMs = wreq.timeoutMs;
    calls.push(req);
    return handler(req, calls.length - 1);
  };
  return { calls, exec };
}

const ok: ExecResult = { exitCode: 0, stdout: "hello\n", stderr: "" };

function ctx(exec?: HostExec): StepCtx {
  const c = new StepCtx(exec);
  c.stepName = "t";
  return c;
}

describe("bash/exec", () => {
  it("runs a script with -euo pipefail and bash as argv[0]", () => {
    const { calls, exec } = fakeExec(() => ok);
    const res = testStep(def, ctx(exec), "exec", { script: "echo hello" });
    assert.equal(res.success, true);
    assert.deepEqual(res.output, { exit_code: 0, stdout: "hello\n", stderr: "" });
    const req = calls[0]!;
    assert.equal(req.executable, "/bin/bash");
    assert.deepEqual(req.argv, ["-euo", "pipefail", "-c", "echo hello", "bash"]);
    assert.equal(req.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(req.env?.PERFSCALE_STEP, "t");
  });

  it("passes args after the script", () => {
    const { calls, exec } = fakeExec(() => ok);
    testStep(def, ctx(exec), "exec", { script: "echo $1", args: ["one", "two"] });
    assert.deepEqual(calls[0]!.argv, ["-euo", "pipefail", "-c", "echo $1", "bash", "one", "two"]);
  });

  it("accepts cwd alias and merges user env over the default PATH", () => {
    const { calls, exec } = fakeExec(() => ok);
    testStep(def, ctx(exec), "exec", {
      script: "x", cwd: "/tmp/work", env: { FOO: "bar" },
    });
    assert.equal(calls[0]!.cwd, "/tmp/work");
    assert.equal(calls[0]!.env?.FOO, "bar");
    assert.equal(calls[0]!.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("lets user env override PATH", () => {
    const { calls, exec } = fakeExec(() => ok);
    testStep(def, ctx(exec), "exec", { script: "x", env: { PATH: "/custom/bin" } });
    assert.equal(calls[0]!.env?.PATH, "/custom/bin");
  });

  it("accepts timeout_ms as number or numeric string", () => {
    const { calls, exec } = fakeExec(() => ok);
    testStep(def, ctx(exec), "exec", { script: "x", timeout_ms: "2500" });
    assert.equal(calls[0]!.timeoutMs, 2500);
    testStep(def, ctx(exec), "exec", { script: "x", timeoutMs: 500 });
    assert.equal(calls[1]!.timeoutMs, 500);
  });

  it("keeps output on non-zero exit and reports success=false", () => {
    const { exec } = fakeExec(() => ({ exitCode: 2, stdout: "partial\n", stderr: "boom\n" }));
    const res = testStep(def, ctx(exec), "exec", { script: "exit 2" });
    assert.equal(res.success, false);
    assert.deepEqual(res.output, { exit_code: 2, stdout: "partial\n", stderr: "boom\n" });
    assert.ok(res.logs!.some((l) => l.tag === "err" && l.line === "boom"));
  });

  it("rejects missing/empty script and wrong types", () => {
    const { exec } = fakeExec(() => ok);
    assert.throws(() => testStep(def, ctx(exec), "exec", {}), StepError);
    assert.throws(() => testStep(def, ctx(exec), "exec", { script: "" }), /'script' is required/);
    assert.throws(() => testStep(def, ctx(exec), "exec", { script: 1 }), StepError);
  });

  it("rejects unknown keys", () => {
    const { exec } = fakeExec(() => ok);
    assert.throws(
      () => testStep(def, ctx(exec), "exec", { script: "x", shell: true }),
      /unknown param 'shell'/,
    );
  });

  it("rejects bad timeout, env, and args values", () => {
    const { exec } = fakeExec(() => ok);
    for (const p of [
      { script: "x", timeout_ms: -1 },
      { script: "x", timeout_ms: "abc" },
      { script: "x", timeout_ms: 0 },
      { script: "x", env: { A: 1 } },
      { script: "x", env: ["A=1"] },
      { script: "x", args: "oops" },
      { script: "x", args: [1] },
      { script: "x", cwd: 5 },
    ]) {
      assert.throws(() => testStep(def, ctx(exec), "exec", p), StepError, JSON.stringify(p));
    }
  });

  it("rejects disagreeing working-directory/cwd", () => {
    const { exec } = fakeExec(() => ok);
    assert.throws(
      () => testStep(def, ctx(exec), "exec", { script: "x", "working-directory": "/a", cwd: "/b" }),
      /disagree/,
    );
  });

  it("throws when the process capability is not connected", () => {
    assert.throws(() => testStep(def, ctx(), "exec", { script: "x" }), /process capability/);
  });
});

describe("bash/exec-file", () => {
  it("runs the script file under the working-directory", () => {
    const { calls, exec } = fakeExec(() => ok);
    const res = testStep(def, ctx(exec), "exec-file", {
      path: "scripts/setup.sh", cwd: "/tmp/work", args: ["--fast"],
    });
    assert.equal(res.success, true);
    assert.equal(calls[0]!.executable, "/bin/bash");
    assert.deepEqual(calls[0]!.argv, ["scripts/setup.sh", "--fast"]);
    assert.equal(calls[0]!.cwd, "/tmp/work");
  });

  it("keeps output on non-zero exit", () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "nope\n" }));
    const res = testStep(def, ctx(exec), "exec-file", { path: "x.sh", cwd: "/w" });
    assert.equal(res.success, false);
    assert.equal((res.output as { stderr: string }).stderr, "nope\n");
  });

  it("rejects absolute paths and parent traversal", () => {
    const { exec } = fakeExec(() => ok);
    for (const p of ["/etc/passwd", "../up.sh", "a/../../b.sh", "C:\\win"]) {
      assert.throws(
        () => testStep(def, ctx(exec), "exec-file", { path: p, cwd: "/w" }),
        StepError,
        p,
      );
    }
  });

  it("requires an explicit working-directory/cwd", () => {
    const { exec } = fakeExec(() => ok);
    assert.throws(
      () => testStep(def, ctx(exec), "exec-file", { path: "x.sh" }),
      /'working-directory'.*required/,
    );
  });

  it("rejects unknown keys", () => {
    const { exec } = fakeExec(() => ok);
    assert.throws(
      () => testStep(def, ctx(exec), "exec-file", { path: "x.sh", cwd: "/w", sudo: true }),
      /unknown param 'sudo'/,
    );
  });
});

describe("bash/which", () => {
  const found = { exitCode: 0, stdout: "/usr/bin/curl\n", stderr: "" };

  it("resolves a name with direct argv", () => {
    const { calls, exec } = fakeExec(() => found);
    const res = testStep(def, ctx(exec), "which", { name: "curl" });
    assert.equal(res.success, true);
    assert.deepEqual(calls[0]!.argv, ["curl"]);
    assert.equal(calls[0]!.executable, "/usr/bin/which");
    const out = res.output as { path: string; exit_code: number };
    assert.equal(out.path, "/usr/bin/curl");
    assert.equal(out.exit_code, 0);
  });

  it("reports success=false when the name is not found", () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const res = testStep(def, ctx(exec), "which", { name: "nope" });
    assert.equal(res.success, false);
    assert.equal((res.output as { path: string }).path, "");
  });

  it("runs the resolved program with --version when version=true", () => {
    const { calls, exec } = fakeExec((_req, call) =>
      call === 0 ? found : { exitCode: 0, stdout: "curl 8.0.0\n", stderr: "" },
    );
    const res = testStep(def, ctx(exec), "which", { name: "curl", version: true });
    assert.equal(res.success, true);
    assert.deepEqual(calls[1]!.argv, ["--version"]);
    assert.equal(calls[1]!.executable, "/usr/bin/curl");
    assert.equal((res.output as { version_stdout: string }).version_stdout, "curl 8.0.0\n");
  });

  it("fails when --version exits non-zero", () => {
    const { exec } = fakeExec((_req, call) =>
      call === 0 ? found : { exitCode: 3, stdout: "", stderr: "bad" },
    );
    const res = testStep(def, ctx(exec), "which", { name: "curl", version: true });
    assert.equal(res.success, false);
    assert.equal((res.output as { version_exit_code: number }).version_exit_code, 3);
  });

  it("skips --version when the name is not found", () => {
    const { calls, exec } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const res = testStep(def, ctx(exec), "which", { name: "nope", version: true });
    assert.equal(res.success, false);
    assert.equal(calls.length, 1);
  });

  it("rejects names with slashes, NUL, or bad characters", () => {
    const { exec } = fakeExec(() => found);
    for (const n of ["a/b", "/bin/sh", "a\0b", "a b", "a;rm", ""] ) {
      assert.throws(() => testStep(def, ctx(exec), "which", { name: n }), StepError, JSON.stringify(n));
    }
  });

  it("rejects non-boolean version and unknown keys", () => {
    const { exec } = fakeExec(() => found);
    assert.throws(() => testStep(def, ctx(exec), "which", { name: "curl", version: "yes" }), /boolean/);
    assert.throws(() => testStep(def, ctx(exec), "which", { name: "curl", path: "/x" }), /unknown param 'path'/);
  });
});

// ---------------------------------------------------------------------------
// Settings (RFC 009): extensions[bash] > variables[bash] > library with
// > built-in defaults; explicit step `with:` wins over everything.
// ---------------------------------------------------------------------------

function settingsCtx(
  exec: HostExec | undefined,
  settings: { extensions?: Record<string, unknown>; variables?: Record<string, unknown> },
): StepCtx {
  const c = ctx(exec);
  c.settings = {
    vus: null,
    duration_ms: null,
    seed: null,
    stages: null,
    arrival: null,
    variables: settings.variables ?? {},
    extensions: settings.extensions ?? {},
  };
  return c;
}

/** Reset library-level `with:` defaults so module state never leaks between tests. */
function resetLibraryWith() {
  def.init?.(null);
}

describe("bash settings", () => {
  it("applies executable/cwd/timeout from the run extension", () => {
    resetLibraryWith();
    const { calls, exec } = fakeExec(() => ok);
    const res = testStep(
      def,
      settingsCtx(exec, {
        extensions: { bash: { executable: "/usr/local/bin/bash", cwd: "/ext", timeout_ms: 7000 } },
      }),
      "exec",
      { script: "x" },
    );
    assert.equal(res.success, true);
    assert.equal(calls[0]!.executable, "/usr/local/bin/bash");
    assert.equal(calls[0]!.cwd, "/ext");
    assert.equal(calls[0]!.timeoutMs, 7000);
  });

  it("explicit step params beat extension, extension beats variables, variables beat library with", () => {
    def.init?.({ cwd: "/lib", timeout_ms: 1000 });
    try {
      const { calls, exec } = fakeExec(() => ok);
      testStep(
        def,
        settingsCtx(exec, {
          variables: { bash: { cwd: "/vars", timeout_ms: 2000 } },
          extensions: { bash: { cwd: "/ext" } },
        }),
        "exec",
        { script: "x" },
      );
      assert.equal(calls[0]!.cwd, "/ext");
      assert.equal(calls[0]!.timeoutMs, 2000);
      testStep(
        def,
        settingsCtx(exec, {}),
        "exec",
        { script: "x", cwd: "/step" },
      );
      assert.equal(calls[1]!.cwd, "/step");
      assert.equal(calls[1]!.timeoutMs, 1000);
    } finally {
      resetLibraryWith();
    }
  });

  it("exec-file takes its working-directory from settings when the step omits it", () => {
    resetLibraryWith();
    const { calls, exec } = fakeExec(() => ok);
    const res = testStep(
      def,
      settingsCtx(exec, { extensions: { bash: { cwd: "/srv/app" } } }),
      "exec-file",
      { path: "scripts/setup.sh" },
    );
    assert.equal(res.success, true);
    assert.equal(calls[0]!.cwd, "/srv/app");
    assert.deepEqual(calls[0]!.argv, ["scripts/setup.sh"]);
  });

  it("exec merges env in precedence order: step > extension > variables > library with", () => {
    def.init?.({ env: { A: "lib", B: "lib", C: "lib", D: "lib" } });
    try {
      const { calls, exec } = fakeExec(() => ok);
      testStep(
        def,
        settingsCtx(exec, {
          variables: { bash: { env: { B: "vars", C: "vars", D: "vars" } } },
          extensions: { bash: { env: { C: "ext", D: "ext" } } },
        }),
        "exec",
        { script: "x", env: { D: "step" } },
      );
      assert.equal(calls[0]!.env?.A, "lib");
      assert.equal(calls[0]!.env?.B, "vars");
      assert.equal(calls[0]!.env?.C, "ext");
      assert.equal(calls[0]!.env?.D, "step");
      assert.equal(calls[0]!.env?.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    } finally {
      resetLibraryWith();
    }
  });

  it("rejects invalid settings blocks", () => {
    resetLibraryWith();
    const { exec } = fakeExec(() => ok);
    for (const settings of [
      { extensions: { bash: { bogus: 1 } } },
      { extensions: { bash: { env: { A: 1 } } } },
      { extensions: { bash: { executable: "relative/bash" } } },
      { extensions: { bash: { timeout_ms: 0 } } },
      { variables: { bash: "not-an-object" } },
      { variables: { bash: { cwd: "/a", "working-directory": "/b" } } },
    ]) {
      assert.throws(
        () => testStep(def, settingsCtx(exec, settings), "exec", { script: "x" }),
        StepError,
        JSON.stringify(settings),
      );
    }
  });

  it("rejects an invalid library with block at init", () => {
    assert.throws(() => def.init?.({ cwd: 42 }), StepError);
    assert.throws(() => def.init?.({ unknown: true }), StepError);
    resetLibraryWith();
  });
});
