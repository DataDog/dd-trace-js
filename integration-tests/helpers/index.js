'use strict'

const childProcess = require('child_process')
const { execSync, fork, spawn } = childProcess
const http = require('http')
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('fs')
const fs = require('fs/promises')
const { builtinModules } = require('module')
const os = require('os')
const path = require('path')
const assert = require('assert')
const FakeAgent = require('./fake-agent')
const id = require('../../packages/dd-trace/src/id')
const { version } = require('../../package.json')
const { getCappedRange } = require('../../packages/dd-trace/test/plugins/versions')

const hookFile = 'dd-trace/loader-hook.mjs'

// This is set by the setShouldKill function
let shouldKill

/**
 * @param {string} filename
 * @param {string} cwd
 * @param {string|function} expectedOut
 * @param {string} expectedSource
 */
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

/**
 * This _must_ be used with the useSandbox function
 *
 * @param {string} filename
 * @param {string|function} expectedOut
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
    let currentPoint = /** @type {{ name?: string, tags?: string[] }} */ ({})
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
 * @returns {Promise<childProcess.ChildProcess & { url?: string }|void>} A promise that resolves when the process
 *   is either ready or terminated without an error. If the process is terminated without an error, the promise will
 *   resolve with `undefined`.The returned process will have a `url` property if the process didn't terminate.
 */
function spawnProc (filename, options = {}, stdioHandler, stderrHandler) {
  const proc = fork(filename, { ...options, stdio: 'pipe' })

  return /** @type {Promise<childProcess.ChildProcess & { url?: string }|void>} */ (new Promise((resolve, reject) => {
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
  }))
}

function execHelper (command, options) {
  /* eslint-disable no-console */
  try {
    console.log('Exec START: ', command)
    execSync(command, options)
    console.log('Exec SUCCESS: ', command)
  } catch (error) {
    console.error('Exec ERROR: ', command, error)
    if (command.startsWith('yarn')) {
      try {
        console.log('Exec RETRY START: ', command)
        execSync(command, options)
        console.log('Exec RETRY SUCESS: ', command)
      } catch (retryError) {
        console.error('Exec RETRY ERROR', command, retryError)
        throw retryError
      }
    } else {
      throw error
    }
  }
  /* eslint-enable no-console */
}

async function isolatedSandbox (dependencies, isGitRepo, integrationTestsPaths, followUpCommand) {
  return createSandbox(dependencies, isGitRepo, integrationTestsPaths, followUpCommand, true)
}

async function linkedSandbox (dependencies, isGitRepo, integrationTestsPaths, followUpCommand) {
  return createSandbox(dependencies, isGitRepo, integrationTestsPaths, followUpCommand, false)
}

/**
 * @param {string[]} dependencies
 * @param {boolean} isGitRepo
 * @param {string[]} integrationTestsPaths
 * @param {string} [followUpCommand]
 * @param {string} [isolated=true]
 */
async function createSandbox (dependencies = [], isGitRepo = false,
  integrationTestsPaths = ['./integration-tests/*'], followUpCommand, isolated = true) {
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
    execHelper('yarn link')
    execHelper('yarn link dd-trace')
    // ... run the tests in the current directory.
    return { folder: path.join(process.cwd(), 'integration-tests'), remove: async () => {} }
  }
  const folder = path.join(os.tmpdir(), id().toString())
  const out = path.join(folder, `dd-trace-${version}.tgz`)
  const deps = cappedDependencies

  await fs.mkdir(folder)
  const addOptions = { cwd: folder, env: restOfEnv }
  const addFlags = ['--ignore-engines']

  if (process.env.OFFLINE === '1' || process.env.OFFLINE === 'true') {
    addFlags.push('--prefer-offline')
  }

  if (isolated) {
    execHelper(`npm pack --silent --pack-destination ${folder}`, { env: restOfEnv })
    execHelper(`yarn add ${deps.concat(`file:${out}`).join(' ')}`, addOptions)
  } else {
    execHelper('yarn link')
    if (deps.length > 0) {
      execHelper(`yarn add ${deps.join(' ')}`, addOptions)
    }
    execHelper('yarn link dd-trace', addOptions)
  }

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
    }
  }
}

/**
 * @typedef {{ default: string, star: string, destructure: string }} Variants
 */
/**
 * @overload
 * @param {object} sandbox - A `sandbox` as returned from `createSandbox`
 * @param {string} filename - The file that will be copied and modified for each variant.
 * @param {string} bindingName - The binding name that will be use to bind to the packageName.
 * @param {string} [namedVariant] - The name of the named variant to use.
 * @param {string} [packageName] - The name of the package. If not provided, the binding name will be used.
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
 * @param {object} sandbox - A `sandbox` as returned from `createSandbox`
 * @param {string} filename - The file that will be copied and modified for each variant.
 * @param {Variants} variants - The variants.
 * @returns {Variants} A map from variant names to resulting filenames
 */
function varySandbox (sandbox, filename, variants, namedVariant, packageName = variants) {
  if (typeof variants === 'string') {
    const bindingName = variants
    variants = {
      default: `import ${bindingName} from '${packageName}'`,
      star: namedVariant
        ? `import * as ${bindingName} from '${packageName}'`
        : `import * as mod${bindingName} from '${packageName}'; const ${bindingName} = mod${bindingName}.default`,
      destructure: namedVariant
        ? `import { ${namedVariant} } from '${packageName}'; const ${bindingName} = { ${namedVariant} }`
        : `import { default as ${bindingName}} from '${packageName}'`
    }
  }

  const origFileData = readFileSync(path.join(sandbox.folder, filename), 'utf8')
  const { name: prefix, ext: suffix } = path.parse(filename)
  const variantFilenames = /** @type {Variants} */ ({})

  for (const [variant, value] of Object.entries(variants)) {
    const variantFilename = `${prefix}-${variant}${suffix}`
    variantFilenames[variant] = variantFilename
    let newFileData = origFileData
    if (variant !== 'default') {
      newFileData = origFileData.replace(variants.default, `${value}`)
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
      msgs = readFileSync(process.env.FORWARDER_OUT, 'utf8').trim().split('\n')
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
    unlinkSync(process.env.FORWARDER_OUT)
    delete process.env.FORWARDER_OUT
    delete process.env.DD_TELEMETRY_FORWARDER_PATH
    return msgs
  }

  return cleanup
}

/**
 * @param {string|{ then: (callback: () => Promise<string>) => Promise<string> }|URL} url
 */
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

/**
 * @param {FakeAgent} agent
 * @param {string|{ then: (callback: () => Promise<string>) => Promise<string> }|URL} procOrUrl
 * @param {function} fn
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
 */
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

/**
 * @param {number} port
 */
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

/**
 * @param {object[][]} spans
 * @param {string} name
 */
function checkSpansForServiceName (spans, name) {
  return spans.some((span) => span.some((nestedSpan) => nestedSpan.name === name))
}

/**
 * @overload
 * @param {string} cwd
 * @param {string} serverFile
 * @param {string|number} agentPort
 * @param {Record<string, string|undefined>} [additionalEnvArgs]
 */
/**
 * @param {string} cwd
 * @param {string} serverFile
 * @param {string|number} agentPort
 * @param {function} [stdioHandler]
 * @param {Record<string, string|undefined>} [additionalEnvArgs]
 */
async function spawnPluginIntegrationTestProc (cwd, serverFile, agentPort, stdioHandler, additionalEnvArgs) {
  if (typeof stdioHandler !== 'function' && !additionalEnvArgs) {
    additionalEnvArgs = stdioHandler
    stdioHandler = undefined
  }
  additionalEnvArgs = additionalEnvArgs || {}
  let env = /** @type {Record<string, string|undefined>} */ ({
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: String(agentPort),
    DD_TRACE_FLUSH_INTERVAL: '0'
  })
  env = { ...process.env, ...env, ...additionalEnvArgs }
  return spawnProc(path.join(cwd, serverFile), {
    cwd,
    env
  }, stdioHandler)
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
 * @param {unknown[]} args
 */
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

// @ts-expect-error assert.partialDeepStrictEqual does not exist on older Node.js versions
// eslint-disable-next-line n/no-unsupported-features/node-builtins
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

/**
 * @param {string} actual
 * @param {string} [msg]
 */
function assertUUID (actual, msg = 'not a valid UUID') {
  assert.match(actual, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/, msg)
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
  curl,
  curlAndAssertMessage,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  checkSpansForServiceName,
  isolatedSandbox,
  linkedSandbox,
  spawnPluginIntegrationTestProc,
  useEnv,
  useSandbox,
  sandboxCwd,
  setShouldKill,
  varySandbox
}
