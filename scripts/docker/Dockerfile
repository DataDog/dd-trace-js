# Image for running the OTEP-4947 thread-context writer spec on Linux from a
# non-Linux dev machine. The spec depends on the @datadog/pprof native addon
# (otelThreadCtx namespace, which is on the in-development branch and not
# released yet), so the container needs python3 + a C++ toolchain to build
# the addon from source. Node 24 is used so AsyncContextFrame is available
# without needing to pass --experimental-async-context-frame.
FROM node:24-bookworm

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
        python3 \
        build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/work
