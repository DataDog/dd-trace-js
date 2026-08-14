'use strict'

/* eslint-disable eslint-rules/eslint-process-env -- standalone CLI benchmark, not a config consumer */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const REPOSITORY_ROOT = __dirname
const HISTOGRAM_RESOLUTION = 100
const HISTOGRAM_MAX_MS = 600

const mode = process.argv[2]
if (mode === 'app') {
  runApp()
} else if (mode === 'upstreams') {
  runUpstreams()
} else if (mode === 'load') {
  runLoad()
} else {
  main().catch(error => {
    printError(error.stack || error)
    process.exitCode = 1
  })
}

function runApp () {
  const noTracer = process.env.BENCHMARK_NO_TRACER === 'true'
  const tracer = noTracer ? undefined : require(process.env.BENCHMARK_TRACER_ROOT)
  const trace = noTracer ? (_name, work) => work() : (name, work) => tracer.trace(name, work)
  const express = require('express')
  const app = express()
  let upstreamAgent

  if (process.env.BENCHMARK_WORKLOAD === 'third-party') {
    const catalogUrl = new URL(process.env.BENCHMARK_CATALOG_URL)
    const pricingUrl = new URL(process.env.BENCHMARK_PRICING_URL)
    upstreamAgent = new http.Agent({ keepAlive: true })

    app.use(function identifyRequest (_request, _response, next) {
      next()
    })
    app.use(function applyResponseHeaders (_request, response, next) {
      response.setHeader('x-benchmark-workload', 'third-party')
      next()
    })
    app.get('/', (_request, response, next) => {
      trace('benchmark.aggregate', () => {
        return Promise.all([
          requestJson(catalogUrl, upstreamAgent),
          requestJson(pricingUrl, upstreamAgent),
        ]).then(([catalog, pricing]) => {
          return trace('benchmark.render', () => ({
            currency: pricing.currency,
            itemCount: catalog.items.length,
            total: catalog.items[0].price * (1 - pricing.discount),
          }))
        })
      }).then(result => response.json(result), next)
    })
  } else {
    app.get('/', (_request, response) => response.send('hello world'))
  }

  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    const nativeSpans = noTracer ? undefined : tracer._tracer?._useJsSpans === false
    process.stdout.write(`${JSON.stringify({ port, nativeSpans })}\n`)
  })
  process.once('SIGTERM', () => {
    server.close()
    upstreamAgent?.destroy()
  })
}

/**
 * Fetch and decode one local third-party API response.
 *
 * @param {URL} url
 * @param {http.Agent} agent
 * @returns {Promise<Record<string, unknown>>}
 */
function requestJson (url, agent) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Third-party API returned ${response.statusCode}`))
          return
        }
        resolve(JSON.parse(body))
      })
    })
    request.setTimeout(5000, () => request.destroy(new Error('third-party request timed out')))
    request.once('error', reject)
  })
}

/**
 * Serve two deterministic uninstrumented APIs on separate local ports.
 *
 * @returns {void}
 */
function runUpstreams () {
  const catalogBody = Buffer.from('{"items":[{"id":"sku-1","price":42},{"id":"sku-2","price":17}]}')
  const pricingBody = Buffer.from('{"currency":"USD","discount":0.15}')
  const catalog = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(catalogBody)
  })
  const pricing = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(pricingBody)
  })
  let ready = 0
  const announce = () => {
    ready++
    if (ready !== 2) return
    process.stdout.write(`${JSON.stringify({
      port: catalog.address().port,
      pricingPort: pricing.address().port,
    })}\n`)
  }
  catalog.listen(0, '127.0.0.1', announce)
  pricing.listen(0, '127.0.0.1', announce)
  process.once('SIGTERM', () => {
    catalog.close()
    pricing.close()
  })
}

function runLoad () {
  const target = new URL(process.argv[3])
  const durationMs = positiveInteger(process.argv[4], 'duration')
  const concurrency = positiveInteger(process.argv[5], 'concurrency')
  const histogram = new Uint32Array(HISTOGRAM_MAX_MS * HISTOGRAM_RESOLUTION + 1)
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
  const startedAt = performance.now()
  let completed = 0
  let failed = 0
  let inFlight = 0
  let stopping = false
  let stoppedAt
  let lastFailureReason

  const finish = () => {
    if (!stopping || inFlight !== 0) return
    agent.destroy()
    const elapsedSeconds = (stoppedAt - startedAt) / 1000
    process.stdout.write(`${JSON.stringify({
      requestsPerSecond: completed / elapsedSeconds,
      medianMs: percentile(histogram, completed, 0.5),
      p95Ms: percentile(histogram, completed, 0.95),
      p99Ms: percentile(histogram, completed, 0.99),
      completed,
      failed,
      lastFailureReason,
      elapsedSeconds,
    })}\n`)
  }

  const request = () => {
    if (stopping) return
    const requestStartedAt = performance.now()
    inFlight++
    const outgoing = http.get(target, { agent }, response => {
      response.resume()
      response.once('end', () => {
        inFlight--
        if (!stopping) {
          if (response.statusCode === 200) {
            completed++
            record(histogram, performance.now() - requestStartedAt)
          } else {
            failed++
            lastFailureReason = `HTTP ${response.statusCode}`
          }
          request()
        }
        finish()
      })
    })
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('request timed out')))
    outgoing.once('error', error => {
      inFlight--
      if (!stopping) {
        failed++
        lastFailureReason = error.message
        request()
      }
      finish()
    })
  }

  for (let index = 0; index < concurrency; index++) request()
  setTimeout(() => {
    stopping = true
    stoppedAt = performance.now()
    finish()
  }, durationMs)
}

function record (histogram, durationMs) {
  const bucket = Math.min(histogram.length - 1, Math.round(durationMs * HISTOGRAM_RESOLUTION))
  histogram[bucket]++
}

function percentile (histogram, count, quantile) {
  if (count === 0) return 0
  const target = Math.ceil(count * quantile)
  let seen = 0
  for (let bucket = 0; bucket < histogram.length; bucket++) {
    seen += histogram[bucket]
    if (seen >= target) return bucket / HISTOGRAM_RESOLUTION
  }
  return HISTOGRAM_MAX_MS
}

async function main () {
  const options = benchmarkOptions()
  if (options.help) {
    printHelp()
    return
  }

  let mockAgent
  let thirdPartyApis

  try {
    mockAgent = await startMockAgent()
    if (options.workload === 'third-party') thirdPartyApis = await startThirdPartyApis()

    const detected = await detectMode(mockAgent.port, options, thirdPartyApis)
    if (!options.noTracer && !detected.nativeSpans) {
      print(`Warning: native spans are disabled on this checkout (${await currentBranch()}).`)
    }

    const records = []
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      // Repetitions must run one at a time: each spins up its own app process and load generator.
      // eslint-disable-next-line no-await-in-loop
      const result = await measure(repetition, options, mockAgent, thirdPartyApis)
      records.push(result)
      printRecord(result)
    }

    const summary = summarize(records)
    const report = {
      generatedAt: new Date().toISOString(),
      command: [process.execPath, ...process.argv.slice(1)],
      environment: environmentInfo(),
      configuration: {
        repetitions: options.repetitions,
        warmupMs: options.warmupMs,
        durationMs: options.durationMs,
        concurrency: options.concurrency,
        workload: options.workload,
      },
      branch: await currentBranch(),
      sha: await currentSha(),
      tracer: options.noTracer ? 'none' : (detected.nativeSpans ? 'native' : 'js'),
      records,
      summary,
    }
    const outputDirectory = options.output || defaultOutputDirectory()
    writeReport(outputDirectory, report)
    printSummary(summary)
    print(`\nResults: ${outputDirectory}`)
  } finally {
    if (thirdPartyApis) await stopApplication(thirdPartyApis.child)
    if (mockAgent) await mockAgent.close()
  }
}

function benchmarkOptions () {
  const values = {}
  const valueOptions = new Map([
    ['--repetitions', 'repetitions'],
    ['--warmup-ms', 'warmupMs'],
    ['--duration-ms', 'durationMs'],
    ['--concurrency', 'concurrency'],
    ['--workload', 'workload'],
    ['--output', 'output'],
  ])
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index]
    if (argument === '--smoke') {
      values.smoke = true
    } else if (argument === '--no-tracer') {
      values.noTracer = true
    } else if (argument === '--help' || argument === '-h') {
      values.help = true
    } else if (valueOptions.has(argument)) {
      const value = process.argv[++index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      values[valueOptions.get(argument)] = value
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }

  const workload = values.workload || 'simple'
  if (workload !== 'simple' && workload !== 'third-party') {
    throw new Error('workload must be simple or third-party')
  }
  const smoke = values.smoke === true
  return {
    repetitions: positiveInteger(values.repetitions || (smoke ? 1 : 5), 'repetitions'),
    warmupMs: positiveInteger(values.warmupMs || (smoke ? 1000 : 10_000), 'warmup-ms'),
    durationMs: positiveInteger(values.durationMs || (smoke ? 3000 : 30_000), 'duration-ms'),
    concurrency: positiveInteger(values.concurrency || (smoke ? 25 : 100), 'concurrency'),
    workload,
    output: values.output && path.resolve(values.output),
    noTracer: values.noTracer === true,
    help: values.help === true,
  }
}

function printHelp () {
  print(`Usage: node native-spans-bench.js -- [options]

Benchmarks the Express app against the checked-out working tree (current branch).
Run once per branch and compare the printed/summary numbers manually.

Options:
  --repetitions <n>      Measurements to take (default: 5)
  --warmup-ms <n>        Warmup per measurement (default: 10000)
  --duration-ms <n>      Measured duration per measurement (default: 30000)
  --concurrency <n>      Closed-loop HTTP concurrency (default: 100)
  --workload <name>      Workload: simple or third-party (default: simple)
  --output <path>        Results directory (default: a timestamped directory under /tmp)
  --no-tracer            Run the app without loading the tracer at all (control baseline)
  --smoke                One 1s warmup + 3s measurement at concurrency 25
  -h, --help             Show this help
`)
}

async function detectMode (agentPort, options, thirdPartyApis) {
  const application = await startApplication(agentPort, options, thirdPartyApis)
  await stopApplication(application.child)
  return { nativeSpans: application.nativeSpans, stderr: application.stderr() }
}

async function measure (repetition, options, mockAgent, thirdPartyApis) {
  const application = await startApplication(mockAgent.port, options, thirdPartyApis)
  try {
    const warmup = await executeLoad(application.port, options.warmupMs, options.concurrency)
    if (warmup.failed !== 0) {
      throw new Error(
        `warmup had ${warmup.failed} failed requests (last: ${warmup.lastFailureReason})\n` +
        `App stderr:\n${application.stderr()}`
      )
    }
    mockAgent.reset()
    const result = await executeLoad(application.port, options.durationMs, options.concurrency)
    if (result.failed !== 0) {
      throw new Error(
        `measurement had ${result.failed} failed requests (last: ${result.lastFailureReason})\n` +
        `App stderr:\n${application.stderr()}`
      )
    }
    const agent = mockAgent.snapshot()
    if (!options.noTracer && (agent.requests === 0 || agent.bytes === 0)) {
      throw new Error('exported no traces during measurement')
    }
    return { repetition, ...result, agentRequests: agent.requests, agentBytes: agent.bytes }
  } finally {
    await stopApplication(application.child)
  }
}

async function startApplication (agentPort, options, thirdPartyApis) {
  const environment = benchmarkEnvironment(agentPort, options, thirdPartyApis)
  const args = options.noTracer
    ? [__filename, 'app']
    : ['--require', path.join(REPOSITORY_ROOT, 'init.js'), __filename, 'app']
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  const readiness = await waitForApplication(child, () => stdout, () => stderr)
  return { child, ...readiness, stderr: () => stderr }
}

function benchmarkEnvironment (agentPort, options, thirdPartyApis) {
  const environment = {
    ...process.env,
    BENCHMARK_TRACER_ROOT: REPOSITORY_ROOT,
    BENCHMARK_CATALOG_URL: thirdPartyApis?.catalogUrl || '',
    BENCHMARK_PRICING_URL: thirdPartyApis?.pricingUrl || '',
    BENCHMARK_WORKLOAD: options.workload,
    BENCHMARK_NO_TRACER: options.noTracer ? 'true' : '',
    DD_ENV: 'benchmark',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_PROFILING_ENABLED: 'false',
    DD_SERVICE: 'native-spans-express-benchmark',
    DD_TRACE_AGENT_URL: `http://127.0.0.1:${agentPort}`,
    DD_TRACE_DEBUG: 'false',
    DD_TRACE_RUNTIME_METRICS_ENABLED: 'false',
    DD_TRACE_STARTUP_LOGS: 'false',
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
    NODE_PATH: path.join(REPOSITORY_ROOT, 'node_modules'),
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OTEL_')) delete environment[key]
  }
  return environment
}

function waitForApplication (child, stdout, stderr) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Application readiness timed out:\n${stderr()}`)), 10_000)
    const check = () => {
      const line = stdout().split('\n').find(value => value.startsWith('{"port":'))
      if (!line) return
      clearTimeout(timeout)
      resolve(JSON.parse(line))
    }
    child.stdout.on('data', check)
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Application exited during startup with code ${code}:\n${stderr()}`))
    })
    check()
  })
}

async function stopApplication (child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(2000).then(() => child.kill('SIGKILL')),
  ])
}

/**
 * Start the deterministic APIs without tracer preloading.
 *
 * @returns {Promise<{child: import('node:child_process').ChildProcess, catalogUrl: string, pricingUrl: string}>}
 */
async function startThirdPartyApis () {
  const environment = { ...process.env, DD_TRACE_ENABLED: 'false', NODE_OPTIONS: '' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OTEL_')) delete environment[key]
  }
  const child = spawn(process.execPath, [__filename, 'upstreams'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const readiness = await waitForApplication(child, () => stdout, () => stderr)
  return {
    child,
    catalogUrl: `http://127.0.0.1:${readiness.port}/catalog`,
    pricingUrl: `http://127.0.0.1:${readiness.pricingPort}/pricing`,
  }
}

async function executeLoad (port, durationMs, concurrency) {
  const environment = { ...process.env, DD_TRACE_ENABLED: 'false', NODE_OPTIONS: '' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OTEL_')) delete environment[key]
  }
  const { stdout } = await run(process.execPath, [
    __filename,
    'load',
    `http://127.0.0.1:${port}/`,
    String(durationMs),
    String(concurrency),
  ], { env: environment })
  return JSON.parse(stdout)
}

function startMockAgent () {
  let requests = 0
  let bytes = 0
  const server = http.createServer((request, response) => {
    requests++
    request.on('data', chunk => { bytes += chunk.length })
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"rate_by_service":{}}')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        reset: () => { requests = 0; bytes = 0 },
        snapshot: () => ({ requests, bytes }),
        close: () => new Promise(resolve => server.close(resolve)),
      })
    })
  })
}

function summarize (records) {
  return {
    requestsPerSecond: median(records.map(record => record.requestsPerSecond)),
    medianMs: median(records.map(record => record.medianMs)),
    p95Ms: median(records.map(record => record.p95Ms)),
    p99Ms: median(records.map(record => record.p99Ms)),
  }
}

function median (values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function printRecord (record) {
  print(
    `rep ${record.repetition}: ${record.requestsPerSecond.toFixed(0)} req/s, ` +
    `p50 ${record.medianMs.toFixed(2)} ms, p95 ${record.p95Ms.toFixed(2)} ms, ` +
    `p99 ${record.p99Ms.toFixed(2)} ms`
  )
}

function printSummary (summary) {
  print('\nMedian across repetitions:')
  print('req/s     p50 ms   p95 ms   p99 ms')
  print(
    `${summary.requestsPerSecond.toFixed(0).padStart(8)} ` +
    `${summary.medianMs.toFixed(2).padStart(8)} ${summary.p95Ms.toFixed(2).padStart(8)} ` +
    summary.p99Ms.toFixed(2).padStart(8)
  )
}

function writeReport (outputDirectory, report) {
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function print (value) {
  process.stdout.write(`${value}\n`)
}

function printError (value) {
  process.stderr.write(`${value}\n`)
}

function environmentInfo () {
  const [cpu] = os.cpus()
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: cpu?.model,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  }
}

function defaultOutputDirectory () {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
  return path.join(os.tmpdir(), 'dd-trace-native-spans-benchmark', timestamp)
}

function positiveInteger (value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function currentBranch () {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPOSITORY_ROOT })
    .then(result => result.stdout.trim())
}

function currentSha () {
  return run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }).then(result => result.stdout.trim())
}

function run (command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}:\n${stdout}\n${stderr}`))
    })
  })
}
