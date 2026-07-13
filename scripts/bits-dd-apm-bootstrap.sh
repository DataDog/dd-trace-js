#!/usr/bin/env bash

set -euo pipefail

readonly TOOLKIT_REVISION="5bb7951901123f3b26ba882ddf4d2bc97155256e"
readonly TOOLKIT_SOURCE_URL="git@github.com:DataDog/apm-instrumentation-toolkit.git"
readonly DD_AUTH_DOMAIN="app.datadoghq.com"
readonly DATADOG_AGENT_IMAGE="gcr.io/datadoghq/agent:latest"
readonly TEST_AGENT_IMAGE="ghcr.io/datadog/dd-apm-test-agent/ddapm-test-agent:v1.40.0"
readonly GIT_INSTALL_TIMEOUT_SECONDS=120
readonly PIP_INSTALL_TIMEOUT_SECONDS=300
readonly VENV_INSTALL_TIMEOUT_SECONDS=60
readonly LOCAL_PROBE_TIMEOUT_SECONDS=15
readonly MODEL_PROBE_TIMEOUT_SECONDS=45

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
REPO_ROOT=$(git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null) || {
  printf 'MISSING setup detail=not_a_git_checkout\n' >&2
  exit 1
}
readonly REPO_ROOT

if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
  CACHE_HOME="${XDG_CACHE_HOME}"
elif [[ -n "${HOME:-}" ]]; then
  CACHE_HOME="${HOME}/.cache"
else
  printf 'MISSING setup detail=HOME_and_XDG_CACHE_HOME_unset\n' >&2
  exit 1
fi
readonly CACHE_HOME
readonly TOOLKIT_ROOT="${CACHE_HOME}/dd-apm-bits/${TOOLKIT_REVISION}"
readonly TOOLKIT_SOURCE_DIR="${TOOLKIT_ROOT}/source"
readonly TOOLKIT_VENV_DIR="${TOOLKIT_ROOT}/venv"
readonly CACHED_DD_APM="${TOOLKIT_VENV_DIR}/bin/dd-apm"
readonly CACHED_DD_APM_PROVENANCE="${TOOLKIT_VENV_DIR}/.bits-dd-apm-provenance"

failures=0
container_runtime=""
datadog_agent_image_ready=false
test_agent_image_ready=false
dd_apm_command=""
dd_apm_source=""

status() {
  printf '%-7s %-24s %s\n' "$1" "$2" "$3"
}

summarize_output() {
  local value="${1//$'\n'/; }"

  if ((${#value} <= 300)); then
    printf '%s' "$value"
  else
    printf '%s...%s' "${value:0:140}" "${value: -157}"
  fi
}

missing() {
  status "MISSING" "$1" "$2"
  failures=$((failures + 1))
}

blocked() {
  status "BLOCKED" "$1" "$2"
  failures=$((failures + 1))
}

run_with_timeout() {
  local seconds="$1"
  shift
  run_with_timeout_in "$seconds" "" "$@"
}

run_with_timeout_in() {
  local directory="$2"
  local seconds="$1"
  shift 2
  python3 - "$seconds" "$directory" "$@" <<'PY'
import subprocess
import sys

command = sys.argv[3:]
try:
    result = subprocess.run(command, cwd=sys.argv[2] or None, timeout=int(sys.argv[1]))
except subprocess.TimeoutExpired:
    print(f"command timed out after {sys.argv[1]}s: {' '.join(command)}", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
}

run_dd_apm_at() {
  local bin_directory=""
  local executable="$1"
  local -a environment
  shift

  bin_directory=$(cd "$(dirname "$executable")" && pwd)
  environment=(
    "CI=true"
    "COLUMNS=500"
    "NO_COLOR=1"
    "TERM=dumb"
    "DD_APM_DISABLE_S3=1"
    "DD_TRACE_ENABLED=false"
    "PATH=${bin_directory}:${PATH}"
  )
  if [[ -z "${ANUBIS_TOOLKIT_ROOT:-}" && "$executable" == "$CACHED_DD_APM" ]]; then
    environment+=("ANUBIS_TOOLKIT_ROOT=${TOOLKIT_SOURCE_DIR}")
  fi
  run_with_timeout 30 env "${environment[@]}" "$executable" "$@"
}

run_dd_apm() {
  if [[ -z "$dd_apm_command" ]]; then
    printf 'dd-apm command has not been resolved\n' >&2
    return 127
  fi
  run_dd_apm_at "$dd_apm_command" "$@"
}

dd_apm_version_at() {
  run_dd_apm_at "$1" version 2>&1
}

is_runnable_dd_apm_version() {
  [[ -n "${1//[[:space:]]/}" ]]
}

is_managed_cached_dd_apm() {
  [[ -x "$CACHED_DD_APM" && -f "$CACHED_DD_APM_PROVENANCE" ]] || return 1
  [[ "$(<"$CACHED_DD_APM_PROVENANCE")" == "$TOOLKIT_REVISION" ]]
}

select_existing_dd_apm() {
  local version=""

  dd_apm_command=""
  dd_apm_source=""
  if ! is_managed_cached_dd_apm; then
    return 1
  fi
  version=$(dd_apm_version_at "$CACHED_DD_APM") || return 1
  is_runnable_dd_apm_version "$version" || return 1
  dd_apm_command="$CACHED_DD_APM"
  dd_apm_source="github_cache"
}

ensure_toolkit_source() {
  local actual_revision=""
  local detail=""
  local remote_url=""

  if ! command -v git >/dev/null 2>&1; then
    missing "toolkit_source" "git unavailable; required to fetch ${TOOLKIT_SOURCE_URL}"
    return 1
  fi
  mkdir -p "$TOOLKIT_ROOT"

  if [[ ! -e "$TOOLKIT_SOURCE_DIR" ]]; then
    mkdir "$TOOLKIT_SOURCE_DIR"
    run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
      git -C "$TOOLKIT_SOURCE_DIR" init --quiet || {
      rmdir "$TOOLKIT_SOURCE_DIR" 2>/dev/null || true
      blocked "toolkit_source" "command_failed=git init ${TOOLKIT_SOURCE_DIR}"
      return 1
    }
  elif [[ ! -d "${TOOLKIT_SOURCE_DIR}/.git" ]]; then
    blocked "toolkit_source" "path_exists_without_git=${TOOLKIT_SOURCE_DIR}"
    return 1
  fi

  remote_url=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
    git -C "$TOOLKIT_SOURCE_DIR" remote get-url origin 2>/dev/null || true)
  if [[ -z "$remote_url" ]]; then
    run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
      git -C "$TOOLKIT_SOURCE_DIR" remote add origin "$TOOLKIT_SOURCE_URL" || {
      blocked "toolkit_source" "command_failed=git remote add origin ${TOOLKIT_SOURCE_URL}"
      return 1
    }
  elif [[ "$remote_url" != "$TOOLKIT_SOURCE_URL" ]]; then
    detail="expected_remote=${TOOLKIT_SOURCE_URL} actual_remote=$(summarize_output "$remote_url")"
    blocked "toolkit_source" "$detail"
    return 1
  fi

  actual_revision=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
    git -C "$TOOLKIT_SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)
  if [[ "$actual_revision" != "$TOOLKIT_REVISION" ]]; then
    run_with_timeout "$GIT_INSTALL_TIMEOUT_SECONDS" \
      env GIT_TERMINAL_PROMPT=0 \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=10}" \
      git -C "$TOOLKIT_SOURCE_DIR" fetch --depth 1 origin "$TOOLKIT_REVISION" || {
      blocked "toolkit_source" "command_failed=git fetch ${TOOLKIT_REVISION}"
      return 1
    }
    run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
      git -C "$TOOLKIT_SOURCE_DIR" checkout --detach "$TOOLKIT_REVISION" || {
      blocked "toolkit_source" "command_failed=git checkout ${TOOLKIT_REVISION}"
      return 1
    }
  fi

  actual_revision=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
    git -C "$TOOLKIT_SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)
  if [[ "$actual_revision" != "$TOOLKIT_REVISION" ]]; then
    blocked "toolkit_source" "expected=${TOOLKIT_REVISION} actual=${actual_revision:-unavailable}"
    return 1
  fi
  status "READY" "toolkit_source" "revision=${TOOLKIT_REVISION} path=${TOOLKIT_SOURCE_DIR}"
}

find_install_python() {
  local candidate=""

  for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
      run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" "$candidate" -c \
        'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 15) else 1)'; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

install_dd_apm_from_source() {
  local python_command=""

  python_command=$(find_install_python || true)
  if [[ -z "$python_command" ]]; then
    missing "toolkit_python" "Python 3.11-3.14 is required for toolkit ${TOOLKIT_VERSION}"
    return 1
  fi
  if [[ ! -x "${TOOLKIT_VENV_DIR}/bin/python" ]]; then
    run_with_timeout "$VENV_INSTALL_TIMEOUT_SECONDS" \
      "$python_command" -m venv "$TOOLKIT_VENV_DIR" || {
      blocked "dd_apm_install" "command_failed=${python_command} -m venv ${TOOLKIT_VENV_DIR}"
      return 1
    }
  fi
  run_with_timeout_in "$PIP_INSTALL_TIMEOUT_SECONDS" "$TOOLKIT_SOURCE_DIR" \
    "${TOOLKIT_VENV_DIR}/bin/python" -m pip install \
    --disable-pip-version-check --no-input --retries 0 --timeout 15 . || {
    blocked "dd_apm_install" "command_failed=pip install source=${TOOLKIT_SOURCE_DIR}"
    return 1
  }
  printf '%s\n' "$TOOLKIT_REVISION" >"$CACHED_DD_APM_PROVENANCE"
}

ensure_dd_apm() {
  if select_existing_dd_apm; then
    status "READY" "dd_apm_install" \
      "version=$(summarize_output "$(dd_apm_version_at "$dd_apm_command")") source=${dd_apm_source} selected_from=origin/main revision=${TOOLKIT_REVISION} path=${dd_apm_command}"
    return 0
  fi

  ensure_toolkit_source || return 1
  install_dd_apm_from_source || return 1
  if ! select_existing_dd_apm || [[ "$dd_apm_command" != "$CACHED_DD_APM" ]]; then
    blocked "dd_apm_install" "installed_binary_failed_validation=${CACHED_DD_APM}"
    return 1
  fi
  status "READY" "dd_apm_install" \
    "version=$(summarize_output "$(dd_apm_version_at "$dd_apm_command")") source=${dd_apm_source} selected_from=origin/main revision=${TOOLKIT_REVISION} path=${dd_apm_command}"
}

ensure_dd_auth() {
  local requirement=""
  local version=""

  if command -v dd-auth >/dev/null 2>&1 && \
    version=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" dd-auth --version 2>&1); then
    status "READY" "dd_auth_install" "version=${version}"
    return 0
  fi

  requirement="Bits_base_image_requirement=preinstall supported Linux dd-auth on PATH;"
  requirement+=" no supported non-Appgate Linux installer is documented"
  missing "dd_auth_install" "$requirement"
  return 1
}

config_list() {
  run_dd_apm config list 2>&1
}

configure_target() {
  local configured=""

  configured=$(config_list || true)
  if [[ "$configured" == *"dd_trace_js"* && "$configured" == *"${REPO_ROOT}"* ]]; then
    status "READY" "dd_trace_js_target" "path=${REPO_ROOT}"
    return 0
  fi

  run_dd_apm config add-repo dd_trace_js "$REPO_ROOT" --language node --default >/dev/null || {
    blocked "dd_trace_js_target" "command_failed=dd-apm config add-repo dd_trace_js ${REPO_ROOT}"
    return 1
  }

  configured=$(config_list || true)
  if [[ "$configured" != *"dd_trace_js"* || "$configured" != *"${REPO_ROOT}"* ]]; then
    blocked "dd_trace_js_target" "configured_target_not_discoverable"
    return 1
  fi
  status "READY" "dd_trace_js_target" "path=${REPO_ROOT}"
}

check_dd_apm() {
  local configured=""
  local version=""

  if ! select_existing_dd_apm; then
    missing "dd_apm" "expected=${TOOLKIT_VERSION} run=${REPO_ROOT}/scripts/bits-dd-apm-setup.sh"
    return
  fi
  version=$(dd_apm_version_at "$dd_apm_command" || true)
  if ! is_runnable_dd_apm_version "$version"; then
    blocked "dd_apm" \
      "expected=runnable_dd-apm_version actual=$(summarize_output "${version:-unavailable}")"
    return
  fi
  status "READY" "dd_apm" \
    "version=$(summarize_output "$version") source=${dd_apm_source} selected_from=origin/main revision=${TOOLKIT_REVISION} path=${dd_apm_command}"

  configured=$(config_list || true)
  if [[ "$configured" == *"dd_trace_js"* && "$configured" == *"${REPO_ROOT}"* ]]; then
    status "READY" "dd_trace_js_target" "path=${REPO_ROOT}"
  else
    missing "dd_trace_js_target" "run=${REPO_ROOT}/scripts/bits-dd-apm-setup.sh"
  fi
}

check_auth() {
  local credential_detail=""
  local install_detail=""
  local missing_keys=""
  local probe_exit=0
  local probe_output=""
  local version=""

  if ! command -v dd-auth >/dev/null 2>&1; then
    install_detail="Bits_base_image_requirement=preinstall supported Linux dd-auth on PATH;"
    install_detail+=" no supported non-Appgate Linux installer is documented"
    missing "dd_auth" "$install_detail"
  elif version=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" dd-auth --version 2>&1); then
    status "READY" "dd_auth" "version=${version} domain=${DD_AUTH_DOMAIN}"
  else
    probe_exit=$?
    probe_output="$version"
    blocked "dd_auth" \
      "command_failed=dd-auth --version exit=${probe_exit} detail=$(summarize_output "$probe_output")"
  fi

  [[ -z "${DD_API_KEY:-}" ]] && missing_keys="DD_API_KEY"
  if [[ -z "${DD_APP_KEY:-}" ]]; then
    missing_keys="${missing_keys:+${missing_keys},}DD_APP_KEY"
  fi
  if [[ -z "$missing_keys" ]]; then
    status "READY" "dd_credentials" "source=environment keys=DD_API_KEY,DD_APP_KEY"
  else
    credential_detail="missing=${missing_keys}; Bits must inject secrets or launch this preflight through dd-auth;"
    credential_detail+=" never commit keys"
    missing "dd_credentials" "$credential_detail"
  fi
}

check_codex() {
  local probe_exit=0
  local probe_output=""
  local version=""

  if ! command -v codex >/dev/null 2>&1; then
    missing "codex" "Bits_image_requirement=provide Codex CLI and workspace authentication"
    return
  fi
  if version=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" codex --version 2>&1); then
    :
  else
    probe_exit=$?
    blocked "codex" \
      "command_failed=codex --version exit=${probe_exit} detail=$(summarize_output "$version")"
    return
  fi
  if probe_output=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" codex login status 2>&1); then
    status "READY" "codex" "version=${version:-unknown} login=valid"
  else
    probe_exit=$?
    blocked "codex" \
      "command_failed=codex login status exit=${probe_exit} detail=$(summarize_output "$probe_output")"
  fi
}

check_model_access() {
  local detail=""
  local probe_error_file=""
  local probe_exit=0
  local result_file=""

  if ! command -v codex >/dev/null 2>&1; then
    missing "model_access" "Codex CLI unavailable; cannot run backend model probe"
    return
  fi

  result_file=$(mktemp "${TMPDIR:-/tmp}/bits-codex-model.XXXXXX") || {
    blocked "model_access" "could_not_create_probe_output"
    return
  }
  probe_error_file=$(mktemp "${TMPDIR:-/tmp}/bits-codex-model-error.XXXXXX") || {
    rm -f "$result_file"
    blocked "model_access" "could_not_create_probe_error_output"
    return
  }
  if [[ -n "${BITS_CODEX_MODEL:-}" ]]; then
    run_with_timeout "$MODEL_PROBE_TIMEOUT_SECONDS" codex exec --ephemeral --ignore-rules --sandbox read-only \
      --skip-git-repo-check --model "${BITS_CODEX_MODEL}" --output-last-message "$result_file" \
      "Reply with exactly BITS_MODEL_OK and nothing else." >/dev/null 2>"$probe_error_file" || probe_exit=$?
  else
    run_with_timeout "$MODEL_PROBE_TIMEOUT_SECONDS" codex exec --ephemeral --ignore-rules --sandbox read-only \
      --skip-git-repo-check --output-last-message "$result_file" \
      "Reply with exactly BITS_MODEL_OK and nothing else." >/dev/null 2>"$probe_error_file" || probe_exit=$?
  fi
  if ((probe_exit == 0)) && grep -qx 'BITS_MODEL_OK' "$result_file"; then
    status "READY" "model_access" "model=${BITS_CODEX_MODEL:-configured-default} probe=passed"
  else
    detail="model=${BITS_CODEX_MODEL:-configured-default} codex_exec_exit=${probe_exit}"
    detail+=" detail=$(summarize_output "$(<"$probe_error_file")")"
    blocked "model_access" "$detail"
  fi
  rm -f "$result_file" "$probe_error_file"
}

check_trajectory() {
  local probe_exit=0
  local probe_output=""
  local version=""

  if ! command -v trajectory >/dev/null 2>&1; then
    missing "trajectory" "Bits_image_requirement=provide Trajectory CLI and configuration"
    return
  fi
  if version=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" trajectory version 2>&1); then
    version=$(summarize_output "$version")
  else
    probe_exit=$?
    blocked "trajectory" \
      "command_failed=trajectory version exit=${probe_exit} detail=$(summarize_output "$version")"
    return
  fi
  if probe_output=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" trajectory status 2>&1); then
    status "READY" "trajectory" "version=${version:-unknown} status=available"
  else
    probe_exit=$?
    blocked "trajectory" \
      "command_failed=trajectory status exit=${probe_exit} detail=$(summarize_output "$probe_output")"
  fi
}

find_container_runtime() {
  if command -v docker >/dev/null 2>&1; then
    printf 'docker'
  elif command -v podman >/dev/null 2>&1; then
    printf 'podman'
  fi
}

check_image() {
  local detail=""
  local image="$1"
  local label="$2"
  local probe_exit=0
  local probe_output=""

  if probe_output=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" \
    "$container_runtime" image inspect "$image" 2>&1); then
    status "READY" "$label" "image=${image} source=preloaded_or_cached"
    return 0
  else
    probe_exit=$?
  fi
  detail="image=${image} unavailable=true exit=${probe_exit} detail=$(summarize_output "$probe_output");"
  detail+=" preload an approved OCI archive or use toolkit GitLab CI"
  blocked "$label" "$detail"
  return 1
}

check_containers() {
  local detail=""
  local probe_exit=0
  local probe_output=""

  container_runtime=$(find_container_runtime)
  if [[ -z "$container_runtime" ]]; then
    missing "container_runtime" "Bits_image_requirement=provide Docker or Podman with a usable daemon/socket"
    detail="runtime_unavailable=true; preload ${DATADOG_AGENT_IMAGE} and ${TEST_AGENT_IMAGE},"
    detail+=" or use toolkit GitLab CI"
    blocked "required_images" "$detail"
    return
  fi
  if probe_output=$(run_with_timeout "$LOCAL_PROBE_TIMEOUT_SECONDS" "$container_runtime" info 2>&1); then
    status "READY" "container_runtime" "runtime=${container_runtime}"
  else
    probe_exit=$?
    detail="runtime=${container_runtime} daemon_or_socket_unavailable=true exit=${probe_exit}"
    detail+=" detail=$(summarize_output "$probe_output")"
    blocked "container_runtime" "$detail"
    blocked "required_images" "runtime_unavailable=true; preload required images or use toolkit GitLab CI"
    return
  fi

  if check_image "$DATADOG_AGENT_IMAGE" "datadog_agent_image"; then
    datadog_agent_image_ready=true
  fi
  if check_image "$TEST_AGENT_IMAGE" "test_agent_image"; then
    test_agent_image_ready=true
  fi
}

http_code() {
  curl --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 \
    --write-out '%{http_code}' "$1"
}

check_registry() {
  local code=""
  local detail=""
  local image_ready="$1"
  local label="$2"
  local probe_exit=0
  local url="$3"

  if command -v curl >/dev/null 2>&1; then
    code=$(http_code "$url") || probe_exit=$?
  else
    probe_exit=127
  fi
  if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
    status "READY" "$label" "url=${url} http=${code}"
  elif [[ "$image_ready" == "true" ]]; then
    status "READY" "$label" \
      "external_registry_unreachable=true curl_exit=${probe_exit} required_image_preloaded=true"
  else
    detail="external_registry_unreachable=true curl_exit=${probe_exit} image_not_preloaded=true;"
    detail+=" preload approved image or use toolkit GitLab CI"
    blocked "$label" "$detail"
  fi
}

check_registries() {
  check_registry "$datadog_agent_image_ready" "gcr_registry" "https://gcr.io/v2/"
  check_registry "$test_agent_image_ready" "ghcr_registry" "https://ghcr.io/v2/"
}

check_backend() {
  local backend_code=""
  local backend_url="https://api.${DD_SITE:-datadoghq.com}/api/v1/validate"
  local probe_exit=0

  if ! command -v curl >/dev/null 2>&1; then
    missing "backend_network" "curl unavailable; cannot reach ${backend_url}"
    missing "backend_access" "validation_not_run=true"
    return
  fi

  if [[ -n "${DD_API_KEY:-}" ]]; then
    backend_code=$(curl --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 \
      --header "DD-API-KEY: ${DD_API_KEY}" --write-out '%{http_code}' "$backend_url") || probe_exit=$?
  else
    backend_code=$(http_code "$backend_url") || probe_exit=$?
  fi

  if [[ "$backend_code" =~ ^[1-5][0-9][0-9]$ ]]; then
    status "READY" "backend_network" "host=api.${DD_SITE:-datadoghq.com} http=${backend_code}"
  else
    blocked "backend_network" \
      "host=api.${DD_SITE:-datadoghq.com} unreachable=true curl_exit=${probe_exit}"
    blocked "backend_access" "validation_not_run=true"
    return
  fi

  if [[ -z "${DD_API_KEY:-}" || -z "${DD_APP_KEY:-}" ]]; then
    missing "backend_access" "DD_API_KEY and DD_APP_KEY are required for validation"
  elif [[ "$backend_code" == "200" ]]; then
    status "READY" "backend_access" "api_key_validation_http=200 app_key=present"
  else
    blocked "backend_access" "credential_validation_http=${backend_code}"
  fi
}

preflight() {
  failures=0
  status "READY" "checkout" "path=${REPO_ROOT}"
  check_dd_apm
  check_auth
  check_codex
  check_trajectory
  check_containers
  check_registries
  check_backend
  check_model_access

  if ((failures > 0)); then
    status "BLOCKED" "summary" "failures=${failures}"
    return 1
  fi
  status "READY" "summary" "failures=0"
}

setup() {
  if ! ensure_dd_apm; then
    status "BLOCKED" "summary" "setup_cannot_continue_without_dd-apm"
    return 1
  fi
  ensure_dd_auth || true
  configure_target || true
  preflight
}

case "${1:-preflight}" in
  setup)
    setup
    ;;
  preflight)
    preflight
    ;;
  *)
    printf 'Usage: %s [setup|preflight]\n' "$0" >&2
    exit 2
    ;;
esac
