# Security Policy

`@perfscale/library-bash` is a **trusted-code** component: its whole purpose
is executing arbitrary bash on the host via the perfscale `process`
capability (RFC 009). Treat any report of "this library can run shell
commands" as working as intended.

## What is in scope

Genuinely security-relevant findings are cases where the component exceeds
its contract, for example:

- Spawning anything other than the documented `/bin/bash`, `/usr/bin/which`,
  or the `which`-resolved binary for `version: true`.
- Leaking host environment variables into a child (the host import already
  guarantees a replacement environment; a bug that bypasses it matters).
- The `exec_file` path guard being bypassable in a way that surprises an
  operator who relied on it — noting that the guard is a convenience, not a
  sandbox (any script body is arbitrary code anyway).
- Validation gaps that let crafted `with:` params or settings blocks
  (extension / variables / library `with:`) alter the spawned argv or
  environment in undocumented ways.

## What is out of scope

- "The step ran the command the YAML told it to run." Capability grants
  (`capabilities: [process]`, `allow_process_actions: true`,
  `allow_library_capabilities: true`) are the operator's explicit,
  double opt-in decision.
- Denial of service via long-running or noisy scripts — timeouts are
  host-capped; tune `timeout_ms`.

## Reporting

Do not open a public issue for a vulnerability. Report privately to the
Perfscale maintainers (see the contact in the main perfscale repository's
SECURITY.md) with a minimal YAML + script reproducer. We aim to acknowledge
within 7 days.

## Supported versions

Only the latest release receives security fixes.
