'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const DEFAULT_BASELINE = 'master'
const DEFAULT_CANDIDATE = 'bengl/native-spans-attempt-3'
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
  const tracer = require(process.env.BENCHMARK_TRACER_ROOT)
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
      tracer.trace('benchmark.aggregate', () => {
        return Promise.all([
          requestJson(catalogUrl, upstreamAgent),
          requestJson(pricingUrl, upstreamAgent),
        ]).then(([catalog, pricing]) => {
          return tracer.trace('benchmark.render', () => ({
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
    process.stdout.write(`${JSON.stringify({ port, nativeSpans: tracer._tracer?._useJsSpans === false })}\n`)
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
    request.setTimeout(5_000, () => request.destroy(new Error('third-party request timed out')))
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
          }
          request()
        }
        finish()
      })
    })
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('request timed out')))
    outgoing.once('error', () => {
      inFlight--
      if (!stopping) {
        failed++
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

  const repository = await gitRoot()
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-native-spans-'))
  const createdWorktrees = []
  let mockAgent
  let thirdPartyApis

  try {
    const baseline = await prepareVariant({
      label: 'master',
      ref: options.baseline,
      directory: options.baselineDirectory,
      repository,
      temporaryRoot,
      createdWorktrees,
    })
    const candidate = await prepareVariant({
      label: 'pr9139',
      ref: options.candidate,
      directory: options.candidateDirectory,
      repository,
      temporaryRoot,
      createdWorktrees,
    })

    mockAgent = await startMockAgent()
    if (options.workload === 'third-party') thirdPartyApis = await startThirdPartyApis()
    const modes = {
      master: await detectMode(baseline, mockAgent.port, options, thirdPartyApis),
      pr9139: await detectMode(candidate, mockAgent.port, options, thirdPartyApis),
    }
    if (!modes.pr9139.nativeSpans) {
      throw new Error(`Candidate ${candidate.sha} did not enable native spans:\n${modes.pr9139.stderr}`)
    }

    const variants = { master: baseline, pr9139: candidate }
    const records = []
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const order = repetition % 2 === 1 ? ['master', 'pr9139'] : ['pr9139', 'master']
      for (const label of order) {
        const result = await measure(variants[label], label, repetition, options, mockAgent, thirdPartyApis)
        records.push(result)
        printRecord(result)
      }
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
      variants: {
        master: { ref: options.baseline, sha: baseline.sha, nativeSpans: modes.master.nativeSpans },
        pr9139: { ref: options.candidate, sha: candidate.sha, nativeSpans: modes.pr9139.nativeSpans },
      },
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
    if (!options.keepWorktrees) {
      for (const worktree of createdWorktrees) {
        await run('git', ['worktree', 'remove', '--force', worktree], { cwd: repository, allowFailure: true })
      }
      fs.rmSync(temporaryRoot, { recursive: true, force: true })
    } else {
      print(`Worktrees retained under ${temporaryRoot}`)
    }
  }
}

function benchmarkOptions () {
  const values = {}
  const valueOptions = new Map([
    ['--baseline', 'baseline'],
    ['--candidate', 'candidate'],
    ['--baseline-dir', 'baselineDirectory'],
    ['--candidate-dir', 'candidateDirectory'],
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
    } else if (argument === '--keep-worktrees') {
      values.keepWorktrees = true
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
    baseline: values.baseline || DEFAULT_BASELINE,
    candidate: values.candidate || DEFAULT_CANDIDATE,
    baselineDirectory: values.baselineDirectory,
    candidateDirectory: values.candidateDirectory,
    repetitions: positiveInteger(values.repetitions || (smoke ? 1 : 5), 'repetitions'),
    warmupMs: positiveInteger(values.warmupMs || (smoke ? 1_000 : 10_000), 'warmup-ms'),
    durationMs: positiveInteger(values.durationMs || (smoke ? 3_000 : 30_000), 'duration-ms'),
    concurrency: positiveInteger(values.concurrency || (smoke ? 25 : 100), 'concurrency'),
    workload,
    output: values.output && path.resolve(values.output),
    keepWorktrees: values.keepWorktrees === true,
    help: values.help === true,
  }
}

function printHelp () {
  print(`Usage: npm run bench:native-spans:express -- [options]

Compares master with PR #9139 using the same Express app and an in-process mock agent.
Refs are resolved to immutable commits before setup. Measurements alternate execution order.

Options:
  --baseline <ref>       Baseline git ref (default: ${DEFAULT_BASELINE})
  --candidate <ref>      Candidate git ref (default: ${DEFAULT_CANDIDATE})
  --baseline-dir <path>  Use an installed baseline checkout instead of a temporary worktree
  --candidate-dir <path> Use an installed candidate checkout instead of a temporary worktree
  --repetitions <n>      Measurements per variant (default: 5)
  --warmup-ms <n>        Warmup per measurement (default: 10000)
  --duration-ms <n>      Measured duration per measurement (default: 30000)
  --concurrency <n>      Closed-loop HTTP concurrency (default: 100)
  --workload <name>      Workload: simple or third-party (default: simple)
  --output <path>        Results directory (default: a timestamped directory under /tmp)
  --smoke                One 1s warmup + 3s measurement at concurrency 25
  --keep-worktrees       Keep automatically-created worktrees for another run
  -h, --help             Show this help
`)
}

async function prepareVariant (options) {
  const { label, ref, directory, repository, temporaryRoot, createdWorktrees } = options
  if (directory) {
    const root = path.resolve(directory)
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    return { label, root, sha }
  }

  const sha = await resolveRef(repository, ref)
  const root = path.join(temporaryRoot, `${label}-${sha.slice(0, 12)}`)
  print(`Preparing ${label}: ${ref} -> ${sha}`)
  await run('git', ['worktree', 'add', '--detach', root, sha], { cwd: repository, inherit: true })
  createdWorktrees.push(root)
  await run('yarn', ['install', '--frozen-lockfile', '--non-interactive'], { cwd: root, inherit: true })
  return { label, root, sha }
}

async function resolveRef (repository, ref) {
  const direct = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repository,
    allowFailure: true,
  })
  if (direct.code === 0) return direct.stdout.trim()
  const remote = await run('git', ['rev-parse', '--verify', `origin/${ref}^{commit}`], {
    cwd: repository,
    allowFailure: true,
  })
  if (remote.code === 0) return remote.stdout.trim()
  throw new Error(`Git ref not found: ${ref}. Fetch it or pass --candidate-dir/--baseline-dir.`)
}

async function detectMode (variant, agentPort, options, thirdPartyApis) {
  const application = await startApplication(variant, agentPort, options, thirdPartyApis)
  await stopApplication(application.child)
  return { nativeSpans: application.nativeSpans, stderr: application.stderr() }
}

async function measure (variant, label, repetition, options, mockAgent, thirdPartyApis) {
  const application = await startApplication(variant, mockAgent.port, options, thirdPartyApis)
  try {
    const warmup = await executeLoad(application.port, options.warmupMs, options.concurrency)
    if (warmup.failed !== 0) throw new Error(`${label} warmup had ${warmup.failed} failed requests`)
    mockAgent.reset()
    const result = await executeLoad(application.port, options.durationMs, options.concurrency)
    if (result.failed !== 0) throw new Error(`${label} had ${result.failed} failed requests`)
    const agent = mockAgent.snapshot()
    if (agent.requests === 0 || agent.bytes === 0) throw new Error(`${label} exported no traces during measurement`)
    return { label, repetition, ...result, agentRequests: agent.requests, agentBytes: agent.bytes }
  } finally {
    await stopApplication(application.child)
  }
}

async function startApplication (variant, agentPort, options, thirdPartyApis) {
  const environment = benchmarkEnvironment(variant.root, agentPort, options, thirdPartyApis)
  const child = spawn(process.execPath, ['--require', path.join(variant.root, 'init.js'), __filename, 'app'], {
    cwd: variant.root,
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

function benchmarkEnvironment (root, agentPort, options, thirdPartyApis) {
  const environment = {
    ...process.env,
    BENCHMARK_TRACER_ROOT: root,
    BENCHMARK_CATALOG_URL: thirdPartyApis?.catalogUrl || '',
    BENCHMARK_PRICING_URL: thirdPartyApis?.pricingUrl || '',
    BENCHMARK_WORKLOAD: options.workload,
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
    NODE_PATH: path.join(root, 'node_modules'),
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
    delay(2_000).then(() => child.kill('SIGKILL')),
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
  const summary = {}
  for (const label of ['master', 'pr9139']) {
    const selected = records.filter(record => record.label === label)
    summary[label] = {
      requestsPerSecond: median(selected.map(record => record.requestsPerSecond)),
      medianMs: median(selected.map(record => record.medianMs)),
      p95Ms: median(selected.map(record => record.p95Ms)),
      p99Ms: median(selected.map(record => record.p99Ms)),
    }
  }
  summary.deltaPercent = {
    requestsPerSecond: percentage(summary.pr9139.requestsPerSecond, summary.master.requestsPerSecond),
    medianMs: percentage(summary.pr9139.medianMs, summary.master.medianMs),
    p95Ms: percentage(summary.pr9139.p95Ms, summary.master.p95Ms),
    p99Ms: percentage(summary.pr9139.p99Ms, summary.master.p99Ms),
  }
  return summary
}

function median (values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentage (candidate, baseline) {
  return (candidate / baseline - 1) * 100
}

function printRecord (record) {
  print(
    `${record.label} rep ${record.repetition}: ${record.requestsPerSecond.toFixed(0)} req/s, ` +
    `p50 ${record.medianMs.toFixed(2)} ms, p95 ${record.p95Ms.toFixed(2)} ms, ` +
    `p99 ${record.p99Ms.toFixed(2)} ms`
  )
}

function printSummary (summary) {
  print('\nMedian across repetitions:')
  print('variant       req/s     p50 ms   p95 ms   p99 ms')
  for (const label of ['master', 'pr9139']) {
    const metrics = summary[label]
    print(
      `${label.padEnd(10)} ${metrics.requestsPerSecond.toFixed(0).padStart(8)} ` +
      `${metrics.medianMs.toFixed(2).padStart(8)} ${metrics.p95Ms.toFixed(2).padStart(8)} ` +
      `${metrics.p99Ms.toFixed(2).padStart(8)}`
    )
  }
  const delta = summary.deltaPercent
  print(
    `PR delta  ${formatDelta(delta.requestsPerSecond).padStart(8)} ` +
    `${formatDelta(delta.medianMs).padStart(8)} ${formatDelta(delta.p95Ms).padStart(8)} ` +
    `${formatDelta(delta.p99Ms).padStart(8)}`
  )
}

function writeReport (outputDirectory, report) {
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  const { master, pr9139, deltaPercent } = report.summary
  const row = (label, metrics, percent = false) => {
    const suffix = percent ? '%' : ''
    const requests = percent ? metrics.requestsPerSecond.toFixed(2) : metrics.requestsPerSecond.toFixed(0)
    return `| ${label} | ${requests}${suffix} | ${metrics.medianMs.toFixed(2)}${suffix} | ` +
      `${metrics.p95Ms.toFixed(2)}${suffix} | ${metrics.p99Ms.toFixed(2)}${suffix} |`
  }
  const markdown = [
    `# PR #9139 Express ${report.configuration.workload} benchmark`,
    '',
    '| Variant | req/s | p50 ms | p95 ms | p99 ms |',
    '|---|---:|---:|---:|---:|',
    row('master', master),
    row('PR #9139', pr9139),
    row('delta', deltaPercent, true),
    '',
  ].join('\n')
  fs.writeFileSync(path.join(outputDirectory, 'summary.md'), markdown)
}

function formatDelta (value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
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

function gitRoot () {
  return run('git', ['rev-parse', '--show-toplevel']).then(result => result.stdout.trim())
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
