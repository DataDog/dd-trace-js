'use strict'

const { promisify } = require('util')
const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const EventEmitter = require('events')
const childProcess = require('child_process')
const { fork } = childProcess
const exec = promisify(childProcess.exec)
const http = require('http')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const rimraf = promisify(require('rimraf'))
const id = require('../packages/dd-trace/src/id')
const upload = require('multer')()
const assert = require('assert')

const hookFile = 'dd-trace/loader-hook.mjs'

class FakeAgent extends EventEmitter {
  constructor (port = 0) {
    super()
    this.port = port
  }

  async start () {
    const app = express()
    app.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    app.use(bodyParser.json({ limit: Infinity, type: 'application/json' }))
    app.put('/v0.4/traces', (req, res) => {
      if (req.body.length === 0) return res.status(200).send()
      res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { codec })
      })
    })
    app.post('/profiling/v1/input', upload.any(), (req, res) => {
      res.status(200).send()
      this.emit('message', {
        headers: req.headers,
        payload: req.body,
        files: req.files
      })
    })
    app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
      res.status(200).send()
      this.emit('telemetry', {
        headers: req.headers,
        payload: req.body
      })
    })

    return new Promise((resolve, reject) => {
      const timeoutObj = setTimeout(() => {
        reject(new Error('agent timed out starting up'))
      }, 10000)
      this.server = http.createServer(app)
      this.server.on('error', reject)
      this.server.listen(this.port, () => {
        this.port = this.server.address().port
        clearTimeout(timeoutObj)
        resolve(this)
      })
    })
  }

  stop () {
    return new Promise((resolve) => {
      this.server.on('close', resolve)
      this.server.close()
    })
  }

  // **resolveAtFirstSuccess** - specific use case for Next.js (or any other future libraries)
  // where multiple payloads are generated, and only one is expected to have the proper span (ie next.request),
  // but it't not guaranteed to be the last one (so, expectedMessageCount would not be helpful).
  // It can still fail if it takes longer than `timeout` duration or if none pass the assertions (timeout still called)
  assertMessageReceived (fn, timeout, expectedMessageCount = 1, resolveAtFirstSuccess) {
    timeout = timeout || 5000
    let resultResolve
    let resultReject
    let msgCount = 0
    const errors = []

    const timeoutObj = setTimeout(() => {
      const errorsMsg = errors.length === 0 ? '' : `, additionally:\n${errors.map(e => e.stack).join('\n')}\n===\n`
      resultReject(new Error(`timeout${errorsMsg}`, { cause: { errors } }))
    }, timeout)

    const resultPromise = new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })

    const messageHandler = msg => {
      try {
        msgCount += 1
        fn(msg)
        if (resolveAtFirstSuccess || msgCount === expectedMessageCount) {
          resultResolve()
          this.removeListener('message', messageHandler)
        }
      } catch (e) {
        errors.push(e)
      }
    }
    this.on('message', messageHandler)

    return resultPromise
  }

  assertTelemetryReceived (fn, timeout, requestType, expectedMessageCount = 1) {
    timeout = timeout || 5000
    let resultResolve
    let resultReject
    let msgCount = 0
    const errors = []

    const timeoutObj = setTimeout(() => {
      const errorsMsg = errors.length === 0 ? '' : `, additionally:\n${errors.map(e => e.stack).join('\n')}\n===\n`
      resultReject(new Error(`timeout${errorsMsg}`, { cause: { errors } }))
    }, timeout)

    const resultPromise = new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })

    const messageHandler = msg => {
      if (msg.payload.request_type !== requestType) return
      msgCount += 1
      try {
        fn(msg)
        if (msgCount === expectedMessageCount) {
          resultResolve()
        }
      } catch (e) {
        errors.push(e)
      }
      if (msgCount === expectedMessageCount) {
        this.removeListener('telemetry', messageHandler)
      }
    }
    this.on('telemetry', messageHandler)

    return resultPromise
  }
}

async function runAndCheckOutput (filename, cwd, expectedOut) {
  const proc = fork(filename, { cwd, stdio: 'pipe' })
  const pid = proc.pid
  let out = await new Promise((resolve, reject) => {
    proc.on('error', reject)
    let out = Buffer.alloc(0)
    proc.stdout.on('data', data => {
      out = Buffer.concat([out, data])
    })
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
      language_version: process.env.FAKE_VERSION || process.versions.node,
      runtime_name: 'nodejs',
      runtime_version: process.env.FAKE_VERSION || process.versions.node,
      tracer_version: require('../package.json').version,
      pid: Number(pid)
    }
  }
}

function spawnProc (filename, options = {}, stdioHandler) {
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

  await fs.mkdir(folder)
  await exec(`yarn pack --filename ${out}`, { env: restOfEnv }) // TODO: cache this
  await exec(`yarn add ${allDependencies.join(' ')}`, { cwd: folder, env: restOfEnv })

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
    await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules/', { flush: true })
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
    path.join(__dirname, 'telemetry-forwarder.sh')
  process.env.FORWARDER_OUT = path.join(__dirname, `forwarder-${Date.now()}.out`)

  let retries = 0

  const tryAgain = async function () {
    retries += 1
    await new Promise(resolve => setTimeout(resolve, 100))
    return cleanup()
  }

  const cleanup = async function () {
    let msgs
    try {
      msgs = (await fs.readFile(process.env.FORWARDER_OUT, 'utf8')).trim().split('\n')
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
    await fs.unlink(process.env.FORWARDER_OUT)
    delete process.env.FORWARDER_OUT
    delete process.env.DD_TELEMETRY_FORWARDER_PATH
    return msgs
  }

  return cleanup
}

async function curl (url, useHttp2 = false) {
  if (typeof url === 'object') {
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
  env = { ...env, ...additionalEnvArgs }
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

module.exports = {
  FakeAgent,
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
