import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileAsync = promisify(execFile)
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.dirname(scriptDirectory)
const setupScript = path.join(scriptDirectory, 'bits-dd-apm-setup.sh')
const preflightScript = path.join(scriptDirectory, 'bits-dd-apm-preflight.sh')
const toolkitRevision = '5bb7951901123f3b26ba882ddf4d2bc97155256e'

async function addCommand (binDirectory, name, body) {
  const command = path.join(binDirectory, name)
  await writeFile(command, `#!/bin/sh\nset -eu\n${body}\n`)
  await chmod(command, 0o755)
}

function ddApmBody (root, version = 'dev-main', versionExit = 0) {
  const redirect = versionExit === 0 ? '' : ' >&2'
  return `
case "\${1:-}" in
  version) echo '${version}'${redirect}; exit ${versionExit} ;;
  config)
    case "\${2:-}" in
      list)
        if [ -f "${root}/configured" ]; then cat "${root}/configured"; else exit 1; fi
        ;;
      add-repo)
        printf '%s %s\n' "\$3" "\$4" > "${root}/configured"
        printf 'add-repo\n' >> "${root}/dd-apm-calls"
        ;;
    esac
    ;;
esac`
}

async function createFixture ({
  existingDdApm = true,
  existingVersion = 'dev-path',
  existingVersionExit = 0,
  pipSucceeds = true,
  registriesReachable = true,
  runtime = 'docker'
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bits-dd-apm-test-'))
  const binDirectory = path.join(root, 'bin')
  const cacheDirectory = path.join(root, 'cache')
  const homeDirectory = path.join(root, 'home')
  const toolRoot = path.join(cacheDirectory, 'dd-apm-bits', toolkitRevision)
  const cachedDdApm = path.join(toolRoot, 'venv', 'bin', 'dd-apm')
  const installedTemplate = path.join(root, 'installed-dd-apm-template')
  const venvPythonTemplate = path.join(root, 'venv-python-template')
  await mkdir(binDirectory, { recursive: true })
  await mkdir(homeDirectory, { recursive: true })
  if (existingDdApm) {
    await mkdir(path.join(toolRoot, 'source', '.claude', 'skills'), { recursive: true })
  }

  if (existingDdApm) {
    await addCommand(binDirectory, 'dd-apm', ddApmBody(root, existingVersion, existingVersionExit))
  }
  await addCommand(root, 'installed-dd-apm-template', ddApmBody(root))
  await addCommand(root, 'venv-python-template', `
if [ "\${1:-}" = '-m' ] && [ "\${2:-}" = 'pip' ]; then
  printf '%s\n' "\$*" >> "${root}/pip-calls"
  if [ '${pipSucceeds ? 'yes' : 'no'}' != 'yes' ]; then exit 1; fi
  cp "${installedTemplate}" "${cachedDdApm}"
  chmod +x "${cachedDdApm}"
  exit 0
fi
exit 1`)
  await addCommand(binDirectory, 'python3.11', `
if [ "\${1:-}" = '-c' ]; then exit 0; fi
if [ "\${1:-}" = '-m' ] && [ "\${2:-}" = 'venv' ]; then
  mkdir -p "\$3/bin"
  cp "${venvPythonTemplate}" "\$3/bin/python"
  chmod +x "\$3/bin/python"
  printf '%s\n' "\$*" >> "${root}/venv-calls"
  exit 0
fi
exit 1`)
  await addCommand(binDirectory, 'dd-auth', `
if [ "\${1:-}" = '--version' ]; then echo 'dd-auth version 1.3.6'; fi`)
  await addCommand(binDirectory, 'codex', `
if [ "\${1:-}" = '--version' ]; then echo 'codex-cli 1.0.0'; exit 0; fi
if [ "\${1:-}" = 'login' ]; then exit 0; fi
if [ "\${1:-}" = 'exec' ]; then
  while [ "\$#" -gt 0 ]; do
    if [ "\$1" = '--output-last-message' ]; then
      shift
      printf 'BITS_MODEL_OK\n' > "\$1"
      exit 0
    fi
    shift
  done
fi
exit 1`)
  await addCommand(binDirectory, 'trajectory', `
if [ "\${1:-}" = 'version' ]; then echo 'trajectory 1.0.0'; exit 0; fi
if [ "\${1:-}" = 'status' ]; then exit 0; fi
exit 1`)
  await addCommand(binDirectory, runtime, `
if [ "\${1:-}" = 'info' ]; then exit 0; fi
if [ "\${1:-}" = 'image' ] && [ "\${2:-}" = 'inspect' ]; then exit 0; fi
exit 1`)
  await addCommand(binDirectory, 'curl', `
for argument in "\$@"; do
  case "\$argument" in
    https://api.*) printf '200'; exit 0 ;;
  esac
done
${registriesReachable ? "printf '401'" : 'exit 6'}`)

  return {
    cachedDdApm,
    root,
    env: {
      ...process.env,
      DD_API_KEY: 'test-api-key',
      DD_APP_KEY: 'test-app-key',
      HOME: homeDirectory,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      TMPDIR: root,
      XDG_CACHE_HOME: cacheDirectory
    }
  }
}

async function run (script, env) {
  try {
    const result = await execFileAsync(script, { env })
    return { ...result, code: 0 }
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code }
  }
}

async function assertFileMissing (file) {
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
}

describe('Bits dd-apm bootstrap', () => {
  let fixture

  afterEach(async () => {
    if (fixture) await rm(fixture.root, { force: true, recursive: true })
    fixture = undefined
  })

  it('prefers a matching dd-apm on PATH and configures the checkout once', async () => {
    fixture = await createFixture()

    const first = await run(setupScript, fixture.env)
    const second = await run(setupScript, fixture.env)

    assert.equal(first.code, 0, first.stdout + first.stderr)
    assert.equal(second.code, 0, second.stdout + second.stderr)
    assert.match(first.stdout, new RegExp(`READY\\s+dd_apm_install\\s+version=dev-main source=embedded_cache.*revision=${toolkitRevision}`))
    assert.doesNotMatch(first.stdout, /source=path|1\.2\.0rc6|57bc59088efe4c0e5b4849ff6fae10d1d3e6a3d7/)
    assert.equal(await readFile(path.join(fixture.root, 'dd-apm-calls'), 'utf8'), 'add-repo\n')
    await assertFileMissing(path.join(fixture.root, 'git-calls'))
    await assertFileMissing(path.join(fixture.root, 'pip-calls'))
  })

  it('installs from the pinned GitHub source once and reuses the cached venv', async () => {
    fixture = await createFixture({ existingDdApm: false })

    const first = await run(setupScript, fixture.env)
    const second = await run(setupScript, fixture.env)

    assert.equal(first.code, 0, first.stdout + first.stderr)
    assert.equal(second.code, 0, second.stdout + second.stderr)
    assert.match(first.stdout, new RegExp(`READY\\s+toolkit_source\\s+revision=${toolkitRevision}`))
    assert.match(first.stdout, new RegExp(`READY\\s+dd_apm_install\\s+version=dev-main source=embedded_cache.*revision=${toolkitRevision}`))
    assert.match(second.stdout, new RegExp(`READY\\s+dd_apm_install\\s+version=dev-main source=embedded_cache.*revision=${toolkitRevision}`))
    assert.equal((await readFile(path.join(fixture.root, 'venv-calls'), 'utf8')).split('\n').length, 2)
    assert.equal((await readFile(path.join(fixture.root, 'pip-calls'), 'utf8')).split('\n').length, 2)
    assert.equal(await readFile(path.join(fixture.root, 'dd-apm-calls'), 'utf8'), 'add-repo\n')
    await assertFileMissing(path.join(fixture.root, 'git-calls'))
    assert.match(first.stdout, /archive_sha256=d3ba54b12ab3b8b1cf67897d4991724acb290cd99598ebe4eabb8ca2d5a3fcf/)
  })

  it('falls back to the pinned source when the PATH candidate cannot be validated', async () => {
    fixture = await createFixture({ existingVersion: 'version probe failed', existingVersionExit: 1 })

    const result = await run(setupScript, fixture.env)

    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, new RegExp(`READY\\s+dd_apm_install\\s+version=dev-main source=embedded_cache.*revision=${toolkitRevision}`))
    assert.match(await readFile(path.join(fixture.root, 'pip-calls'), 'utf8'), /pip install/)
  })

  it('rejects an unowned PATH dd-apm even when its version probe succeeds', async () => {
    fixture = await createFixture({ existingVersion: 'dev-main' })

    const result = await run(preflightScript, fixture.env)

    assert.equal(result.code, 1)
    assert.match(result.stdout, /MISSING\s+dd_apm\s/)
    assert.doesNotMatch(result.stdout, /source=path/)
  })

  it('reports a bounded source installation failure without configuring the checkout', async () => {
    fixture = await createFixture({ existingDdApm: false, pipSucceeds: false })

    const result = await run(setupScript, fixture.env)

    assert.equal(result.code, 1)
    assert.match(result.stdout, /BLOCKED\s+dd_apm_install\s+command_failed=pip install/)
    assert.match(result.stdout, /BLOCKED\s+summary\s+setup_cannot_continue_without_dd-apm/)
    await assertFileMissing(path.join(fixture.root, 'dd-apm-calls'))
  })

  it('reports each missing Bits capability without attempting auth', async () => {
    fixture = await createFixture()
    const emptyBin = path.join(fixture.root, 'empty-bin')
    await mkdir(emptyBin)
    await addCommand(emptyBin, 'curl', 'exit 6')

    const result = await run(preflightScript, {
      HOME: fixture.env.HOME,
      PATH: `${emptyBin}:/usr/bin:/bin`,
      TMPDIR: fixture.root,
      XDG_CACHE_HOME: fixture.env.XDG_CACHE_HOME
    })

    assert.equal(result.code, 1)
    for (const label of [
      'dd_apm',
      'dd_auth',
      'dd_credentials',
      'codex',
      'trajectory',
      'container_runtime',
      'gcr_registry',
      'ghcr_registry',
      'backend_access',
      'model_access'
    ]) {
      assert.match(result.stdout, new RegExp(`(?:MISSING|BLOCKED)\\s+${label}\\s`))
    }
    assert.match(result.stdout, /Bits_base_image_requirement=preinstall supported Linux dd-auth/)
    assert.doesNotMatch(result.stdout + result.stderr, /test-api-key|test-app-key/)
  })

  it('accepts preloaded Podman images when external registries are blocked', async () => {
    fixture = await createFixture({ registriesReachable: false, runtime: 'podman' })
    await run(setupScript, fixture.env)

    const result = await run(preflightScript, fixture.env)

    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /READY\s+container_runtime\s+runtime=podman/)
    const preloadedRegistry = 'external_registry_unreachable=true curl_exit=6 required_image_preloaded=true'
    assert.match(result.stdout, new RegExp(`READY\\s+gcr_registry\\s+${preloadedRegistry}`))
    assert.match(result.stdout, new RegExp(`READY\\s+ghcr_registry\\s+${preloadedRegistry}`))
  })
})
