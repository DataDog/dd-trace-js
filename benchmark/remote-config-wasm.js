'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const { Agent, createServer, get } = require('node:http')
const { resolve } = require('node:path')
const { createHistogram, monitorEventLoopDelay, performance } = require('node:perf_hooks')

const cases = {
  unchanged: { files: 1, bytes: 1024, polls: 3500, warmup: 350 },
  single: { files: 1, bytes: 1024, polls: 1200, warmup: 150 },
  multi: { files: 24, bytes: 4096, polls: 300, warmup: 100 },
}

/**
 * @param {number} files
 * @param {number} bytes
 * @param {boolean} tracing
 */
function fixture (files, bytes, tracing) {
  return ['0.3', '0.7'].map(rate => {
    const targets = []
    const contents = []
    for (let index = 0; index < files; index++) {
      const path = `datadog/2/APM_TRACING/fixture-${index}/config`
      const payload = Buffer.from(JSON.stringify({
        sdk_config: { config: { DD_TRACE_SAMPLE_RATE: tracing ? '1' : rate } },
        service_target: { service: 'remote-config-bench' },
        padding: tracing ? rate.padEnd(bytes) : ' '.repeat(bytes),
      }))
      targets.push({
        path,
        length: payload.length,
        hashes: { sha256: createHash('sha256').update(payload).digest('hex') },
      })
      contents.push({ path, raw: payload.toString('base64') })
    }
    return {
      targets,
      files: JSON.stringify(contents),
      paths: JSON.stringify(contents.map(file => file.path)),
      bytes: targets.reduce((sum, target) => sum + target.length, 0),
    }
  })
}

/**
 * @param {keyof cases} workload
 * @param {boolean} tracing
 */
async function runAgent (workload, tracing) {
  const { files, bytes } = cases[workload]
  const replies = fixture(files, bytes, tracing)
  let polls = 0
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (tracing && request.url === '/info') {
      response.end('{"endpoints":["/v0.7/config","/v0.4/traces","/v0.5/traces"]}')
      return
    }
    if (tracing && request.url === '/dogstatsd/v2/proxy') {
      request.resume()
      response.end('{}')
      return
    }
    if (tracing && (request.url === '/v0.4/traces' || request.url === '/v0.5/traces')) {
      request.resume()
      request.once('end', () => {
        process.send({ traces: Number(request.headers['x-datadog-trace-count']) })
        response.end('{"rate_by_service":{"service:,env:":1}}')
      })
      return
    }
    assert.equal(request.url, '/v0.7/config')
    const chunks = []
    if (tracing) {
      request.on('data', chunk => chunks.push(chunk))
    } else {
      request.resume()
    }
    request.once('end', () => {
      const index = polls++
      if (tracing) {
        const { client } = JSON.parse(Buffer.concat(chunks))
        const states = client.state.config_states
        const expectedVersion = workload === 'unchanged' ? 1 : index
        const ack = states?.length === files &&
          states.every(state => state.apply_state === 2 && state.version === expectedVersion)
        process.send({ config: true, ack, count: states?.length, error: client.state.error })
      }
      if (workload === 'unchanged' && index > 0) {
        response.end('{}')
        return
      }
      const reply = replies[index % 2]
      const version = index + 1
      const targets = Object.fromEntries(reply.targets.map(({ path, length, hashes }) => [
        path, { length, hashes, custom: { v: version } },
      ]))
      const signed = { custom: { opaque_backend_state: 'benchmark-state' }, targets, version }
      const encoded = Buffer.from(JSON.stringify({ signed })).toString('base64')
      response.end(`{"targets":"${encoded}","target_files":${reply.files},"client_configs":${reply.paths}}`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  process.send({ url: `http://127.0.0.1:${server.address().port}`, bytes: replies[0].bytes })
  process.once('disconnect', () => server.close())
}

async function runTraceApp () {
  const tracer = require(process.env.DD_RC_BENCH_TRACER ?? '..')
    .init({ plugins: false, startupLogs: false, flushInterval: 250 })
  const server = createServer((request, response) => {
    tracer.trace('benchmark.request', { resource: request.method }, span => {
      span.setTag('http.status_code', 200)
      response.end('ok')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  process.send({ url: `http://127.0.0.1:${server.address().port}` })
  const [startSignal] = await once(process, 'message')
  assert.equal(startSignal, 'start')
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
  const start = process.cpuUsage()
  const [stopSignal] = await once(process, 'message')
  assert.equal(stopSignal, 'stop')
  const { user, system } = process.cpuUsage(start)
  delay.disable()
  process.send({
    appCpuUs: user + system,
    loopP99Ms: delay.percentile(99) / 1e6,
    loopP999Ms: delay.percentile(99.9) / 1e6,
  })
  server.close()
  process.disconnect()
}

/**
 * @param {string} url
 * @param {Agent} connectionPool
 * @param {number} durationMs
 */
async function loadTraceApp (url, connectionPool, durationMs) {
  const latency = createHistogram()
  const start = performance.now()
  const deadline = start + durationMs

  async function worker () {
    while (performance.now() < deadline) {
      const sent = process.hrtime.bigint()
      await new Promise((resolve, reject) => {
        const request = get(url, { agent: connectionPool }, response => {
          response.on('error', reject)
          response.once('end', () => {
            if (response.statusCode === 200) {
              resolve()
            } else {
              reject(new Error(`Request failed: ${response.statusCode}`))
            }
          })
          response.resume()
        })
        request.on('error', reject)
        request.setTimeout(5000, () => request.destroy(new Error('Request timed out')))
      })
      latency.record(process.hrtime.bigint() - sent)
    }
  }

  await Promise.all(Array.from({ length: 16 }, worker))
  return {
    requests: latency.count,
    requestsPerSecond: latency.count * 1000 / (performance.now() - start),
    p99Ms: latency.percentile(99) / 1e6,
    p999Ms: latency.percentile(99.9) / 1e6,
  }
}

/**
 * @param {'legacy' | 'wasm'} engine
 * @param {keyof cases} workload
 */
async function runTraceTrial (engine, workload) {
  const useDefaultInterval = process.env.DD_RC_BENCH_DEFAULT_INTERVAL === '1'
  const agent = fork(__filename, ['agent', workload, 'trace'], { execArgv: [] })
  const pool = new Agent({ keepAlive: true, maxSockets: 16 })
  let app
  let polls = 0
  let acks = 0
  let traces = 0
  let lastPoll
  agent.on('message', message => {
    if (message.config) {
      polls++
      lastPoll = message
    }
    if (message.ack) acks++
    traces += message.traces ?? 0
  })
  try {
    const [{ url }] = await once(agent, 'message')
    const path = engine === 'wasm' ? process.env.DD_RC_TEST_WASM : undefined
    if (engine === 'wasm') {
      assert.ok(path, 'Set DD_RC_TEST_WASM to the release artifact')
    }
    const tracerPath = engine === 'wasm' ? process.env.DD_RC_BENCH_WASM_TRACER : process.env.DD_RC_BENCH_LEGACY_TRACER
    const env = {
      ...process.env,
      DD_RC_BENCH_TRACER: tracerPath,
      DD_TRACE_AGENT_URL: url,
      DD_SERVICE: 'remote-config-bench',
      DD_AGENTLESS_ENABLED: 'false',
      DD_TRACE_SAMPLE_RATE: '1',
      DD_REMOTE_CONFIGURATION_ENABLED: 'true',
      DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: useDefaultInterval ? undefined : '0.25',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_TRACE_STATS_COMPUTATION_ENABLED: 'false',
      _DD_REMOTE_CONFIG_WASM_PATH: path,
    }
    app = fork(__filename, ['trace-app'], { env, execArgv: [] })
    const [{ url: appUrl }] = await once(app, 'message')
    await loadTraceApp(appUrl, pool, useDefaultInterval ? 11000 : 1000)
    assert.ok(acks > 0, `No Remote Config acknowledgment after ${polls} polls: ${JSON.stringify(lastPoll)}`)
    const startPolls = polls
    const startAcks = acks
    const startTraces = traces
    app.send('start')
    const load = await loadTraceApp(appUrl, pool, useDefaultInterval ? 21000 : 4000)
    app.send('stop')
    const [resource] = await once(app, 'message')
    assert.ok(acks - startAcks >= (useDefaultInterval ? 4 : 6), 'Too few acknowledged polls during HTTP load')
    assert.equal(acks - startAcks, polls - startPolls, JSON.stringify(lastPoll))
    assert.ok(traces - startTraces > load.requests / 2, 'Too few traces delivered to the Agent')
    process.stdout.write(`${JSON.stringify({
      engine,
      variant: process.env.DD_RC_BENCH_VARIANT ?? engine,
      workload,
      node: process.version,
      defaultPollInterval: useDefaultInterval,
      ...load,
      ...resource,
      polls: polls - startPolls,
      acks: acks - startAcks,
      traces: traces - startTraces,
    })}\n`)
  } finally {
    pool.destroy()
    app?.kill()
    agent.kill()
  }
}

/** @param {() => Promise<void> | void} operation */
async function measure (operation) {
  const cpu = process.cpuUsage()
  const started = performance.now()
  await operation()
  const { user, system } = process.cpuUsage(cpu)
  return { cpuUs: user + system, wallMs: performance.now() - started }
}

function memory () {
  global.gc()
  global.gc()
  const { heapUsed, external, rss } = process.memoryUsage()
  return { heapUsed, external, rss }
}

/**
 * @param {'legacy' | 'wasm'} engine
 * @param {keyof cases} workload
 */
async function runTrial (engine, workload) {
  const agent = fork(__filename, ['agent', workload], { execArgv: [] })
  try {
    const [{ url, bytes }] = await once(agent, 'message')
    const { polls, warmup } = cases[workload]
    process.env.DD_TRACE_AGENT_URL = url
    process.env.DD_SERVICE = 'remote-config-bench'
    process.env.DD_AGENTLESS_ENABLED = 'false'
    process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
    if (engine === 'legacy') {
      delete process.env._DD_REMOTE_CONFIG_WASM_PATH
    } else {
      assert.ok(process.env.DD_RC_TEST_WASM, 'Set DD_RC_TEST_WASM to the release artifact')
      process.env._DD_REMOTE_CONFIG_WASM_PATH = resolve(process.env.DD_RC_TEST_WASM)
    }
    globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }

    const initialMemory = memory()
    let client
    let config
    let installations = 0
    const load = await measure(() => {
      const root = engine === 'legacy' && process.env.DD_RC_BENCH_BASELINE !== undefined
        ? process.env.DD_RC_BENCH_BASELINE
        : resolve(__dirname, '..')
      const source = resolve(root, 'packages/dd-trace/src')
      const createConfig = require(`${source}/config`)
      const processTags = require(`${source}/process-tags`)
      const RemoteConfig = require(`${source}/remote_config`)
      const { enable } = require(`${source}/config/remote_config`)
      config = createConfig()
      processTags.initialize(config)
      client = new RemoteConfig(config)
      enable(client, config, () => { installations++ })
      client.scheduler.stop()
    })
    assert.equal(typeof client.watchValues === 'function', engine === 'wasm')
    const poll = () => new Promise(resolve => client.poll(resolve))
    const first = await measure(poll)
    assert.equal(config.sampleRate, 0.3)
    const firstMemory = memory()

    for (let index = 0; index < warmup; index++) await poll()
    const warmMemory = memory()
    const steady = await measure(async () => {
      for (let index = 0; index < polls; index++) await poll()
    })
    const finalMemory = memory()
    assert.equal(installations, workload === 'unchanged' ? 1 : 1 + warmup + polls)
    assert.equal(config.sampleRate, workload === 'unchanged' || (warmup + polls) % 2 === 0 ? 0.3 : 0.7)
    const result = {
      engine,
      variant: process.env.DD_RC_BENCH_VARIANT ?? engine,
      node: process.version,
      v8: process.versions.v8,
      workload,
      polls,
      bytes,
      loadCpuUs: load.cpuUs,
      firstCpuUs: first.cpuUs,
      firstWallMs: first.wallMs,
      cpuUsPerPoll: steady.cpuUs / polls,
      wallMsPerPoll: steady.wallMs / polls,
      initialMemory,
      firstMemory,
      warmMemory,
      finalMemory,
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    agent.disconnect()
  }
}

/**
 * @param {number} samples
 * @param {boolean} [tracing]
 * @param {string} [onlyWorkload]
 */
async function compare (samples, tracing, onlyWorkload) {
  assert.ok(Number.isSafeInteger(samples) && samples > 0)
  assert.ok(onlyWorkload === undefined || Object.hasOwn(cases, onlyWorkload), 'Unknown Remote Config workload')
  const artifacts = process.env.DD_RC_COMPARE_WASM === undefined
    ? [{ engine: 'legacy' }, { engine: 'wasm', path: process.env.DD_RC_TEST_WASM }]
    : [
        { engine: 'wasm', path: process.env.DD_RC_TEST_WASM, variant: 'size' },
        { engine: 'wasm', path: process.env.DD_RC_COMPARE_WASM, variant: 'speed' },
      ]
  const reversed = [artifacts[1], artifacts[0]]
  const workloads = onlyWorkload === undefined ? Object.keys(cases) : [onlyWorkload]
  for (const workload of workloads) {
    for (let sample = 0; sample < samples; sample++) {
      const order = sample % 2 === 0 ? artifacts : reversed
      for (const { engine, path, variant } of order) {
        const trial = fork(__filename, [engine, workload, ...(tracing ? ['trace'] : [])], {
          env: { ...process.env, DD_RC_TEST_WASM: path, DD_RC_BENCH_VARIANT: variant },
          execArgv: ['--expose-gc'],
        })
        const [code, signal] = await once(trial, 'exit')
        assert.equal(code, 0, `${engine}/${workload} exited with ${signal ?? code}`)
      }
    }
  }
}

function main () {
  const [mode, option, flag] = process.argv.slice(2)
  if (mode === 'compare') return compare(Number(option ?? 5))
  if (mode === 'trace-compare') return compare(Number(option ?? 5), true, flag)
  if (mode === 'trace-app') return runTraceApp()
  assert.ok(Object.hasOwn(cases, option), `Unknown Remote Config workload: ${option}`)
  if (mode === 'agent') return runAgent(option, flag === 'trace')
  assert.ok(mode === 'legacy' || mode === 'wasm', `Unknown Remote Config engine: ${mode}`)
  if (flag === 'trace') return runTraceTrial(mode, option)
  return runTrial(mode, option)
}

Promise.resolve().then(main).catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
