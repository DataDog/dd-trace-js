'use strict'

const { promisify } = require('util')
const childProcess = require('child_process')
const { fork, spawn } = childProcess
const exec = promisify(childProcess.exec)
const http = require('http')
const fs = require('fs')
const { builtinModules } = require('module')
const os = require('os')
const path = require('path')
const assert = require('assert')
const crypto = require('crypto')
const rimraf = promisify(require('rimraf'))
const FakeAgent = require('./fake-agent')
const { version } = require('../../package.json')
const { getCappedRange } = require('../../packages/dd-trace/test/plugins/versions')

// Cache for packed packages
const CACHE_DIR = path.join(os.tmpdir(), 'dd-trace-sandbox-cache')

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
}

/**
 * Generate a cache key for the current package state
 */
function generateCacheKey () {
  const packageJsonPath = path.join(__dirname, '../../package.json')
  const packageJson = fs.readFileSync(packageJsonPath, 'utf8')
  const packageHash = crypto.createHash('md5').update(packageJson).digest('hex')
  return `dd-trace-${version}-${packageHash}.tgz`
}

/**
 * Get cached package or create new one
 */
async function getCachedPackage (env) {
  const cacheKey = generateCacheKey()
  const cachedPath = path.join(CACHE_DIR, cacheKey)

  if (fs.existsSync(cachedPath)) {
    return cachedPath
  }

  // Create new package
  await exec(`npm pack --silent --pack-destination ${CACHE_DIR}`, { env })

  // Rename to include hash for cache invalidation
  const tempPath = path.join(CACHE_DIR, `dd-trace-${version}.tgz`)
  if (fs.existsSync(tempPath)) {
    fs.renameSync(tempPath, cachedPath)
  }

  return cachedPath
}

const hookFile = 'dd-trace/loader-hook.mjs'

// This is set by the setShouldKill function
let shouldKill

async function runAndCheckOutput (filename, cwd, expectedOut, expectedSource) {
  const proc = spawn(process.execPath, [filename], { cwd, stdio: 'pipe' })
  const pid = proc.pid
  let out = await new Promise((resolve, reject) => {
    proc.on('error', reject)
    let out = Buffer.alloc(0)
    proc.stdout.on('data', data => {
      out = Buffer.concat([out, data])
    })
    proc.stderr.pipe(process.stdout)
    proc.on('exit', () => resolve(out.toString('utf8')))
    if (shouldKill) {
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill()
      }, 1000) // TODO this introduces flakiness. find a better way to end the process.
    }
  })
  if (typeof expectedOut === 'function') {
    expectedOut(out)
  } else {
    if (process.env.DD_TRACE_DEBUG) {
      // Debug adds this, which we don't care about in these tests
      out = out.replace('Flushing 0 metrics via HTTP\n', '')
    }
    assert.match(out, new RegExp(expectedOut), `output "${out} does not contain expected output "${expectedOut}"`)
  }

  if (expectedSource) {
    assert.match(out, new RegExp(`instrumentation source: ${expectedSource}`),
    `Expected the process to output "${expectedSource}", but logs only contain: "${out}"`)
  }
  return pid
}

// This is set by the useSandbox function
let sandbox

// This _must_ be used with the useSandbox function
async function runAndCheckWithTelemetry (filename, expectedOut, expectedTelemetryPoints, expectedSource) {
  const cwd = sandbox.folder
  const cleanup = telemetryForwarder(expectedTelemetryPoints.length > 0)
  const pid = await runAndCheckOutput(filename, cwd, expectedOut, expectedSource)
  const msgs = await cleanup()
  if (expectedTelemetryPoints.length === 0) {
    // assert no telemetry sent
    assert.strictEqual(msgs.length, 0, `Expected no telemetry, but got:\n${
      msgs.map(msg => JSON.stringify(msg[1].points)).join('\n')
    }`)
  } else {
    assertTelemetryPoints(pid, msgs, expectedTelemetryPoints)
  }
}

function assertTelemetryPoints (pid, msgs, expectedTelemetryPoints) {
  let points = []
  for (const [telemetryType, data] of msgs) {
    assert.strictEqual(telemetryType, 'library_entrypoint')
    assertMetadata(data.metadata, pid)
    points = points.concat(data.points)
  }
  const expectedPoints = getPoints(...expectedTelemetryPoints)
  // Sort since data can come in in any order.
  assert.deepStrictEqual(points.sort(pointsSorter), expectedPoints.sort(pointsSorter))

  function pointsSorter (a, b) {
    a = a.name + '\t' + a.tags.join(',')
    b = b.name + '\t' + b.tags.join(',')
    return a === b ? 0 : a < b ? -1 : 1
  }

  function getPoints (...args) {
    const expectedPoints = []
    let currentPoint = {}
    for (const arg of args) {
      if (!currentPoint.name) {
        currentPoint.name = 'library_entrypoint.' + arg
      } else {
        currentPoint.tags = arg.split(',').filter(Boolean)
        expectedPoints.push(currentPoint)
        currentPoint = {}
      }
    }
    return expectedPoints
  }

  function assertMetadata (actualMetadata, pid) {
    const expectedBasicMetadata = {
      language_name: 'nodejs',
      language_version: process.versions.node,
      runtime_name: 'nodejs',
      runtime_version: process.versions.node,
      tracer_version: require('../../package.json').version,
      pid: Number(pid)
    }

    // Validate basic metadata
    for (const key of Object.keys(expectedBasicMetadata)) {
      assert.strictEqual(actualMetadata[key], expectedBasicMetadata[key])
    }

    // Validate result metadata is present and has valid values
    assert(actualMetadata.result, 'result field should be present')
    assert(actualMetadata.result_class, 'result_class field should be present')
    assert(actualMetadata.result_reason, 'result_reason field should be present')

    // Check that result metadata has expected values for telemetry scenarios
    const validResults = ['success', 'abort', 'error', 'unknown']
    const validResultClasses = ['success', 'incompatible_runtime', 'incompatible_library', 'internal_error', 'unknown']

    assert(validResults.includes(actualMetadata.result), `Invalid result: ${actualMetadata.result}`)
    assert(validResultClasses.includes(actualMetadata.result_class),
      `Invalid result_class: ${actualMetadata.result_class}`)
    assert(typeof actualMetadata.result_reason === 'string', 'result_reason should be a string')
  }
}

/**
 * Spawns a Node.js script in a child process and returns a promise that resolves when the process is ready.
 *
 * @param {string|URL} filename - The filename of the Node.js script to spawn in a child process.
 * @param {childProcess.ForkOptions} [options] - The options to pass to the child process.
 * @param {(data: Buffer) => void} [stdioHandler] - A function that's called with one data argument to handle the
 *   standard output of the child process. If not provided, the output will be logged to the console.
 * @param {(data: Buffer) => void} [stderrHandler] - A function that's called with one data argument to handle the
 *   standard error of the child process. If not provided, the error will be logged to the console.
 * @returns {Promise<childProcess.ChildProcess & { url?: string }|undefined>} A promise that resolves when the process
 *   is either ready or terminated without an error. If the process is terminated without an error, the promise will
 *   resolve with `undefined`.The returned process will have a `url` property if the process didn't terminate.
 */
function spawnProc (filename, options = {}, stdioHandler, stderrHandler) {
  const proc = fork(filename, { ...options, stdio: 'pipe' })

  return new Promise((resolve, reject) => {
    proc
      .on('message', ({ port }) => {
        if (typeof port !== 'number' && typeof port !== 'string') {
          return reject(new Error(`${filename} sent invalid port: ${port}. Expected a number or string.`))
        }
        proc.url = `http://localhost:${port}`
        resolve(proc)
      })
      .on('error', reject)
      .on('exit', code => {
        if (code !== 0) {
          return reject(new Error(`Process exited with status code ${code}.`))
        }
        resolve()
      })

    proc.stdout.on('data', data => {
      if (stdioHandler) {
        stdioHandler(data)
      }
      // eslint-disable-next-line no-console
      if (!options.silent) console.log(data.toString())
    })

    proc.stderr.on('data', data => {
      if (stderrHandler) {
        stderrHandler(data)
      }
      // eslint-disable-next-line no-console
      if (!options.silent) console.error(data.toString())
    })
  })
}

async function createSandbox (dependencies = [], isGitRepo = false,
  integrationTestsPaths = ['./integration-tests/*'], followUpCommand) {
  const cappedDependencies = dependencies.map(dep => {
    if (builtinModules.includes(dep)) return dep

    const match = dep.replaceAll(/['"]/g, '').match(/^(@?[^@]+)(@(.+))?$/)
    const name = match[1]
    const range = match[3] || ''
    const cappedRange = getCappedRange(name, range)

    return `"${name}@${cappedRange}"`
  })

  // We might use NODE_OPTIONS to init the tracer. We don't want this to affect this operations
  const { NODE_OPTIONS, ...restOfEnv } = process.env
  const noSandbox = String(process.env.TESTING_NO_INTEGRATION_SANDBOX)
  if (noSandbox === '1' || noSandbox.toLowerCase() === 'true') {
    // Execute integration tests without a sandbox. This is useful when you have other components
    // yarn-linked into dd-trace and want to run the integration tests against them.

    // Link dd-trace to itself, then...
    await exec('yarn link')
    await exec('yarn link dd-trace')
    // ... run the tests in the current directory.
    return { folder: path.join(process.cwd(), 'integration-tests'), remove: async () => {} }
  }

  // CI-specific optimizations: Use pre-installed dependencies when possible
  const isCI = process.env.CI || process.env.GITLAB_CI || process.env.GITHUB_ACTIONS
  if (isCI && process.env.CI_PREINSTALLED_DEPS === '1') {
    // In CI with pre-installed deps, create minimal sandbox
    const folder = path.join(os.tmpdir(), `dd-trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
    fs.mkdirSync(folder, { recursive: true })

    // Copy test files only
    for (const testPath of integrationTestsPaths) {
      if (process.platform === 'win32') {
        await exec(`Copy-Item -Recurse -Path "${testPath}" -Destination "${folder}"`, { shell: 'powershell.exe' })
      } else {
        await exec(`cp -R ${testPath} ${folder}`)
      }
    }

    return { folder, remove: async () => rimraf(folder) }
  }

  const folder = path.join(os.tmpdir(), `dd-trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
  fs.mkdirSync(folder, { recursive: true })

  // Get cached package or create new one
  const cachedPackagePath = await getCachedPackage(restOfEnv)
  const allDependencies = [`file:${cachedPackagePath}`].concat(cappedDependencies)

  // Parallel operations for better performance

  // 1. Copy test files in parallel with package installation
  const copyOperations = integrationTestsPaths.map(testPath => {
    if (process.platform === 'win32') {
      return exec(`Copy-Item -Recurse -Path "${testPath}" -Destination "${folder}"`, { shell: 'powershell.exe' })
    } else {
      return exec(`cp -R ${testPath} ${folder}`)
    }
  })

  // 2. Install packages with optimizations
  const preferOfflineFlag = process.env.OFFLINE === '1' || process.env.OFFLINE === 'true' ? ' --prefer-offline' : ''

  // CI-specific optimizations for package installation
  const ciFlags = isCI ? ' --frozen-lockfile --prefer-offline --silent' : ' --silent'
  const addCommand = `yarn add ${allDependencies.join(' ')} --ignore-engines${preferOfflineFlag}${ciFlags}`
  const addOptions = { cwd: folder, env: restOfEnv }

  // Execute package installation and file copying in parallel
  const packageInstallPromise = exec(addCommand, addOptions).catch(async (e) => {
    // Retry once on failure
    // eslint-disable-next-line no-console
    console.warn('Package installation failed, retrying...', e.message)
    return exec(addCommand, addOptions)
  })

  // Wait for all operations to complete
  await Promise.all([packageInstallPromise, ...copyOperations])

  // Skip filesystem sync in CI environments (it's often unnecessary and slow)
  if (!process.env.CI && !process.env.GITLAB_CI && !process.env.GITHUB_ACTIONS) {
    if (process.platform === 'win32') {
      await exec(`Write-VolumeCache ${folder[0]}`, { shell: 'powershell.exe' })
    } else {
      await exec(`sync ${folder}`)
    }
  }

  if (followUpCommand) {
    await exec(followUpCommand, { cwd: folder, env: restOfEnv })
  }

  if (isGitRepo) {
    await setupGitRepo(folder)
  }

  return {
    folder,
    remove: async () => rimraf(folder)
  }
}

/**
 * Setup git repository for testing
 */
async function setupGitRepo (folder) {
  const gitOperations = [
    exec('git init', { cwd: folder }),
    exec('git config user.email "john@doe.com"', { cwd: folder }),
    exec('git config user.name "John Doe"', { cwd: folder }),
    exec('git config commit.gpgsign false', { cwd: folder })
  ]

  await Promise.all(gitOperations)

  fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/', { flush: true })

  const localRemotePath = path.join(folder, '..', `${path.basename(folder)}-remote.git`)
  if (!fs.existsSync(localRemotePath)) {
    await exec(`git init --bare ${localRemotePath}`)
  }

  await exec('git add -A', { cwd: folder })
  await exec('git commit -m "first commit" --no-verify', { cwd: folder })
  await exec(`git remote add origin ${localRemotePath}`, { cwd: folder })
  await exec('git push --set-upstream origin HEAD', { cwd: folder })
}

function telemetryForwarder (shouldExpectTelemetryPoints = true) {
  process.env.DD_TELEMETRY_FORWARDER_PATH =
    path.join(__dirname, '..', 'telemetry-forwarder.sh')
  process.env.FORWARDER_OUT = path.join(__dirname, `forwarder-${Date.now()}.out`)

  let retries = 0

  const tryAgain = async function () {
    retries += 1
    await new Promise(resolve => setTimeout(resolve, 100))
    return cleanup()
  }

  const cleanup = function () {
    let msgs
    try {
      msgs = fs.readFileSync(process.env.FORWARDER_OUT, 'utf8').trim().split('\n')
    } catch (e) {
      if (shouldExpectTelemetryPoints && e.code === 'ENOENT' && retries < 10) {
        return tryAgain()
      }
      return []
    }
    for (let i = 0; i < msgs.length; i++) {
      const [telemetryType, data] = msgs[i].split('\t')
      if (!data && retries < 10) {
        return tryAgain()
      }
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch (e) {
        if (!data && retries < 10) {
          return tryAgain()
        }
        throw new SyntaxError(`error parsing data: ${e.message}\n${data}`)
      }
      msgs[i] = [telemetryType, parsed]
    }
    fs.unlinkSync(process.env.FORWARDER_OUT)
    delete process.env.FORWARDER_OUT
    delete process.env.DD_TELEMETRY_FORWARDER_PATH
    return msgs
  }

  return cleanup
}

async function curl (url) {
  if (url !== null && typeof url === 'object') {
    if (url.then) {
      return curl(await url)
    }
    url = url.url
  }

  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const bufs = []
      res.on('data', d => bufs.push(d))
      res.on('end', () => {
        res.body = Buffer.concat(bufs).toString('utf8')
        resolve(res)
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function curlAndAssertMessage (agent, procOrUrl, fn, timeout, expectedMessageCount, resolveAtFirstSuccess) {
  const resultPromise = agent.assertMessageReceived(fn, timeout, expectedMessageCount, resolveAtFirstSuccess)
  await curl(procOrUrl)
  return resultPromise
}

function getCiVisAgentlessConfig (port) {
  // We remove GITHUB_WORKSPACE so the repository root is not assigned to dd-trace-js
  // We remove MOCHA_OPTIONS so the test runner doesn't run the tests twice
  const { GITHUB_WORKSPACE, MOCHA_OPTIONS, ...rest } = process.env
  return {
    ...rest,
    DD_API_KEY: '1',
    DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
    DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${port}`,
    NODE_OPTIONS: '-r dd-trace/ci/init',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false'
  }
}

function getCiVisEvpProxyConfig (port) {
  // We remove GITHUB_WORKSPACE so the repository root is not assigned to dd-trace-js
  // We remove MOCHA_OPTIONS so the test runner doesn't run the tests twice
  const { GITHUB_WORKSPACE, MOCHA_OPTIONS, ...rest } = process.env
  return {
    ...rest,
    DD_TRACE_AGENT_PORT: port,
    NODE_OPTIONS: '-r dd-trace/ci/init',
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false'
  }
}

function checkSpansForServiceName (spans, name) {
  return spans.some((span) => span.some((nestedSpan) => nestedSpan.name === name))
}

async function spawnPluginIntegrationTestProc (cwd, serverFile, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort
  }
  env = { ...process.env, ...env, ...additionalEnvArgs }
  return spawnProc(path.join(cwd, serverFile), {
    cwd,
    env
  }, stdioHandler)
}

function useEnv (env) {
  before(() => {
    Object.assign(process.env, env)
  })
  after(() => {
    for (const key of Object.keys(env)) {
      delete process.env[key]
    }
  })
}

function useSandbox (...args) {
  before(async () => {
    sandbox = await createSandbox(...args)
  })
  after(() => {
    const oldSandbox = sandbox
    sandbox = undefined
    return oldSandbox.remove()
  })
}

function sandboxCwd () {
  return sandbox.folder
}

function setShouldKill (value) {
  before(() => {
    shouldKill = value
  })
  after(() => {
    shouldKill = true
  })
}

const assertObjectContains = assert.partialDeepStrictEqual || function assertObjectContains (actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected array but got ${typeof actual}`)
    let startIndex = 0
    for (const expectedItem of expected) {
      let found = false
      for (let i = startIndex; i < actual.length; i++) {
        const actualItem = actual[i]
        try {
          if (expectedItem !== null && typeof expectedItem === 'object') {
            assertObjectContains(actualItem, expectedItem)
          } else {
            assert.strictEqual(actualItem, expectedItem)
          }
          startIndex = i + 1
          found = true
          break
        } catch {
          continue
        }
      }
      assert.ok(found, `Expected array to contain ${JSON.stringify(expectedItem)}`)
    }
    return
  }

  for (const [key, val] of Object.entries(expected)) {
    if (val !== null && typeof val === 'object') {
      assert.ok(Object.hasOwn(actual, key))
      assert.notStrictEqual(actual[key], null)
      assert.strictEqual(typeof actual[key], 'object')
      assertObjectContains(actual[key], val)
    } else {
      assert.strictEqual(actual[key], expected[key])
    }
  }
}

function assertUUID (actual, msg = 'not a valid UUID') {
  assert.match(actual, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/, msg)
}

/**
 * Clean up old cache entries (call this periodically)
 */
async function cleanupCache (maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
  if (!fs.existsSync(CACHE_DIR)) return

  const files = fs.readdirSync(CACHE_DIR)
  const now = Date.now()

  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file)
    const stats = fs.statSync(filePath)

    if (now - stats.mtime.getTime() > maxAge) {
      await rimraf(filePath)
    }
  }
}

module.exports = {
  FakeAgent,
  hookFile,
  assertObjectContains,
  assertUUID,
  spawnProc,
  telemetryForwarder,
  assertTelemetryPoints,
  runAndCheckWithTelemetry,
  createSandbox,
  curl,
  curlAndAssertMessage,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  useEnv,
  useSandbox,
  sandboxCwd,
  setShouldKill,
  cleanupCache,
  getCachedPackage
}
