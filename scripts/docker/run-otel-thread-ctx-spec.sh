#!/usr/bin/env bash
# Build the test image (idempotent; cached after the first run) and run the
# OTEP-4947 thread-context writer mocha spec inside it, against a freshly
# built local copy of pprof-nodejs (sibling checkout at ../pprof-nodejs).
#
# The local pprof-nodejs is required because the otelThreadCtx namespace
# isn't released yet — the version pinned in package.json doesn't have it.
# Inside the container the tree is copied to a writable scratch dir, so the
# host repo is never modified (no stray node_modules/, build/, out/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DD_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PPROF_REPO_DIR="$(cd "$DD_REPO_DIR/../pprof-nodejs" 2>/dev/null && pwd || true)"

if [[ -z "$PPROF_REPO_DIR" ]]; then
    echo "Could not find sibling ../pprof-nodejs checkout next to $DD_REPO_DIR" >&2
    exit 1
fi

IMAGE_TAG="dd-trace-js-otel-thread-ctx-test:latest"

if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found in PATH; install Docker Desktop / colima / podman-with-docker-alias" >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "docker daemon not reachable; is it running?" >&2
    exit 1
fi

echo "==> building $IMAGE_TAG (cached after first run)"
docker build -q -t "$IMAGE_TAG" "$SCRIPT_DIR" >/dev/null

echo "==> running spec"
exec docker run --rm \
    -v "$DD_REPO_DIR":/dd-source:ro \
    -v "$PPROF_REPO_DIR":/pprof-source:ro \
    "$IMAGE_TAG" \
    bash -c '
        set -euo pipefail

        # Stream-copy via tar so we can skip the host node_modules/.git/build/
        # artifacts (multi-GB on dd-trace-js) without cp -R copying them just
        # to be removed on the next line.
        stage () {
            local src=$1 dst=$2
            mkdir -p "$dst"
            # The `node_modules` form (no leading ./) matches at every depth.
            # The `./...` forms anchor to the top of $src — used for
            # repo-specific caches like dd-trace-js/versions (8 GB of
            # per-version integration-test snapshots) and dd-trace-js/.bun.
            tar -C "$src" \
                --exclude=node_modules \
                --exclude=./.git \
                --exclude=./out \
                --exclude=./build \
                --exclude=./prebuilds \
                --exclude=./.tap \
                --exclude=./.bun \
                --exclude=./versions \
                --exclude=./coverage \
                -cf - . | tar -C "$dst" -xf -
        }

        echo "==> staging pprof-nodejs"
        stage /pprof-source /tmp/pprof

        cd /tmp/pprof
        # `npm install` triggers prepare -> compile + rebuild, which builds the
        # native addon for this container.
        npm install --no-audit --no-fund

        echo "==> staging dd-trace-js"
        stage /dd-source /tmp/work

        cd /tmp/work
        npm install --no-audit --no-fund

        echo "==> overlaying local @datadog/pprof"
        rm -rf node_modules/@datadog/pprof
        cp -R /tmp/pprof node_modules/@datadog/pprof

        echo "==> running mocha"
        npx mocha --timeout 60000 packages/dd-trace/test/otel-thread-ctx.spec.js
    '
