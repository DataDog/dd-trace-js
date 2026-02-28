'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const { execSync, fork, spawn } = childProcess
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('fs')
const fs = require('fs/promises')
const http = require('http')
const { builtinModules } = require('module')
const os = require('os')
const path = require('path')
const { inspect } = require('util')

const id = require('../../packages/dd-trace/src/id')
const { getCappedRange } = require('../../packages/dd-trace/test/plugins/versions')
const FakeAgent = require('./fake-agent')
const { BUN, withBun } = require('./bun')

const sandboxRoot = path.join(os.tmpdir(), id().toString())
const hookFile = 'dd-trace/loader-hook.mjs'

const { DEBUG } = process.env

// This is set by the setShouldKill function
let shouldKill

// Symbol constants for dynamic value matching in assertObjectContains
const ANY_STRING = Symbol('test.ANY_STRING')
const ANY_NUMBER = Symbol('test.ANY_NUMBER')
const ANY_VALUE = Symbol('test.ANY_VALUE')

/**
 * @param {string} filename
 * @param {string} cwd
 * @param {string|((out: Promise<string>) => void)} expectedOut
 * @param {string} expectedSource
 */
async function runAndCheckOutput (filename, cwd, expectedOut, expectedSource) {
  const proc = spawn(process.execPath, [filename], { cwd, stdio: 'pipe' })
  assert(proc.pid !== undefined, 'Process PID is not available')
  const pid = proc.pid
  let out = await new Promise((resolve, reject) => {
    proc.once('error', reject)
    let out = Buffer.alloc(0)
    proc.stdout.on('data', data => {
      out = Buffer.concat([out, data])
    })
    proc.stderr.pipe(process.stdout)
    proc.once('exit', () => resolve(out.toString('utf8')))
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
    assert.match(out, new RegExp(expectedOut), `output "${out}" does not contain expected output "${expectedOut}"`)
  }

  if (expectedSource) {
    assert.match(out, new RegExp(`instrumentation source: ${expectedSource}`),
    `Expected the process to output "${expectedSource}", but logs only contain: "${out}"`)
  }
  return pid
}

// This is set by the useSandbox function
let sandbox

/**
 * This _must_ be used with the useSandbox function
 *
 * @param {string} filename
 * @param {string|((out: Promise<string>) => void)} expectedOut
 * @param {string[]} expectedTelemetryPoints
 * @param {string} expectedSource
 */
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

/**
 * @param {number} pid
 * @param {[string, { metadata: Record<string, unknown>, points: { name: string, tags: string[] }[] }][]} msgs
 * @param {string[]} expectedTelemetryPoints
 */
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

  /**
   * @param {...string} args
   * @returns {{ name: string, tags: string[] }[]}
   */
  function getPoints (...args) {
    const expectedPoints = []
    for (let i = 0; i < args.length; i += 2) {
      expectedPoints.push({
        name: 'library_entrypoint.' + args[i],
        tags: args[i + 1].split(',').filter(Boolean),
      })
    }
    return expectedPoints
  }

  /**
   * @param {Record<string, unknown>} actualMetadata
   * @param {number} pid
   */
  function assertMetadata (actualMetadata, pid) {
    const expectedBasicMetadata = {
      language_name: 'nodejs',
      language_version: process.versions.node,
      runtime_name: 'nodejs',
      runtime_version: process.versions.node,
      tracer_version: require('../../package.json').version,
      pid,
    }

    // Validate basic metadata
    for (const key of Object.keys(expectedBasicMetadata)) {
      assert.strictEqual(actualMetadata[key], expectedBasicMetadata[key])
    }

    // Validate result metadata is present and has valid values
    assert(typeof actualMetadata.result === 'string', 'result should be a string')
    assert(typeof actualMetadata.result_class === 'string', 'result_class should be a string')
    assert(typeof actualMetadata.result_reason === 'string', 'result_reason should be a string')
    assert(actualMetadata.result, 'result field should be present')
    assert(actualMetadata.result_class, 'result_class field should be present')
    assert(actualMetadata.result_reason, 'result_reason field should be present')

    // Check that result metadata has expected values for telemetry scenarios
    const validResults = ['success', 'abort', 'error', 'unknown']
    const validResultClasses = ['success', 'incompatible_runtime',
      'incompatible_library', 'incompatible_bundle', 'internal_error', 'unknown']

    assert(validResults.includes(actualMetadata.result), `Invalid result: ${actualMetadata.result}`)
    assert(validResultClasses.includes(actualMetadata.result_class),
      `Invalid result_class: ${actualMetadata.result_class}`)
  }
}

/**
 * @typedef {childProcess.ChildProcess & {
 *   url: string,
 *   stdout: NodeJS.ReadableStream,
 *   stderr: NodeJS.ReadableStream
 * }} SpawnedProcess
 */

/**
 * Spawns a Node.js script in a child process and returns a promise that resolves when the process is ready.
 *
 * This function expects the spawned process to stay alive (e.g., a server). If the process exits
 * (even with code 0), the promise will reject with an error.
 *
 * For processes that are expected to run and exit cleanly, use `spawnProcAndExpectExit` instead.
 *
 * @param {string|URL} filename - The filename of the Node.js script to spawn in a child process.
 * @param {childProcess.ForkOptions} [options] - The options to pass to the child process.
 * @param {(data: Buffer) => void} [stdioHandler] - A function that's called with one data argument to handle the
 *   standard output of the child process. If not provided, the output will be logged to the console.
 * @param {(data: Buffer) => void} [stderrHandler] - A function that's called with one data argument to handle the
 *   standard error of the child process. If not provided, the error will be logged to the console.
 * @returns {Promise<SpawnedProcess>} A promise that resolves with a SpawnedProcess when the process is ready.
 *   The returned `SpawnedProcess` will have a `url` property that can be accessed to get the server URL.
 *   Note: Accessing `url` before the spawned process sends its port message will throw an error.
 */
function spawnProc (filename, options = {}, stdioHandler, stderrHandler) {
  const proc = spawnProcImpl(filename, options, stdioHandler, stderrHandler)

  let urlValue
  Object.defineProperty(proc, 'url', {
    get () {
      if (urlValue === undefined) {
        throw new Error('Process URL is not available yet. The spawned process has not sent a port message.')
      }
      return urlValue
    },
    set (value) {
      urlValue = value
    },
    enumerable: true,
    configurable: true,
  })

  return new Promise((resolve, reject) => {
    proc
      .on('message', (/** @type {{ port?: unknown }} */ { port }) => {
        if (typeof port !== 'number' && typeof port !== 'string') {
          return reject(new Error(`${filename} sent invalid port: ${port}. Expected a number or string.`))
        }
        proc.url = `http://localhost:${port}`
        resolve(proc)
      })
      .once('error', reject)
      .once('exit', code => {
        reject(new Error(`Process exited with status code ${code}.`))
      })
  })
}

/**
 * Spawns a Node.js script in a child process that is expected to run and exit cleanly.
 *
 * This function expects the process to complete and exit with code 0, in which case the promise resolves
 * with `undefined`. Use this for short-lived processes like validation scripts or tests that run to completion.
 *
 * For long-running processes (like servers) that should not exit, use `spawnProc` instead.
 *
 * @param {string|URL} filename - The filename of the Node.js script to spawn in a child process.
 * @param {childProcess.ForkOptions} [options] - The options to pass to the child process.
 * @param {(data: Buffer) => void} [stdioHandler] - A function that's called with one data argument to handle the
 *   standard output of the child process. If not provided, the output will be logged to the console.
 * @param {(data: Buffer) => void} [stderrHandler] - A function that's called with one data argument to handle the
 *   standard error of the child process. If not provided, the error will be logged to the console.
 * @returns {Promise<void>} A promise that resolves when the process exits with code 0.
 */
function spawnProcAndExpectExit (filename, options = {}, stdioHandler, stderrHandler) {
  const proc = spawnProcImpl(filename, options, stdioHandler, stderrHandler)

  return new Promise((resolve, reject) => {
    proc
      .once('error', reject)
      .once('exit', code => {
        if (code !== 0) {
          return reject(new Error(`Process exited with status code ${code}.`))
        }
        resolve()
      })
  })
}

/**
 * Internal implementation for spawnProc and spawnProcAndAllowExit.
 *
 * @param {string|URL} filename
 * @param {childProcess.ForkOptions} options
 * @param {(data: Buffer) => void} [stdioHandler]
 * @param {(data: Buffer) => void} [stderrHandler]
 * @returns {SpawnedProcess}
 */
function spawnProcImpl (filename, options, stdioHandler, stderrHandler) {
  // Cast to SpawnedProcess type - when stdio is 'pipe', stdout/stderr are guaranteed non-null
  const proc = /** @type {SpawnedProcess} */ (fork(filename, { ...options, stdio: 'pipe' }))

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

  return proc
}

function log (...args) {
  DEBUG === 'true' && console.log(...args) // eslint-disable-line no-console
}

function error (...args) {
  DEBUG === 'true' && console.error(...args) // eslint-disable-line no-console
}

function execHelper (command, options) {
  try {
    log('Exec START: ', command)
    execSync(command, options)
    log('Exec SUCCESS: ', command)
  } catch (execError) {
    error('Exec ERROR: ', command, execError)
    if (command.startsWith(BUN)) {
      try {
        log('Exec RETRY BACKOFF: 60 seconds')
        execSync('sleep 60')
        log('Exec RETRY START: ', command)
        execSync(command, options)
        log('Exec RETRY SUCCESS: ', command)
      } catch (retryError) {
        error('Exec RETRY ERROR', command, retryError)
        throw retryError
      }
    } else {
      throw execError
    }
  }
}

/**
 * Pack dd-trace into a tarball at the specified path.
 *
 * @param {string} tarballPath - The path where the tarball should be created
 * @param {NodeJS.ProcessEnv} env - The environment to use for the pack command
 */
function packTarball (tarballPath, env) {
  execHelper(`${BUN} pm pack --ignore-scripts --quiet --gzip-level 0 --filename ${tarballPath}`, { env })
  log('Tarball packed successfully:', tarballPath)
}

/**
 * Pack the tarball with file locking to coordinate between parallel workers.
 * Only one worker will pack the tarball, others will wait for it to be ready.
 *
 * @param {string} tarballPath - The path where the tarball should be created
 * @param {NodeJS.ProcessEnv} env - The environment to use for the pack command
 * @returns {Promise<void>}
 */
async function packTarballWithLock (tarballPath, env) {
  if (existsSync(tarballPath)) {
    log('Tarball already exists:', tarballPath)
    return
  }

  const lockFile = `${tarballPath}.lock`
  let lockFd

  try {
    // Try to acquire the lock by creating the lock file exclusively
    lockFd = await fs.open(lockFile, 'wx')
    log('Lock acquired, packing tarball:', tarballPath)

    // Double-check if tarball was created while we were acquiring the lock
    if (existsSync(tarballPath)) {
      log('Tarball already exists (created while waiting for lock):', tarballPath)
      return
    }

    // We have the lock, pack the tarball
    packTarball(tarballPath, env)
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Lock exists, another process is packing - wait for the tarball to appear
      log('Lock file exists, waiting for tarball:', tarballPath)

      while (!existsSync(tarballPath)) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      log('Tarball ready:', tarballPath)
    } else {
      throw err
    }
  } finally {
    // Strictly no need to clean up the lock - it's in a temp directory
    if (lockFd) {
      lockFd.close().catch(() => {})
    }
  }
}

/**
 * @param {string[]} dependencies
 * @param {boolean} isGitRepo
 * @param {string[]} integrationTestsPaths
 * @param {string} [followUpCommand]
 */
async function createSandbox (
  dependencies = [],
  isGitRepo = false,
  integrationTestsPaths = ['./integration-tests/*'],
  followUpCommand
) {
  const cappedDependencies = dependencies.map(dep => {
    if (builtinModules.includes(dep)) return dep

    const match = dep.replaceAll(/['"]/g, '').match(/^(@?[^@]+)(@(.+))?$/)

    assert(match !== null, `Invalid dependency format: ${dep}`)

    const name = match[1]
    const range = match[3] || ''
    const cappedRange = getCappedRange(name, range)

    return `"${name}@${cappedRange}"`
  })

  // We might use NODE_OPTIONS to init the tracer. We don't want this to affect this operations
  const { NODE_OPTIONS, ...restOfEnv } = withBun(process.env)
  const noSandbox = String(process.env.TESTING_NO_INTEGRATION_SANDBOX)
  if (noSandbox === '1' || noSandbox.toLowerCase() === 'true') {
    // Execute integration tests without a sandbox. This is useful when you have other components
    // yarn-linked into dd-trace and want to run the integration tests against them.

    // Link dd-trace to itself, then...
    execHelper('yarn link')
    execHelper('yarn link dd-trace')
    // ... run the tests in the current directory.
    return { folder: path.join(process.cwd(), 'integration-tests'), remove: async () => {} }
  }
  const folder = path.join(sandboxRoot, id().toString())
  const tarballEnv = process.env.DD_TEST_SANDBOX_TARBALL_PATH
  const out = tarballEnv && tarballEnv !== '0' && tarballEnv !== 'false'
    ? tarballEnv
    : path.join(sandboxRoot, 'dd-trace.tgz')
  const deps = cappedDependencies.concat(`file:${out}`)

  await fs.mkdir(folder, { recursive: true })
  const addOptions = { cwd: folder, env: restOfEnv }
  const addFlags = ['--trust']

  await packTarballWithLock(out, restOfEnv)

  if (process.env.OFFLINE === '1' || process.env.OFFLINE === 'true') {
    addFlags.push('--prefer-offline')
  }

  if (process.env.OMIT) {
    addFlags.push(...process.env.OMIT.split(',').map(omit => `--omit=${omit}`))
  }

  if (DEBUG !== 'true') {
    addFlags.push('--silent')
  }

  execHelper(`${BUN} add ${deps.join(' ')} ${addFlags.join(' ')}`, {
    ...addOptions,
    timeout: 90_000,
  })

  for (const path of integrationTestsPaths) {
    if (process.platform === 'win32') {
      execHelper(`Copy-Item -Recurse -Path "${path}" -Destination "${folder}"`, { shell: 'powershell.exe' })
    } else {
      execHelper(`cp -R ${path} ${folder}`)
    }
  }
  if (process.platform === 'win32') {
    // On Windows, we can only sync entire filesystem volume caches.
    execHelper(`Write-VolumeCache ${folder[0]}`, { shell: 'powershell.exe' })
  } else {
    execHelper(`sync ${folder}`)
  }

  if (followUpCommand) {
    execHelper(followUpCommand, { cwd: folder, env: restOfEnv })
  }

  if (isGitRepo) {
    execHelper('git init', { cwd: folder })
    await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules/', { flush: true })
    execHelper('git config user.email "john@doe.com"', { cwd: folder })
    execHelper('git config user.name "John Doe"', { cwd: folder })
    execHelper('git config commit.gpgsign false', { cwd: folder })

    // Create a unique local bare repo for this test
    const localRemotePath = path.join(folder, '..', `${path.basename(folder)}-remote.git`)
    if (!existsSync(localRemotePath)) {
      execHelper(`git init --bare ${localRemotePath}`)
    }

    execHelper('git add -A', { cwd: folder })
    execHelper('git commit -m "first commit" --no-verify', { cwd: folder })
    execHelper(`git remote add origin ${localRemotePath}`, { cwd: folder })
    execHelper('git push --set-upstream origin HEAD', { cwd: folder })
  }

  return {
    folder,
    remove: () => {
      // Use `exec` below, instead of `fs.rm` to keep support for older Node.js versions, since this code is called in
      // our `integration-guardrails` GitHub Actions workflow
      if (process.platform === 'win32') {
        return execHelper(`Remove-Item -Recurse -Path "${folder}"`, { shell: 'powershell.exe' })
      } else {
        return execHelper(`rm -rf ${folder}`)
      }
    },
  }
}

/**
 * @typedef {{ default?: string, star: string, destructure: string }} Variants
 */
/**
 * @overload
 * @param {string} filename - The file that will be copied and modified for each variant.
 * @param {string} bindingName - The binding name that will be use to bind to the packageName.
 * @param {string} [namedExport] - The name of the named variant to use.
 * @param {string} [packageName] - The name of the package. If not provided, the binding name will be used.
 * @param {boolean} [byPassDefault] - Skip default export variant generation.
 * @returns {Variants} A map from variant names to resulting filenames
 */
/**
 * Creates a bunch of files based on an original file in sandbox. Useful for varying test files
 * without having to create a bunch of them yourself.
 *
 * The variants object should have keys that are named variants, and values that are the text
 * in the file that's different in each variant. There must always be a "default" variant,
 * whose value is the original text within the file that will be replaced.
 *
 * @param {string} filename - The file that will be copied and modified for each variant.
 * @param {Variants|string} variants - The variants or binding name.
 * @param {string} [namedExport] - Named export to use for star/destructure variants.
 * @param {string} [packageName] - Module specifier for the import.
 * @param {boolean} [byPassDefault] - Skip default export variant generation.
 * @returns {Variants} A map from variant names to resulting filenames
 */
function varySandbox (filename, variants, namedExport, packageName, byPassDefault) {
  if (typeof variants === 'string') {
    const bindingName = variants
    const resolvedName = packageName || bindingName
    // Default namedVariant to bindingName when bypassing default export
    if (byPassDefault && !namedExport) namedExport = bindingName
    variants = byPassDefault
      ? {
          // eslint-disable-next-line @stylistic/max-len
          star: `import * as mod${bindingName} from '${resolvedName}'; const ${bindingName} = mod${bindingName}.${namedExport}`,
          destructure: `import { ${namedExport} } from '${resolvedName}'`,
        }
      : {
          default: `import ${bindingName} from '${resolvedName}'`,
          star: namedExport
            ? `import * as ${bindingName} from '${resolvedName}'`
            : `import * as mod${bindingName} from '${resolvedName}'; const ${bindingName} = mod${bindingName}.default`,
          destructure: namedExport
            ? `import { ${namedExport} } from '${resolvedName}'; const ${bindingName} = { ${namedExport} }`
            : `import { default as ${bindingName}} from '${resolvedName}'`,
        }
  }

  const origFileData = readFileSync(path.join(sandbox.folder, filename), 'utf8')
  const { name: prefix, ext: suffix } = path.parse(filename)
  const variantFilenames = /** @type {Variants} */ ({})
  const baseVariant = byPassDefault ? 'destructure' : 'default'

  for (const [variant, value] of Object.entries(variants)) {
    const variantFilename = `${prefix}-${variant}${suffix}`
    variantFilenames[variant] = variantFilename
    let newFileData = origFileData
    if (variant !== baseVariant) {
      const baseValue = variants[baseVariant]
      assert(baseValue, `Missing ${baseVariant} variant`)
      newFileData = origFileData.replace(baseValue, `${value}`)
      // Error out when the default import does not match that of server.mjs
      if (newFileData === origFileData) throw Error(`Unable to match ${baseVariant}`)
    }
    writeFileSync(path.join(sandbox.folder, variantFilename), newFileData)
  }
  return variantFilenames
}

/**
 * @type {['default', 'star', 'destructure']}
 */
varySandbox.VARIANTS = ['default', 'star', 'destructure']

/**
 * @param {boolean} shouldExpectTelemetryPoints
 */
function telemetryForwarder (shouldExpectTelemetryPoints = true) {
  const forwarderOut = path.join(__dirname, 'output', `forwarder-${Date.now()}.out`)

  process.env.DD_TELEMETRY_FORWARDER_PATH = path.join(__dirname, '..', 'telemetry-forwarder.sh')
  process.env.FORWARDER_OUT = forwarderOut

  let retries = 0

  const tryAgain = async function () {
    retries += 1
    await new Promise(resolve => setTimeout(resolve, 100))
    return cleanup()
  }

  const cleanup = function () {
    /** @type {string[]} */
    let lines
    try {
      lines = readFileSync(forwarderOut, 'utf8').trim().split('\n')
    } catch (e) {
      if (shouldExpectTelemetryPoints && e.code === 'ENOENT' && retries < 10) {
        return tryAgain()
      }
      return []
    }
    /** @type {Array<[string, unknown]>} */
    const msgs = []
    for (const line of lines) {
      const [telemetryType, data] = line.split('\t')
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
      msgs.push([telemetryType, parsed])
    }
    unlinkSync(forwarderOut)
    delete process.env.FORWARDER_OUT
    delete process.env.DD_TELEMETRY_FORWARDER_PATH
    return msgs
  }

  return cleanup
}

/**
 * @param {string | URL | Promise<string | URL | { url: string }> | { url: string }} url
 * @returns {Promise<import('http').IncomingMessage & { body: string }>}
 */
async function curl (url) {
  if (url !== null && typeof url === 'object') {
    if ('then' in url) {
      return curl(await url)
    }
    if ('url' in url) {
      url = url.url
    }
  }

  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const bufs = []
      res.on('data', d => bufs.push(d))
      res.once('end', () => {
        resolve(Object.assign(res, { body: Buffer.concat(bufs).toString('utf8') }))
      })
      res.once('error', reject)
    }).once('error', reject)
  })
}

/**
 * @param {FakeAgent} agent
 * @param {string | URL | Promise<string | URL | { url: string }> | { url: string }} procOrUrl
 * @param {(res: { headers: Record<string, string>, payload: unknown[] }) => void} fn
 * @param {number} [timeout]
 * @param {number} [expectedMessageCount]
 * @param {boolean} [resolveAtFirstSuccess]
 */
async function curlAndAssertMessage (agent, procOrUrl, fn, timeout, expectedMessageCount, resolveAtFirstSuccess) {
  const resultPromise = agent.assertMessageReceived(fn, timeout, expectedMessageCount, resolveAtFirstSuccess)
  await curl(procOrUrl)
  return resultPromise
}

/**
 * @param {number} port
 * @returns {NodeJS.ProcessEnv}
 */
function getCiVisAgentlessConfig (port) {
  // We remove GITHUB_WORKSPACE so the repository root is not assigned to dd-trace-js
  // We remove MOCHA_OPTIONS so the test runner doesn't run the tests twice
  const { GITHUB_WORKSPACE, MOCHA_OPTIONS, ...rest } = process.env
  return {
    ...rest,
    DD_API_KEY: '1',
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
    DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${port}`,
    NODE_OPTIONS: '-r dd-trace/ci/init',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
  }
}

/**
 * @param {number} port
 * @returns {NodeJS.ProcessEnv}
 */
function getCiVisEvpProxyConfig (port) {
  // We remove GITHUB_WORKSPACE so the repository root is not assigned to dd-trace-js
  // We remove MOCHA_OPTIONS so the test runner doesn't run the tests twice
  const { GITHUB_WORKSPACE, MOCHA_OPTIONS, ...rest } = process.env
  return {
    ...rest,
    DD_TRACE_AGENT_PORT: String(port),
    NODE_OPTIONS: '-r dd-trace/ci/init',
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
  }
}

/**
 * @param {object[][]} spans
 * @param {string} name
 */
function checkSpansForServiceName (spans, name) {
  return spans.some((span) => span.some((nestedSpan) => nestedSpan.name === name))
}

/**
 * @typedef {Record<string, string|undefined>} AdditionalEnvArgs
 */

/**
 * Prepares spawn options for plugin integration tests.
 *
 * @param {string} cwd
 * @param {string} serverFile
 * @param {string|number} agentPort
 * @param {AdditionalEnvArgs} [additionalEnvArgs]
 * @param {string[]} [execArgv]
 * @param {(data: Buffer) => void} [stdioHandler]
 * @returns {{ filename: string, options: childProcess.ForkOptions,
 *   stdioHandler: ((data: Buffer) => void) | undefined }}
 */
function preparePluginIntegrationTestSpawnOptions (
  cwd, serverFile, agentPort, additionalEnvArgs, execArgv, stdioHandler
) {
  additionalEnvArgs = { ...additionalEnvArgs }

  let NODE_OPTIONS = `--loader=${hookFile}`
  if (additionalEnvArgs.NODE_OPTIONS !== undefined) {
    if (/--(loader|import)/.test(additionalEnvArgs.NODE_OPTIONS ?? '')) {
      NODE_OPTIONS = additionalEnvArgs.NODE_OPTIONS
    } else {
      NODE_OPTIONS += ` ${additionalEnvArgs.NODE_OPTIONS}`
    }
    delete additionalEnvArgs.NODE_OPTIONS
  }

  return {
    filename: path.join(cwd, serverFile),
    options: {
      cwd,
      env: {
        ...process.env,
        NODE_OPTIONS,
        DD_TRACE_AGENT_PORT: String(agentPort),
        DD_TRACE_FLUSH_INTERVAL: '0',
        ...additionalEnvArgs,
      },
      execArgv,
    },
    stdioHandler,
  }
}

/**
 * Spawns a plugin integration test process that runs a long-lived server.
 *
 * The spawned process should call `process.send({ port })` to signal it's ready.
 * Use this for tests that spawn HTTP servers or other long-running processes.
 *
 * For short-lived scripts that run and exit, use `spawnPluginIntegrationTestProcAndExpectExit` instead.
 *
 * @param {string} cwd
 * @param {string} serverFile
 * @param {string|number} agentPort
 * @param {AdditionalEnvArgs} [additionalEnvArgs]
 * @param {string[]} [execArgv]
 * @param {(data: Buffer) => void} [stdioHandler]
 */
function spawnPluginIntegrationTestProc (cwd, serverFile, agentPort, additionalEnvArgs, execArgv, stdioHandler) {
  const { filename, options, stdioHandler: handler } =
    preparePluginIntegrationTestSpawnOptions(cwd, serverFile, agentPort, additionalEnvArgs, execArgv, stdioHandler)
  return spawnProc(filename, options, handler)
}

/**
 * Spawns a plugin integration test process that is expected to run and exit cleanly.
 *
 * Use this for short-lived test scripts that run instrumented code and exit (e.g., making a
 * fetch request, DNS lookup, etc.) rather than starting a long-running server.
 *
 * For tests that spawn a server which should stay alive, use `spawnPluginIntegrationTestProc` instead.
 *
 * @param {string} cwd
 * @param {string} serverFile
 * @param {string|number} agentPort
 * @param {AdditionalEnvArgs} [additionalEnvArgs]
 * @param {string[]} [execArgv]
 * @param {(data: Buffer) => void} [stdioHandler]
 */
function spawnPluginIntegrationTestProcAndExpectExit (
  cwd, serverFile, agentPort, additionalEnvArgs, execArgv, stdioHandler
) {
  const { filename, options, stdioHandler: handler } =
    preparePluginIntegrationTestSpawnOptions(cwd, serverFile, agentPort, additionalEnvArgs, execArgv, stdioHandler)
  return spawnProcAndExpectExit(filename, options, handler)
}

/**
 * @param {Record<string, string|undefined>} env
 */
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

/**
 * @param {Parameters<createSandbox>} args
 */
function useSandbox (...args) {
  before(async function () {
    this.timeout(300_000)
    sandbox = await createSandbox(...args)
  })

  after(function () {
    this.timeout(30_000)
    return sandbox.remove()
  })
}

/**
 * @returns {string}
 */
function sandboxCwd () {
  return sandbox.folder
}

/**
 * @param {boolean} value
 */
function setShouldKill (value) {
  before(() => {
    shouldKill = value
  })

  after(() => {
    shouldKill = true
  })
}

// Implementation with optional matcher support (ANY_STRING, ANY_NUMBER, ANY_VALUE)
function assertObjectContainsImpl (actual, expected, msg, useMatchers) {
  if (expected === null || typeof expected !== 'object') {
    assert.strictEqual(actual, expected, msg)
    return
  }

  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${msg ?? ''}Expected array but got ${inspect(actual)}`)
    let startIndex = 0
    for (const expectedItem of expected) {
      let found = false
      for (let i = startIndex; i < actual.length; i++) {
        const actualItem = actual[i]
        try {
          if (expectedItem !== null && typeof expectedItem === 'object') {
            assertObjectContainsImpl(actualItem, expectedItem, msg, useMatchers)
          } else {
            assert.strictEqual(actualItem, expectedItem, msg)
          }
          startIndex = i + 1
          found = true
          break
        } catch {
          continue
        }
      }
      assert.ok(found, `${msg ?? ''}Expected array ${inspect(actual)} to contain ${inspect(expectedItem)}`)
    }
    return
  }

  for (const [key, val] of Object.entries(expected)) {
    assert.ok(Object.hasOwn(actual, key), msg)
    if (useMatchers && val === ANY_STRING) {
      assert.strictEqual(typeof actual[key], 'string', `Expected ${key} to be a string but got ${typeof actual[key]}`)
    } else if (useMatchers && val === ANY_NUMBER) {
      assert.strictEqual(typeof actual[key], 'number', `Expected ${key} to be a number but got ${typeof actual[key]}`)
    } else if (useMatchers && val === ANY_VALUE) {
      assert.ok(actual[key] !== undefined, `Expected ${key} to be present but it was undefined`)
    } else if (val !== null && typeof val === 'object') {
      assertObjectContainsImpl(actual[key], val, msg, useMatchers)
    } else {
      assert.ok(actual, msg)
      assert.strictEqual(actual[key], expected[key], msg)
    }
  }
}

// Main assertObjectContains: tries partialDeepStrictEqual or strict first, falls back to matchers
const assertObjectContains = function assertObjectContains (actual, expected, msg) {
  // @ts-expect-error assert.partialDeepStrictEqual does not exist on older Node.js versions
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const assertionFn = assert.partialDeepStrictEqual ||
    ((actual, expected, msg) => assertObjectContainsImpl(actual, expected, msg, false))

  try {
    assertionFn(actual, expected, msg)
  } catch {
    // First attempt failed, retry with matcher support
    try {
      assertObjectContainsImpl(actual, expected, msg, true)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error)

      throw new assert.AssertionError({
        actual,
        expected,
        operator: 'partialDeepStrictEqual',
      })
    }
  }
}

/**
 * @param {string} actual
 * @param {string} [msg]
 */
function assertUUID (actual, msg = 'not a valid UUID') {
  assert.match(actual, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/, msg)
}

module.exports = {
  ANY_NUMBER,
  ANY_STRING,
  ANY_VALUE,
  FakeAgent,
  hookFile,
  assertObjectContains,
  assertUUID,
  spawnProc,
  spawnProcAndExpectExit,
  telemetryForwarder,
  assertTelemetryPoints,
  runAndCheckWithTelemetry,
  curl,
  curlAndAssertMessage,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  spawnPluginIntegrationTestProcAndExpectExit,
  useEnv,
  setShouldKill,
  sandboxCwd,
  useSandbox,
  varySandbox,
}
