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
  await exec(`yarn pack --filename ${out}`) // TODO: cache this
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

module.exports = {
  FakeAgent,
  spawnProc,
  createSandbox,
  curl,
  curlAndAssertMessage,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
}
