'use strict'

const { randomUUID } = require('node:crypto')
const { workerData: { probePort } } = require('node:worker_threads')
const { ACKNOWLEDGED, ERROR } = require('../../remote_config/apply_states')
const { addBreakpoint, removeBreakpoint, modifyBreakpoint } = require('./breakpoints')
const { ackReceived, ackInstalled, ackError } = require('./status')
const config = require('./config')
const log = require('./log')

const LIVE_DEBUGGING = 'LIVE_DEBUGGING'
const LIVE_DEBUGGING_CAPABILITIES = [
  'APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION',
  'APM_TRACING_ENABLE_LIVE_DEBUGGING',
]

// Example log line probe with captureSnapshot (simplified):
// {
//   id: '100c9a5c-45ad-49dc-818b-c570d31e11d1',
//   version: 0,
//   type: 'LOG_PROBE',
//   where: { sourceFile: 'index.js', lines: ['25'] }, // only use first array element
//   template: 'Hello World 2',
//   segments: [...],
//   captureSnapshot: true,
//   capture: { maxReferenceDepth: 1 },
//   sampling: { snapshotsPerSecond: 1 },
//   evaluateAt: 'EXIT' // only used for method probes
// }
//
// Example log line probe with captureExpressions (simplified):
// Note: captureSnapshot and captureExpressions are mutually exclusive
// {
//   id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
//   version: 0,
//   type: 'LOG_PROBE',
//   where: { sourceFile: 'index.js', lines: ['25'] },
//   template: 'Captured expressions',
//   segments: [{ str: 'Captured expressions' }],
//   captureExpressions: [
//     { name: 'myVar', expr: { dsl: 'myVar', json: { ref: 'myVar' } }, capture: { maxReferenceDepth: 2 } },
//     { name: 'obj.foo', expr: { dsl: 'obj.foo', json: { getmember: [{ ref: 'obj' }, 'foo'] } } }
//   ],
//   capture: { maxReferenceDepth: 3 }, // default limits for expressions without explicit capture
//   sampling: { snapshotsPerSecond: 1 }
// }
//
// Example log method probe (simplified):
// {
//   id: 'd692ee6d-5734-4df7-9d86-e3bc6449cc8c',
//   version: 0,
//   type: 'LOG_PROBE',
//   where: { typeName: 'index.js', methodName: 'handlerA' },
//   template: 'Executed index.js.handlerA, it took {@duration}ms',
//   segments: [...],
//   captureSnapshot: false,
//   capture: { maxReferenceDepth: 3 },
//   sampling: { snapshotsPerSecond: 5000 },
//   evaluateAt: 'EXIT' // only used for method probes
// }
probePort.on('message', async ({ action, probe, ackId }) => {
  try {
    await processMsg(action, probe)
    probePort.postMessage({ ackId })
  } catch (err) {
    probePort.postMessage({ ackId, error: err })
    ackError(err, probe)
  }
})
probePort.on(
  'messageerror',
  (err) => log.error('[debugger:devtools_client] received "messageerror" on probe port', err)
)

if (config.agentless) startAgentlessRemoteConfig()

/**
 * Starts polling the agentless Remote Config intake for debugger probes.
 *
 * @returns {void}
 */
function startAgentlessRemoteConfig () {
  try {
    const { RemoteConfigFetcher } = require('@datadog/libdatadog')
    const { retryIntervalMs, ...options } = config.remoteConfig
    const fetcher = new RemoteConfigFetcher({ clientId: randomUUID(), ...options })
    const unknown = fetcher.setProductCapabilities([LIVE_DEBUGGING], LIVE_DEBUGGING_CAPABILITIES)

    if (unknown.length > 0) {
      log.warn('[debugger:devtools_client] Unknown agentless Remote Config values: %s', unknown.join(', '))
    }

    pollAgentlessRemoteConfig(fetcher, new Map(), retryIntervalMs)
  } catch (error) {
    log.error('[debugger:devtools_client] Unable to start agentless Remote Config', error)
  }
}

/**
 * Polls continuously for agentless debugger configuration changes.
 *
 * @param {import('@datadog/libdatadog').RemoteConfigFetcher} fetcher - Remote Config fetcher
 * @param {Map<string, object>} probes - Applied probes by configuration path
 * @param {number} retryIntervalMs - Delay after a failed fetch
 * @returns {Promise<void>}
 */
async function pollAgentlessRemoteConfig (fetcher, probes, retryIntervalMs) {
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const changes = await fetcher.fetchChanges()
      for (const change of changes) {
        // Remote Config changes must be applied in order.
        // eslint-disable-next-line no-await-in-loop
        await applyAgentlessChange(fetcher, probes, change)
      }
    } catch (error) {
      log.error('[debugger:devtools_client] Error fetching agentless Remote Config', error)
      // eslint-disable-next-line no-await-in-loop
      await waitForRetry(retryIntervalMs)
    }
  }
}

/**
 * Applies one agentless debugger configuration change and reports its state.
 *
 * @param {import('@datadog/libdatadog').RemoteConfigFetcher} fetcher - Remote Config fetcher
 * @param {Map<string, object>} probes - Applied probes by configuration path
 * @param {import('@datadog/libdatadog').RemoteConfigChange} change - Remote Config change
 * @returns {Promise<void>}
 */
async function applyAgentlessChange (fetcher, probes, change) {
  let probe

  try {
    if (change.kind === 'remove') {
      probe = probes.get(change.path)
      if (probe === undefined) {
        fetcher.setConfigState(change.path, ACKNOWLEDGED)
        return
      }
    } else {
      if (change.contents === undefined) throw new Error(`Missing contents for ${change.path}`)
      probe = JSON.parse(change.contents)
    }

    const action = change.kind === 'add' ? 'apply' : change.kind === 'update' ? 'modify' : 'unapply'
    await processMsg(action, probe)

    if (change.kind === 'remove') {
      probes.delete(change.path)
    } else {
      probes.set(change.path, probe)
    }
    fetcher.setConfigState(change.path, ACKNOWLEDGED)
  } catch (error) {
    fetcher.setConfigState(change.path, ERROR, error.toString())
    if (probe !== undefined) ackError(error, probe)
  }
}

/**
 * Waits before retrying an agentless Remote Config request.
 *
 * @param {number} delayMs - Retry delay
 * @returns {Promise<void>}
 */
function waitForRetry (delayMs) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, delayMs)
    timeout.unref?.()
  })
}

async function processMsg (action, probe) {
  log.debug(
    '[debugger:devtools_client] Received request to %s %s probe (id: %s, version: %d)',
    action, probe.type, probe.id, probe.version
  )

  if (action !== 'unapply') ackReceived(probe)

  if (probe.type !== 'LOG_PROBE') {
    throw new Error(`Unsupported probe type: ${probe.type} (id: ${probe.id}, version: ${probe.version})`)
  }
  if (!probe.where.sourceFile && !probe.where.lines) {
    throw new Error(
      // eslint-disable-next-line @stylistic/max-len
      `Unsupported probe insertion point! Only line-based probes are supported (id: ${probe.id}, version: ${probe.version})`
    )
  }
  if (probe.captureSnapshot && probe.captureExpressions?.length > 0) {
    throw new Error(
      `Cannot set both captureSnapshot and captureExpressions (probe: ${probe.id}, version: ${probe.version})`
    )
  }

  switch (action) {
    case 'unapply':
      await removeBreakpoint(probe)
      break
    case 'apply':
      await addBreakpoint(probe)
      ackInstalled(probe)
      break
    case 'modify':
      await modifyBreakpoint(probe)
      ackInstalled(probe)
      break
    default:
      throw new Error(
        `Cannot process probe ${probe.id} (version: ${probe.version}) - unknown remote configuration action: ${action}`
      )
  }
}
