# We use the Docker image rather than the npm package for two reasons:
# 1. Installing the npm package makes unauthenticated GitHub API calls to
#    download platform-specific binaries, which causes rate limit failures in CI.
# 2. Using a single pinned image guarantees that local runs and CI always use
#    the exact same binary, regardless of what platform the npm package resolves
#    to. Dependabot keeps this digest up to date automatically.
FROM mstruebing/editorconfig-checker@sha256:eb478136c4342af399bb90537319722a7da289b8a7a8d2471592e3d7a5f5bfa7
