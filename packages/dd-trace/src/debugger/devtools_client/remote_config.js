'use strict'

const { workerData: { probePort } } = require('node:worker_threads')
const { addBreakpoint, removeBreakpoint, modifyBreakpoint } = require('./breakpoints')
const { ackReceived, ackInstalled, ackError } = require('./status')
const log = require('./log')

// Example log line probe (simplified):
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
