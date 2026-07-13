# T028 Bits dd-apm bootstrap

## Outcome

The checkout now has noninteractive setup and preflight wrappers for Bits. Setup uses only the managed executable in
the SHA-owned cache for the pinned toolkit source selected from `origin/main`. An arbitrary `dd-apm` on `PATH` is
never accepted. The cached executable must carry the matching provenance marker and pass a runnable `dd-apm version`
probe; no release semver is required. The wrappers invoke that cached executable directly, so callers do not need to
modify `PATH`.

The implementation is complete locally, but the main-SHA install is not live-proven. Prior source-fetch and build
observations are retained only as historical context; no new install was run for this completion.

Toolkit pin:

- Official source: `git@github.com:DataDog/apm-instrumentation-toolkit.git`
- Selected ref: `origin/main`
- Commit: `5bb7951901123f3b26ba882ddf4d2bc97155256e`
- Version policy: any runnable `dd-apm version` output
- Cache root: `${XDG_CACHE_HOME:-$HOME/.cache}/dd-apm-bits/5bb7951901123f3b26ba882ddf4d2bc97155256e`
- Cached executable: `venv/bin/dd-apm`
- Provenance marker: `venv/.bits-dd-apm-provenance` containing the pinned commit

The branch does not contain or install `dd-auth`. Local installation metadata and toolkit repository docs did not
identify a supported non-Appgate Linux installation path. A supported Linux `dd-auth` on `PATH` is therefore the
single Bits base-image prerequisite specific to authentication; credentials remain a separate runtime secret
requirement.

## Changed paths

- `scripts/bits-dd-apm-bootstrap.sh`: pinned source install, direct cached invocation, checkout configuration, and
  bounded preflight checks.
- `scripts/bits-dd-apm-setup.sh`: setup entry point.
- `scripts/bits-dd-apm-preflight.sh`: readiness entry point.
- `scripts/bits-dd-apm-bootstrap.spec.mjs`: existing-install, fresh-source, idempotency, failure, and preflight tests.
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

## Historical source proof

An earlier isolated run fetched the official source and reached the build phase. That observation is historical only;
the main install was not rerun here and is not claimed live-proven. The prior run used temporary home, cache, and
temporary directories and was stopped before producing a usable installed executable. No slow pip install was repeated.

```bash
# Historical command only; do not repeat as part of T028 completion.
./scripts/bits-dd-apm-setup.sh
```

The prior build attempt progressed through successful package builds:

```text
Processing a vendored semantic-conventions dependency
Successfully built the toolkit and vendored dependency
Installing collected packages: ... dd-apm
```

The install was stopped before it produced a usable executable. Consequently, no claim is made that the clean main
install completed, that a second real setup was idempotent, or that source-installed commands ran. No destructive
integration was run.

The final pip command has a 300-second process bound plus `--timeout 15 --retries 0`; git fetch has a 120-second
process bound, noninteractive SSH, and a 10-second SSH connection timeout. Every preflight network probe is also
bounded and reports failure.

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

Result: `git diff --check` exited `0`; status contained exactly the five intended untracked paths below.

```text
?? reports/T028-bits-dd-apm-bootstrap.md
?? scripts/bits-dd-apm-bootstrap.sh
?? scripts/bits-dd-apm-bootstrap.spec.mjs
?? scripts/bits-dd-apm-preflight.sh
?? scripts/bits-dd-apm-setup.sh
```

The bootstrap, setup, and preflight scripts all have mode `-rwxr-xr-x`.

## Remaining external requirements

- Python 3.11-3.14 and public pip access for the pinned toolkit source installation.
- GitHub SSH checkout access to the official toolkit repository.
- Supported Linux `dd-auth` in the Bits base image, or organization-supported runtime secret injection.
- Runtime `DD_API_KEY` and `DD_APP_KEY`; they are never committed or synthesized by these scripts.
- A logged-in Codex CLI with access to the configured model or `BITS_CODEX_MODEL`.
- An initialized Trajectory installation and local database.
- A usable Docker or Podman daemon/socket.
- Preloaded `gcr.io/datadoghq/agent:latest` and
  `ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:v1.40.0`, or approved registry access.
- DNS/backend access to `api.${DD_SITE:-datadoghq.com}` for API-key validation.
