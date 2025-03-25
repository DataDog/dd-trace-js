'use strict'

const { promisify } = require('util')
const childProcess = require('child_process')
const { fork, spawn } = childProcess
const exec = promisify(childProcess.exec)
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const rimraf = promisify(require('rimraf'))
const FakeAgent = require('./fake-agent')
const id = require('../../packages/dd-trace/src/id')

const hookFile = 'dd-trace/loader-hook.mjs'

async function runAndCheckOutput (filename, cwd, expectedOut) {
  const proc = spawn('node', [filename], { cwd, stdio: 'pipe' })
  const pid = proc.pid
  let out = await new Promise((resolve, reject) => {
    proc.on('error', reject)
    let out = Buffer.alloc(0)
    proc.stdout.on('data', data => {
      out = Buffer.concat([out, data])
    })
    proc.stderr.pipe(process.stdout)
    proc.on('exit', () => resolve(out.toString('utf8')))
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill()
    }, 1000) // TODO this introduces flakiness. find a better way to end the process.
  })
  if (typeof expectedOut === 'function') {
    expectedOut(out)
  } else {
    if (process.env.DD_TRACE_DEBUG) {
      // Debug adds this, which we don't care about in these tests
      out = out.replace('Flushing 0 metrics via HTTP\n', '')
    }
    assert.strictEqual(out, expectedOut)
  }
  return pid
}

// This is set by the useSandbox function
let sandbox

// This _must_ be used with the useSandbox function
async function runAndCheckWithTelemetry (filename, expectedOut, ...expectedTelemetryPoints) {
  const cwd = sandbox.folder
  const cleanup = telemetryForwarder(expectedTelemetryPoints)
  const pid = await runAndCheckOutput(filename, cwd, expectedOut)
  const msgs = await cleanup()
  if (expectedTelemetryPoints.length === 0) {
    // assert no telemetry sent
    try {
      assert.deepStrictEqual(msgs.length, 0)
    } catch (e) {
      // This console.log is useful for debugging telemetry. Plz don't remove.
      // eslint-disable-next-line no-console
      console.error('Expected no telemetry, but got:\n', msgs.map(msg => JSON.stringify(msg[1].points)).join('\n'))
      throw e
    }
    return
  }
  let points = []
  for (const [telemetryType, data] of msgs) {
    assert.strictEqual(telemetryType, 'library_entrypoint')
    assert.deepStrictEqual(data.metadata, meta(pid))
    points = points.concat(data.points)
  }
  let expectedPoints = getPoints(...expectedTelemetryPoints)
  // We now have to sort both the expected and actual telemetry points.
  // This is because data can come in in any order.
  // We'll just contatenate all the data together for each point and sort them.
  points = points.map(p => p.name + '\t' + p.tags.join(',')).sort().join('\n')
  expectedPoints = expectedPoints.map(p => p.name + '\t' + p.tags.join(',')).sort().join('\n')
  assert.strictEqual(points, expectedPoints)

  function getPoints (...args) {
    const expectedPoints = []
    let currentPoint = {}
    for (const arg of args) {
      if (!currentPoint.name) {
        currentPoint.name = 'library_entrypoint.' + arg
      } else {
        currentPoint.tags = arg.split(',')
        expectedPoints.push(currentPoint)
        currentPoint = {}
      }
    }
    return expectedPoints
  }

  function meta (pid) {
    return {
      language_name: 'nodejs',
      language_version: process.versions.node,
      runtime_name: 'nodejs',
      runtime_version: process.versions.node,
      tracer_version: require('../../package.json').version,
      pid: Number(pid)
    }
  }
}

function spawnProc (filename, options = {}, stdioHandler, stderrHandler) {
  const proc = fork(filename, { ...options, stdio: 'pipe' })
  return new Promise((resolve, reject) => {
    proc
      .on('message', ({ port }) => {
        proc.url = `http://localhost:${port}`
        resolve(proc)
      })
      .on('error', reject)
      .on('exit', code => {
        if (code !== 0) {
          reject(new Error(`Process exited with status code ${code}.`))
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
  /* To execute integration tests without a sandbox uncomment the next line
   * and do `yarn link && yarn link dd-trace` */
  // return { folder: path.join(process.cwd(), 'integration-tests'), remove: async () => {} }
  const folder = path.join(os.tmpdir(), id().toString())
  const out = path.join(folder, 'dd-trace.tgz')
  const allDependencies = [`file:${out}`].concat(dependencies)

  // We might use NODE_OPTIONS to init the tracer. We don't want this to affect this operations
  const { NODE_OPTIONS, ...restOfEnv } = process.env

  fs.mkdirSync(folder)
  const addCommand = `yarn add ${allDependencies.join(' ')} --ignore-engines`
  const addOptions = { cwd: folder, env: restOfEnv }
  await exec(`yarn pack --filename ${out}`, { env: restOfEnv }) // TODO: cache this

  try {
    await exec(addCommand, addOptions)
  } catch (e) { // retry in case of server error from registry
    await exec(addCommand, addOptions)
  }

  for (const path of integrationTestsPaths) {
    if (process.platform === 'win32') {
      await exec(`Copy-Item -Recurse -Path "${path}" -Destination "${folder}"`, { shell: 'powershell.exe' })
    } else {
      await exec(`cp -R ${path} ${folder}`)
    }
  }
  if (process.platform === 'win32') {
    // On Windows, we can only sync entire filesystem volume caches.
    await exec(`Write-VolumeCache ${folder[0]}`, { shell: 'powershell.exe' })
  } else {
    await exec(`sync ${folder}`)
  }

  if (followUpCommand) {
    await exec(followUpCommand, { cwd: folder, env: restOfEnv })
  }

  if (isGitRepo) {
    await exec('git init', { cwd: folder })
    fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/', { flush: true })
    await exec('git config user.email "john@doe.com"', { cwd: folder })
    await exec('git config user.name "John Doe"', { cwd: folder })
    await exec('git config commit.gpgsign false', { cwd: folder })
    await exec(
      'git add -A && git commit -m "first commit" --no-verify && git remote add origin git@git.com:datadog/example.git',
      { cwd: folder }
    )
  }

  return {
    folder,
    remove: async () => rimraf(folder)
  }
}

function telemetryForwarder (expectedTelemetryPoints) {
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
      if (expectedTelemetryPoints.length && e.code === 'ENOENT' && retries < 10) {
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

async function curl (url, useHttp2 = false) {
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
  const { GITHUB_WORKSPACE, ...rest } = process.env
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
  const { GITHUB_WORKSPACE, ...rest } = process.env
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

function assertObjectContains (actual, expected) {
  for (const [key, val] of Object.entries(expected)) {
    if (val !== null && typeof val === 'object') {
      assert.ok(key in actual)
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

module.exports = {
  FakeAgent,
  hookFile,
  assertObjectContains,
  assertUUID,
  spawnProc,
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
  sandboxCwd
}
