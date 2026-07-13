# T028 Bits dd-apm bootstrap

## Outcome

The checkout now carries the toolkit source selected from `origin/main` as a verified 1.4 MB archive. Bits does not
fetch toolkit source from GitHub. Setup verifies the embedded SHA-256, extracts it into a SHA-owned cache, requires
the extracted `.claude/skills`, installs from that local source, and invokes the managed executable directly.

The bootstrap was also exercised end to end in a real Bits checkout on branch commit `53b64b194`. Setup succeeded
from the embedded archive, installed `dd-apm` 1.2.0rc6, and confirmed the extracted `.claude/skills` tree. The
bootstrap itself is therefore verified. The intended Codex + Trajectory + Datadog backend workflow was not verified
because the Bits environment failed the required capability checks described below.

Toolkit pin:

- Selected ref: `origin/main`
- Commit: `5bb7951901123f3b26ba882ddf4d2bc97155256e`
- Embedded archive: `scripts/vendor/apm-instrumentation-toolkit-5bb7951901123f3b26ba882ddf4d2bc97155256e.tar.gz`
- Archive SHA-256: `d3ba54b12ab3b8b1cf67897d4991724acb290cd99598ebe4e8abb8ca2d5a3fcf`
- Version policy: any runnable `dd-apm version` output
- Cache root: `${XDG_CACHE_HOME:-$HOME/.cache}/dd-apm-bits/5bb7951901123f3b26ba882ddf4d2bc97155256e`
- Cached executable: `venv/bin/dd-apm`
- Provenance marker: `venv/.bits-dd-apm-provenance` containing the pinned commit

The branch does not contain or install `dd-auth`. Local installation metadata and toolkit repository docs did not
identify a supported non-Appgate Linux installation path. A supported Linux `dd-auth` on `PATH` is therefore the
single Bits base-image prerequisite specific to authentication; credentials remain a separate runtime secret
requirement.

## Changed paths

- `scripts/bits-dd-apm-bootstrap.sh`: verified embedded-source install, direct cached invocation, configuration, and
  bounded preflight checks.
- `scripts/bits-dd-apm-setup.sh`: setup entry point.
- `scripts/bits-dd-apm-preflight.sh`: readiness entry point.
- `scripts/bits-dd-apm-bootstrap.spec.mjs`: existing-install, fresh-source, idempotency, failure, and preflight tests.
- `scripts/vendor/apm-instrumentation-toolkit-*.tar.gz{,.sha256}`: pinned toolkit source including `.claude/skills`.
- `reports/T028-bits-dd-apm-bootstrap.md`: this operations and verification record.

## Bits commands

Run setup from the dd-trace-js checkout:

```bash
./scripts/bits-dd-apm-setup.sh
```

Run readiness when Bits injects `DD_API_KEY` and `DD_APP_KEY`:

```bash
./scripts/bits-dd-apm-preflight.sh
```

When the Bits base image provides supported `dd-auth`, obtain runtime credentials without writing them to the
checkout:

```bash
dd-auth --domain app.datadoghq.com --force-app-key -- ./scripts/bits-dd-apm-preflight.sh
```

`BITS_CODEX_MODEL` may select the model probe; otherwise Codex's configured default is used.

## Embedded source proof

The archive was produced from the local toolkit `origin/main` commit above. Verification from the dd-trace-js branch:

```bash
shasum -a 256 -c scripts/vendor/apm-instrumentation-toolkit-*.tar.gz.sha256
tar -tzf scripts/vendor/apm-instrumentation-toolkit-*.tar.gz | rg '/\.claude/skills/'
```

The checksum passed, and the archive contains the toolkit `.claude/skills` tree plus the vendored package source
needed by the local install. The setup path contains no `git fetch` or runtime toolkit-source download. Pip installs
from the extracted local directory with bounded, noninteractive dependency resolution. No destructive integration
was run.

## Bits end-to-end setup evidence

Bits ran the setup and preflight scripts from branch `conti/bits-dd-apm-bootstrap` at commit `53b64b194`.

Setup reported:

- `READY toolkit_source` for revision `5bb7951901123f3b26ba882ddf4d2bc97155256e`, selected from the verified
  embedded archive with SHA-256 `d3ba54b12ab3b8b1cf67897d4991724acb290cd99598ebe4e8abb8ca2d5a3fcf`.
- `READY dd_apm_install` with version `1.2.0rc6`, source `embedded_cache`, and the expected cached executable.
- `READY dd_trace_js_target` for `/workspace/repo`.
- The extracted toolkit `.claude/skills` directory existed and was directly confirmed before workflow execution.
- `dd-apm version` returned `1.2.0rc6`; `dd-apm --help` and `dd-apm config list` executed successfully.

Preflight then identified environment blockers outside the bootstrap:

- `dd-auth` was absent, and `DD_API_KEY` and `DD_APP_KEY` were not injected.
- Codex was not logged in, and the model probe failed through external egress with HTTP 502.
- Trajectory and its configuration were absent.
- The Datadog Agent and APM Test Agent images were not preloaded; registry access failed with HTTP 502.
- Datadog backend access failed with HTTP 502, so backend credential validation could not run.

This run proves that Bits can install and invoke the embedded toolkit and access its skills without fetching source
from GitHub. It does not prove the requested Codex + Trajectory agent run, container-backed validation, or Datadog
backend trace submission; those remain blocked on Bits image configuration, credentials, preloaded images or registry
access, and outbound service connectivity.

## dd-auth investigation

Only already-local metadata, binaries, and repository docs were inspected:

- `/opt/homebrew/bin/dd-auth` resolves to the Homebrew cask's `dd-auth-darwin-arm64` v1.3.2 Mach-O binary.
- The local cask metadata downloads a release archive from `binaries.ddbuild.io`, performs a connection preflight,
  and installs a Darwin binary selected by CPU architecture.
- The archive metadata includes Linux artifacts, but no reviewed repository documentation provides a supported
  non-Appgate Linux installer. Those artifacts were not extracted or copied.
- Toolkit docs describe Dogbrew/Appgate or source checkout; Dogbrew is not used as the primary Linux setup path.

Therefore Bits must provide supported Linux `dd-auth` in its base image (or an organization-supported secret
injection mechanism). This branch does not provide `dd-auth`, credentials, or an authentication substitute.

## Local checks

The focused Node suite was intentionally not rerun for this surgical completion because it is slow and no install was
requested.

```bash
bash -n scripts/bits-dd-apm-bootstrap.sh \
  scripts/bits-dd-apm-setup.sh \
  scripts/bits-dd-apm-preflight.sh

shellcheck scripts/bits-dd-apm-bootstrap.sh \
  scripts/bits-dd-apm-setup.sh \
  scripts/bits-dd-apm-preflight.sh
```

Result: both commands exited `0` with no output.

```bash
git diff --check
git status --short --untracked-files=all
```

Result: `git diff --check` exited `0`; only T028 bootstrap, report, and embedded archive paths changed.

The bootstrap, setup, and preflight scripts all have mode `-rwxr-xr-x`.

## Remaining external requirements

- Python 3.11-3.14 and dependency availability for installing the branch-local toolkit source.
- Supported Linux `dd-auth` in the Bits base image, or organization-supported runtime secret injection.
- Runtime `DD_API_KEY` and `DD_APP_KEY`; they are never committed or synthesized by these scripts.
- A logged-in Codex CLI with access to the configured model or `BITS_CODEX_MODEL`.
- An initialized Trajectory installation and local database.
- A usable Docker or Podman daemon/socket.
- Preloaded `gcr.io/datadoghq/agent:latest` and
  `ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:v1.40.0`, or approved registry access.
- DNS/backend access to `api.${DD_SITE:-datadoghq.com}` for API-key validation.
