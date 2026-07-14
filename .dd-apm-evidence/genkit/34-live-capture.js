'use strict'

const fs = require('node:fs')
const path = require('node:path')

const agent = require('../../packages/dd-trace/test/plugins/agent')

const evidenceDirectory = __dirname
const sampleDirectory = path.join(evidenceDirectory, '09-sample-app')
const samplePath = path.join(sampleDirectory, 'sample-app.js')
const resultsPath = path.join(evidenceDirectory, '34-sample-results.json')
const apmPath = path.join(evidenceDirectory, '34-apm-traces.json')
const llmobsPath = path.join(evidenceDirectory, '34-llmobs-requests.json')
const capturePath = path.join(evidenceDirectory, '34-capture-summary.json')

const rawApmRequests = []

function serialize (value) {
  return `${JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString()
    if (Buffer.isBuffer(item)) return item.toString('hex')
    return item
  }, 2)}\n`
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForFile (filePath, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await delay(25)
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

function countApmSpans () {
  let count = 0
  for (const request of rawApmRequests) {
    for (const trace of request) count += trace.length
  }
  return count
}

function getLlmObsRequests () {
  return agent.getLlmObsSpanEventsRequests()
}

function countLlmObsSpans () {
  let count = 0
  for (const request of getLlmObsRequests()) {
    for (const eventRequest of request) count += eventRequest.spans.length
  }
  return count
}

async function waitForTelemetryToStabilize (timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  let previous = ''
  let stableIterations = 0

  while (Date.now() < deadline) {
    const current = `${countApmSpans()}:${countLlmObsSpans()}`
    if (current === previous && countApmSpans() > 0 && countLlmObsSpans() > 0) {
      stableIterations++
      if (stableIterations === 20) return
    } else {
      stableIterations = 0
      previous = current
    }
    await delay(50)
  }
  throw new Error(`telemetry did not stabilize (APM=${countApmSpans()}, LLMObs=${countLlmObsSpans()})`)
}

async function main () {
  for (const filePath of [resultsPath, apmPath, llmobsPath, capturePath]) {
    fs.rmSync(filePath, { force: true })
  }

  process.env.RESULTS_PATH = resultsPath
  process.env._DD_LLMOBS_FLUSH_INTERVAL = '0'

  agent.subscribe(traces => {
    rawApmRequests.push(traces)
  })

  const tracer = await agent.load('genkit', {}, {
    llmobs: {
      agentlessEnabled: false,
      mlApp: 'genkit-live-sample',
    },
  })

  console.log(JSON.stringify({
    capture: 'started',
    ddTraceVersion: require('../../package.json').version,
    otelEnabled: process.env.DD_TRACE_OTEL_ENABLED === 'true',
    samplePath,
    tracerAgentPort: agent.port,
  }))

  require(samplePath)
  await waitForFile(resultsPath, 20000)
  await waitForTelemetryToStabilize(20000)

  const llmobsRequests = getLlmObsRequests()
  const sampleResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
  const capture = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceDiffSha256: process.env.SOURCE_DIFF_SHA256,
    package: sampleResults.package,
    version: sampleResults.version,
    ddTraceVersion: require('../../package.json').version,
    nodeVersion: process.version,
    otelEnabled: process.env.DD_TRACE_OTEL_ENABLED === 'true',
    samplePath,
    sampleOperationCount: sampleResults.operations.length,
    unexpectedErrorCount: sampleResults.unexpectedErrorCount,
    apmRequestCount: rawApmRequests.length,
    apmSpanCount: countApmSpans(),
    llmobsRequestCount: llmobsRequests.length,
    llmobsSpanCount: countLlmObsSpans(),
  }

  fs.writeFileSync(apmPath, serialize(rawApmRequests))
  fs.writeFileSync(llmobsPath, serialize(llmobsRequests))
  fs.writeFileSync(capturePath, serialize(capture))
  console.log(JSON.stringify({ capture: 'complete', ...capture }))

  await tracer.llmobs.flush()
  await agent.close()
}

main().catch(async error => {
  console.error(error)
  try {
    await agent.close()
  } catch {}
  process.exitCode = 1
})
