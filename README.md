# @perfscale/library-bash

Trusted local **bash steps** for [perfscale](https://github.com/Perfscale) —
a WASM step component (RFC 009) exposing three steps over the bounded
`process` host capability:

| Step | Purpose |
| --- | --- |
| `lib/bash/exec` | Run an inline bash script via `/bin/bash -euo pipefail -c` |
| `lib/bash/exec-file` | Run a script file relative to an explicit working directory |
| `lib/bash/which` | Resolve an executable on the default PATH, optionally with `--version` |

Linux-first: the component assumes `/bin/bash` and `/usr/bin/which` exist.

## Security model — read this first

**This library is trusted arbitrary code execution.** The `process`
capability is an intentional escape hatch, not a sandbox: whatever the
scripts can do on the host, they do with the perfscale process's privileges.

- No shell interpolation by the engine — every spawn is a direct argv to
  `/bin/bash` / `/usr/bin/which` with a **replacement** environment (host
  variables are never inherited; the component supplies a minimal explicit
  `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` which `env` may extend
  or override, string values only).
- Timeouts are optional per step (`timeout_ms`, number or numeric string,
  positive) and always host-capped; on timeout the host kills the process
  tree.
- `exec-file` path confinement (relative `path`, absolute paths and `..`
  rejected, always under an explicit `working-directory`) is a
  **convenience guardrail, not a sandbox** — the invoked bash script can do
  anything regardless.
- No sudo helpers, no global mutations; keep scripts self-contained.

## Installing and granting the capability

Pin the built artifact with the perfscale lockfile:

```console
$ perfscale install github:Perfscale/library-bash@<tag>   # writes perfscale.lock
```

Then grant the capability **twice** (fail-closed, like `net`):

```yaml
# perfscale.config.yaml
allow_library_capabilities: true
allow_process_actions: true
libraries:
  - use: ./bash.wasm            # or the lockfile-managed artifact
    capabilities: [process]
```

Missing either gate, the engine refuses to even load the component.

## Steps

### `lib/bash/exec`

Runs `script` inline: `/bin/bash -euo pipefail -c <script> bash <args...>`
(`argv[0]` of the script is `bash`, extra `args` follow).

```yaml
steps:
  - name: prepare-data
    use: lib/bash/exec
    with:
      script: |
        set -e
        echo "seed=$1"
        ./gen.sh "$1" > data.txt
      args: ["${{ params.seed }}"]
      working-directory: ./fixtures   # alias: cwd
      env: { LC_ALL: C }
      timeout_ms: 10000               # number or numeric string
    outputs: prep
    check:
      message_contains: seed=
```

`with:` keys (unknown keys are rejected):

- `script` (string, **required**)
- `args` (array of strings, optional)
- `working-directory` / `cwd` (string, optional alias pair)
- `env` (map of string→string, optional; merges over the default PATH)
- `timeout_ms` / `timeoutMs` (positive number or numeric string, optional)

Output (`outputs: prep` above) is snake_case per the engine's ActionOutput:

```json
{ "exit_code": 0, "stdout": "...", "stderr": "..." }
```

`success` is `exit_code == 0`. **Non-zero exits keep stdout/stderr** — the
step reports `success: false` with the full output intact.

### `lib/bash/exec-file`

Runs a script file with `/bin/bash <path> <args...>`. `path` (required) must
be **relative** — absolute paths and `..` segments are rejected — and is
resolved under an explicit, **required** `working-directory` (or `cwd`).
Same `args`/`env`/`timeout_ms` rules and output shape as `exec`.

```yaml
steps:
  - name: migrate
    use: lib/bash/exec-file
    with:
      path: scripts/migrate.sh
      working-directory: ./fixtures
      args: ["--dry-run"]
    outputs: migration
```

### `lib/bash/which`

Resolves an executable name via direct argv to `/usr/bin/which` (no shell).
`name` (required) must be a plain executable name — slashes, NULs and
anything outside `[A-Za-z0-9._+-]` are rejected.

```yaml
steps:
  - name: need-jq
    use: lib/bash/which
    with:
      name: jq
      version: true        # also run the resolved binary with --version
    outputs: jq
```

Output:

```json
{ "exit_code": 0, "stdout": "/usr/bin/jq\n", "stderr": "", "path": "/usr/bin/jq",
  "version_exit_code": 0, "version_stdout": "jq-1.7\n", "version_stderr": "" }
```

`version_*` keys appear only when `version: true` and the name resolved;
`success` then also requires the `--version` run to exit 0.

## Run settings (RFC 009)

Every step knob may be set once for the whole run instead of repeated per
step. Precedence (highest first):

1. the step's explicit `with:` params
2. the `bash:` config extension block (claimed via the component's config
   schema — unknown keys fail the run)
3. the `variables.bash` map
4. the library entry's `with:` block
5. the built-in defaults

`env` maps merge in that same order (a step's `env` wins per key). Accepted
settings keys: `executable` (the bash binary, absolute path, default
`/bin/bash`), `working-directory` / `cwd`, `timeout_ms` / `timeoutMs`,
`env`. Invalid blocks (unknown key, wrong type, relative `executable`) are
hard errors — at instantiation for the library `with:`, at step resolution
for the rest. For `exec-file`, a settings-level `working-directory`/`cwd`
satisfies the step's cwd requirement.

```yaml
bash:                        # config extension, validated against the schema
  timeout_ms: 30000
variables:
  bash: { cwd: ./examples }
libraries:
  - use: ./bash.wasm
    capabilities: [process]
    with: { env: { LANG: C } }            # lowest-precedence defaults
steps:
  - name: seed
    use: lib/bash/exec-file
    with:
      path: fixtures/seed.sh              # cwd + timeout come from settings
```

## Orchestration, not hot path

Each step invocation is a **real host process spawn**. Use these steps for
setup, fixtures, and one-off environment checks — the one-shot `before:` /
`after:` blocks are the natural home:

```yaml
before:
  - name: seed-db
    use: lib/bash/exec-file
    with:
      path: scripts/seed.sh
      working-directory: ./fixtures
    outputs: setup        # → ${{ config.setup.stdout }} in test steps
```

Do not put `exec` in the per-iteration VU loop of a high-RPS test; the spawn
cost will dominate the measurement.

## Local e2e

```console
$ npm install
$ npm run build        # → bash.wasm (needs the SDK bin, see below)
$ perfscale run -f examples/bash.test.yaml -c examples/bash.config.yaml
```

Run `perfscale` from the **repository root** — the `script-file` step uses
`working-directory: examples`, resolved against the process cwd. The
intentional non-zero-exit demo lives in the config's `after:` block
(teardown is best-effort), so the load run stays green while the failure's
`exit_code`/`stdout`/`stderr` are still recorded under `failed_run`.

## Development

```console
$ npm install          # file: dependency on the SDK checkout
$ npm test             # unit tests (node:test, fake host exec)
$ npm run typecheck
$ npm run build        # node ../sdk-step-authoring/ts/bin/perfscale-library-build.mjs \
                       #   --kind steps --process src/bash.ts -o bash.wasm
```

Built with [`@perfscale/library-sdk`](../sdk-step-authoring/ts) against
`perfscale:step@0.1.0` (`wit/step/step.wit`).

## License

Dual-licensed under [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at
your option.
