import {
  defineSteps,
  StepError,
  type ExecResult,
  type StepCtx,
} from "@perfscale/library-sdk";

/**
 * `bash` — trusted local shell steps for perfscale (RFC 009 `process`
 * capability). Every step spawns a host process through the bounded host
 * import (`ctx.exec`): no ambient environment (a replacement env is always
 * supplied), a host-capped timeout, captured stdout/stderr. The component
 * only loads when the run grants the capability twice over:
 * `capabilities: [process]` on the library entry AND
 * `allow_process_actions: true` + `allow_library_capabilities: true` in the
 * config. Linux-first; `/bin/bash` and `/usr/bin/which` must exist.
 *
 * Settings (RFC 009): every step knob may also come from the run —
 * `extensions[bash]` > `variables[bash]` > the library entry's `with:`
 * > built-in defaults; a step's explicit `with:` param beats them all, and
 * `env` maps merge in that order. The component claims the `bash` config
 * extension key via its config schema (unknown keys fail the run).
 *
 * Build: node ../sdk-step-authoring/ts/bin/perfscale-library-build.mjs \
 *          --kind steps --process src/bash.ts -o bash.wasm
 */

/** Minimal explicit PATH: the host environment is never inherited. */
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Default shell; overridable via settings (`executable`). */
const DEFAULT_BASH_PATH = "/bin/bash";

// ---------------------------------------------------------------------------
// Settings (RFC 009): library `with:` defaults + run settings
// ---------------------------------------------------------------------------

/** The accepted keys of any settings block (step `with:` adds more). */
const SETTINGS_KEYS = [
  "executable", "working-directory", "cwd", "timeout_ms", "timeoutMs", "env",
];

/** Normalized per-run defaults collected from the settings sources. */
interface BashSettings {
  executable?: string | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: Record<string, string> | undefined;
}

/** JSON Schema for the claimed `bash` config extension key. */
const BASH_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    executable: { type: "string", minLength: 1 },
    "working-directory": { type: "string", minLength: 1 },
    cwd: { type: "string", minLength: 1 },
    timeout_ms: { type: ["number", "string"] },
    timeoutMs: { type: ["number", "string"] },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} as const;

function parseSettingsBlock(source: string, raw: unknown): BashSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StepError(`bash settings (${source}): must be an object`);
  }
  const block = raw as Record<string, unknown>;
  for (const k of Object.keys(block)) {
    if (!SETTINGS_KEYS.includes(k)) {
      throw new StepError(`bash settings (${source}): unknown key '${k}'`);
    }
  }
  const s: BashSettings = {};
  const str = (key: string): string | undefined => {
    const v = block[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") {
      throw new StepError(`bash settings (${source}): '${key}' must be a non-empty string`);
    }
    return v;
  };
  s.executable = str("executable");
  if (s.executable !== undefined && !s.executable.startsWith("/")) {
    throw new StepError(`bash settings (${source}): 'executable' must be an absolute path`);
  }
  const wd = str("working-directory");
  const cwd = str("cwd");
  if (wd !== undefined && cwd !== undefined && wd !== cwd) {
    throw new StepError(`bash settings (${source}): 'working-directory' and 'cwd' disagree`);
  }
  s.cwd = wd ?? cwd;
  const t = block["timeout_ms"] ?? block["timeoutMs"];
  if (t !== undefined) {
    const n = typeof t === "number" ? t : typeof t === "string" ? Number(t) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw new StepError(`bash settings (${source}): timeout must be a positive number of milliseconds`);
    }
    s.timeoutMs = n;
  }
  const env = block["env"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new StepError(`bash settings (${source}): 'env' must be a map of string to string`);
    }
    s.env = {};
    for (const [k, val] of Object.entries(env as Record<string, unknown>)) {
      if (typeof val !== "string") {
        throw new StepError(`bash settings (${source}): env['${k}'] must be a string`);
      }
      s.env[k] = val;
    }
  }
  return s;
}

/** Library-level `with:` defaults, captured by `init` at instantiation. */
let libraryDefaults: BashSettings = {};

/**
 * Resolve the effective settings for one step invocation:
 * run extension > run variables > library `with:` (the step's own `with:`
 * params are applied by the caller on top). Invalid blocks fail the step.
 */
function resolveSettings(ctx: StepCtx): BashSettings {
  const ext = parseSettingsBlock(
    "extensions[bash]",
    ctx.settings.extensions?.["bash"],
  );
  const vars = parseSettingsBlock(
    "variables[bash]",
    ctx.settings.variables?.["bash"],
  );
  const lib = libraryDefaults;
  return {
    executable: ext.executable ?? vars.executable ?? lib.executable,
    cwd: ext.cwd ?? vars.cwd ?? lib.cwd,
    timeoutMs: ext.timeoutMs ?? vars.timeoutMs ?? lib.timeoutMs,
    env: { ...lib.env, ...vars.env, ...ext.env },
  };
}

/** A `with:` block may only carry these keys; anything else is an error. */
function strictKeys(step: string, params: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      throw new StepError(`bash/${step}: unknown param '${k}'`);
    }
  }
}

function reqString(step: string, params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") {
    throw new StepError(`bash/${step}: '${key}' is required and must be a non-empty string`);
  }
  return v;
}

/** `working-directory` with `cwd` as an accepted alias; both must agree. */
function optCwd(step: string, params: Record<string, unknown>): string | undefined {
  const wd = params["working-directory"];
  const cwd = params["cwd"];
  for (const [k, v] of [["working-directory", wd], ["cwd", cwd]] as const) {
    if (v !== undefined && (typeof v !== "string" || v === "")) {
      throw new StepError(`bash/${step}: '${k}' must be a non-empty string`);
    }
  }
  if (wd !== undefined && cwd !== undefined && wd !== cwd) {
    throw new StepError(`bash/${step}: 'working-directory' and 'cwd' disagree`);
  }
  return (wd ?? cwd) as string | undefined;
}

/** User env merges over the minimal PATH and any settings-level env. */
function optEnv(
  step: string,
  params: Record<string, unknown>,
  base: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = { PATH: DEFAULT_PATH, ...base };
  const v = params["env"];
  if (v === undefined) return env;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new StepError(`bash/${step}: 'env' must be a map of string to string`);
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new StepError(`bash/${step}: env['${k}'] must be a string`);
    }
    env[k] = val;
  }
  return env;
}

/** Extra arguments, passed verbatim after the script (no shell splitting). */
function optArgs(step: string, params: Record<string, unknown>): string[] {
  const v = params["args"];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
    throw new StepError(`bash/${step}: 'args' must be an array of strings`);
  }
  return v as string[];
}

/** Accepts a number or a numeric string (like other perfscale params). */
function optTimeoutMs(step: string, params: Record<string, unknown>): number | undefined {
  for (const key of ["timeout_ms", "timeoutMs"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw new StepError(`bash/${step}: '${key}' must be a positive number of milliseconds`);
    }
    return n;
  }
  return undefined;
}

/** Non-zero exits keep their output — callers check `success`/`exit_code`. */
function processResult(step: string, res: ExecResult): {
  success: boolean;
  output: { exit_code: number; stdout: string; stderr: string };
  logs: { tag: "out" | "err" | "sys"; line: string }[];
} {
  const logs: { tag: "out" | "err" | "sys"; line: string }[] = [
    { tag: "sys", line: `bash/${step}: exit code ${res.exitCode}` },
  ];
  if (res.stdout !== "") logs.push({ tag: "out", line: res.stdout.trimEnd() });
  if (res.stderr !== "") logs.push({ tag: "err", line: res.stderr.trimEnd() });
  return {
    success: res.exitCode === 0,
    output: { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr },
    logs,
  };
}

function runHost(
  ctx: StepCtx,
  req: {
    executable: string;
    argv: string[];
    env: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  },
): ExecResult {
  return ctx.exec({
    executable: req.executable,
    argv: req.argv,
    env: { ...req.env, PERFSCALE_STEP: ctx.stepName },
    ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  });
}

export default defineSteps({
  name: "bash",
  version: "0.1.0",
  configSchema: { key: "bash", schema: BASH_CONFIG_SCHEMA },
  init(config) {
    // Library-level `with:` defaults — validated once at instantiation;
    // invalid defaults are fatal to the run, never silently ignored.
    libraryDefaults = parseSettingsBlock("library with", config);
  },
  steps: {
    exec: {
      description:
        "Run an inline bash script (`/bin/bash -euo pipefail -c`); step fails on non-zero exit",
      run(params, ctx) {
        strictKeys("exec", params, [
          "script", "args", "working-directory", "cwd", "env", "timeout_ms", "timeoutMs",
        ]);
        const script = reqString("exec", params, "script");
        const settings = resolveSettings(ctx);
        const args = optArgs("exec", params);
        const cwd = optCwd("exec", params) ?? settings.cwd;
        const env = optEnv("exec", params, settings.env);
        const timeoutMs = optTimeoutMs("exec", params) ?? settings.timeoutMs;
        // argv[0] of the script is "bash"; extra args follow.
        const res = runHost(ctx, {
          executable: settings.executable ?? DEFAULT_BASH_PATH,
          argv: ["-euo", "pipefail", "-c", script, "bash", ...args],
          env,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        return processResult("exec", res);
      },
    },
    "exec-file": {
      description:
        "Run a bash script file relative to an explicit working-directory (absolute paths and '..' rejected)",
      run(params, ctx) {
        strictKeys("exec-file", params, [
          "path", "args", "working-directory", "cwd", "env", "timeout_ms", "timeoutMs",
        ]);
        const path = reqString("exec-file", params, "path");
        if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
          throw new StepError(`bash/exec-file: 'path' must be relative to the working-directory`);
        }
        if (path.split("/").includes("..")) {
          throw new StepError(`bash/exec-file: 'path' must not contain '..'`);
        }
        const settings = resolveSettings(ctx);
        const cwd = optCwd("exec-file", params) ?? settings.cwd;
        if (cwd === undefined) {
          throw new StepError(`bash/exec-file: 'working-directory' (or 'cwd') is required`);
        }
        const args = optArgs("exec-file", params);
        const env = optEnv("exec-file", params, settings.env);
        const timeoutMs = optTimeoutMs("exec-file", params) ?? settings.timeoutMs;
        const res = runHost(ctx, {
          executable: settings.executable ?? DEFAULT_BASH_PATH,
          argv: [path, ...args],
          env,
          cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        return processResult("exec-file", res);
      },
    },
    which: {
      description:
        "Resolve an executable on the default PATH (`/usr/bin/which`); optionally run it with `--version`",
      run(params, ctx) {
        strictKeys("which", params, ["name", "version", "env", "timeout_ms", "timeoutMs"]);
        const name = reqString("which", params, "name");
        if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.includes("/") || name.includes("\0")) {
          throw new StepError(`bash/which: 'name' must be a plain executable name (no slashes)`);
        }
        const version = params["version"];
        if (version !== undefined && typeof version !== "boolean") {
          throw new StepError(`bash/which: 'version' must be a boolean`);
        }
        const env = optEnv("which", params, resolveSettings(ctx).env);
        const timeoutMs = optTimeoutMs("which", params) ?? resolveSettings(ctx).timeoutMs;
        const res = runHost(ctx, {
          executable: "/usr/bin/which",
          argv: [name],
          env,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        const found = res.exitCode === 0;
        const resolved = found ? res.stdout.trim().split("\n")[0]! : "";
        const output: Record<string, unknown> = {
          exit_code: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          path: resolved,
        };
        const logs: { tag: "out" | "err" | "sys"; line: string }[] = [
          { tag: "sys", line: `bash/which: '${name}' ${found ? `→ ${resolved}` : "not found"}` },
        ];
        let success = found;
        if (version === true && found) {
          const vres = runHost(ctx, {
            executable: resolved,
            argv: ["--version"],
            env,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          output["version_exit_code"] = vres.exitCode;
          output["version_stdout"] = vres.stdout;
          output["version_stderr"] = vres.stderr;
          if (vres.stdout !== "") logs.push({ tag: "out", line: vres.stdout.trimEnd() });
          if (vres.stderr !== "") logs.push({ tag: "err", line: vres.stderr.trimEnd() });
          success = vres.exitCode === 0;
        }
        return { success, output, logs };
      },
    },
  },
});
