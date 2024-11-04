'use strict'

const { workerData: { breakpointSetChannel, breakpointHitChannel } } = require('worker_threads')
// TODO: move debugger/devtools_client/session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: move debugger/devtools_client/snapshot to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')
// TODO: move debugger/devtools_client/state to common place
const {
  findScriptFromPartialPath,
  getStackFromCallFrames
} = require('../../../debugger/devtools_client/state')
const log = require('../../../log')

let sessionStarted = false

const breakpointIdToSnapshotId = new Map()
const breakpointIdToProbe = new Map()

session.on('Debugger.paused', async ({ params: { hitBreakpoints: [hitBreakpoint], callFrames } }) => {
  const probe = breakpointIdToProbe.get(hitBreakpoint)
  if (!probe) {
    log.warn(`No probe found for breakpoint ${hitBreakpoint}`)
    return session.post('Debugger.resume')
  }

  const stack = getStackFromCallFrames(callFrames)

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  const snapshotId = breakpointIdToSnapshotId.get(hitBreakpoint)

  const snapshot = {
    id: snapshotId,
    timestamp: Date.now(),
    probe: {
      id: probe.probeId,
      version: '0',
      location: probe.location
    },
    stack,
    language: 'javascript'
  }

  const state = getLocalState()
  if (state) {
    snapshot.captures = {
      lines: { [probe.location.lines[0]]: { locals: state } }
    }
  }

  breakpointHitChannel.postMessage({ snapshot })
})

// TODO: add option to remove breakpoint
breakpointSetChannel.on('message', async ({ snapshotId, probe: { id: probeId, file, line } }) => {
  await addBreakpoint(snapshotId, { probeId, file, line })
  breakpointSetChannel.postMessage({ probeId })
})

async function addBreakpoint (snapshotId, probe) {
  if (!sessionStarted) await start()
  const { file, line } = probe

  probe.location = { file, lines: [String(line)] }

  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file}`)

  const [path, scriptId] = script

  log.debug(`Adding breakpoint at ${path}:${line}`)

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: line - 1
    }
  })

  breakpointIdToProbe.set(breakpointId, probe)
  breakpointIdToSnapshotId.set(breakpointId, snapshotId)
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}
