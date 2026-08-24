'use strict'

const tracer = require('dd-trace')
const path = require('node:path')

const jest = require('jest')

const testCyclePath = '/api/v2/citestcycle'
const runCount = Number(process.env.DD_REPRO_RUN_COUNT || 2)
const payloadSource = process.env.DD_REPRO_PAYLOAD_SOURCE || 'name'
const ddTraceRoot = path.dirname(require.resolve('dd-trace'))
const { version: ddTraceVersion } = require(path.join(ddTraceRoot, 'package.json'))
const agentsPath = path.join(
  ddTraceRoot,
  'packages/dd-trace/src/ci-visibility/exporters/agents'
)
const { getAgent } = require(agentsPath)
const intakeUrl = new URL(process.env.DD_CIVISIBILITY_AGENTLESS_URL)
const httpAgent = getAgent(intakeUrl)
const agentName = httpAgent.getName({
  host: intakeUrl.hostname,
  port: Number(intakeUrl.port),
})
const originalAddRequest = httpAgent.addRequest
const statistics = {
  attempts: 0,
  ddTraceVersion,
  errors: {},
  maxActiveSockets: 0,
  maxQueuedRequests: 0,
  maxSockets: httpAgent.maxSockets,
  maxSocketWaitMs: 0,
  responses: 0,
  socketAssignments: 0,
}
let printedFinalStatistics = false

function sampleAgent () {
  const activeSockets = httpAgent.sockets[agentName]?.length || 0
  const queuedRequests = httpAgent.requests[agentName]?.length || 0

  statistics.maxActiveSockets = Math.max(statistics.maxActiveSockets, activeSockets)
  statistics.maxQueuedRequests = Math.max(statistics.maxQueuedRequests, queuedRequests)
}

httpAgent.addRequest = function (request, options) {
  const requestedAt = Date.now()
  const isTestCycleRequest = options.path?.includes(testCyclePath)

  originalAddRequest.call(this, request, options)

  if (!isTestCycleRequest) return

  statistics.attempts++
  sampleAgent()

  request.once('socket', () => {
    statistics.socketAssignments++
    statistics.maxSocketWaitMs = Math.max(statistics.maxSocketWaitMs, Date.now() - requestedAt)
    sampleAgent()
  })
  request.once('response', () => {
    statistics.responses++
    sampleAgent()
  })
  request.once('error', (error) => {
    const errorType = error.code || error.name

    statistics.errors[errorType] = (statistics.errors[errorType] || 0) + 1
    sampleAgent()
  })
}

const sampleInterval = setInterval(sampleAgent, 10)
sampleInterval.unref()

function printFinalStatistics () {
  if (printedFinalStatistics) return

  printedFinalStatistics = true
  sampleAgent()
  process.stdout.write(`DD_REPRO_FINAL ${JSON.stringify(statistics)}\n`)
}

/**
 * Emits statistics after the tracer's existing final flush settles.
 *
 * @returns {void}
 */
function printStatisticsAfterFinalization () {
  tracer._tracer._exporter.flush(printFinalStatistics)
}

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(printStatisticsAfterFinalization)

async function runForPackage (runIndex) {
  process.env.LAGE_PACKAGE_NAME = `request-pressure-package-${runIndex}`

  const options = {
    cache: false,
    modulePathIgnorePatterns: ['<rootDir>/\\.bun/'],
    projects: [__dirname],
    runInBand: true,
    silent: true,
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/'],
    testRegex: /test\/jest-request-pressure\.js$/,
    testRunner: 'jest-circus/runner',
    verbose: false,
  }
  const startedAt = Date.now()
  const results = await jest.runCLI(options, options.projects)

  sampleAgent()
  process.stdout.write(`DD_REPRO_RUN ${JSON.stringify({
    durationMs: Date.now() - startedAt,
    payloadSource,
    run: runIndex,
    statistics: { ...statistics },
    success: results.results.success,
  })}\n`)

  return results.results.success
}

async function main () {
  let success = true

  for (let runIndex = 1; runIndex <= runCount; runIndex++) {
    success = await runForPackage(runIndex) && success
  }

  process.exitCode = success ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
