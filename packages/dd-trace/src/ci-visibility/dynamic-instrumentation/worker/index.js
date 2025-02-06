'use strict'

const {
  workerData: {
    breakpointSetChannel,
    breakpointHitChannel,
    breakpointRemoveChannel
  }
} = require('worker_threads')
const { randomUUID } = require('crypto')

// TODO: move debugger/devtools_client/session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: move debugger/devtools_client/source-maps to common place
const { getSourceMappedLine } = require('../../../debugger/devtools_client/source-maps')
// TODO: move debugger/devtools_client/snapshot to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')
// TODO: move debugger/devtools_client/state to common place
const {
  findScriptFromPartialPath,
  getStackFromCallFrames
} = require('../../../debugger/devtools_client/state')
const log = require('../../../log')

let sessionStarted = false

const breakpointIdToProbe = new Map()
const probeIdToBreakpointId = new Map()

session.on('Debugger.paused', async ({ params: { hitBreakpoints: [hitBreakpoint], callFrames } }) => {
  log.warn(`Debugger.paused: ${JSON.stringify(hitBreakpoint, null, 2)}`)
  const probe = breakpointIdToProbe.get(hitBreakpoint)
  log.warn(`probe: ${JSON.stringify(probe, null, 2)}`)
  if (!probe) {
    log.warn(`No probe found for breakpoint ${hitBreakpoint}`)
    return session.post('Debugger.resume')
  }

  const stack = getStackFromCallFrames(callFrames)

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  const snapshot = {
    id: randomUUID(),
    timestamp: Date.now(),
    probe: {
      id: probe.id,
      version: '0',
      location: probe.location
    },
    stack,
    language: 'javascript'
  }

  log.warn(`snapshot: ${JSON.stringify(snapshot, null, 2)}`)

  const state = getLocalState()
  if (state) {
    snapshot.captures = {
      lines: { [probe.location.lines[0]]: { locals: state } }
    }
  }

  breakpointHitChannel.postMessage({ snapshot })
})

breakpointRemoveChannel.on('message', async (probeId) => {
  log.warn(`remove breakpoint ${probeId}`)
  await removeBreakpoint(probeId)
  log.warn(`removed breakpoint ${probeId}`)
  breakpointRemoveChannel.postMessage(probeId)
})

breakpointSetChannel.on('message', async (probe) => {
  log.warn(`set breakpoint ${JSON.stringify(probe, null, 2)}`)
  await addBreakpoint(probe)
  breakpointSetChannel.postMessage(probe.id)
  log.warn(`added breakpoint ${probe.id}`)
})

async function removeBreakpoint (probeId) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw Error(`Cannot remove probe ${probeId}: Debugger not started`)
  }

  const breakpointId = probeIdToBreakpointId.get(probeId)
  if (!breakpointId) {
    throw Error(`Unknown probe id: ${probeId}`)
  }
  await session.post('Debugger.removeBreakpoint', { breakpointId })
  probeIdToBreakpointId.delete(probeId)
  breakpointIdToProbe.delete(breakpointId)
}

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()
  const { file, line } = probe

  probe.location = { file, lines: [String(line)] }

  const script = findScriptFromPartialPath(file)
  if (!script) {
    log.error(`No loaded script found for ${file}`)
    throw new Error(`No loaded script found for ${file}`)
  }

  const { url, scriptId, sourceMapURL } = script

  log.warn(`Adding breakpoint at ${url}:${line}`)
  log.warn(`scriptId: ${scriptId}`)

  let lineNumber = line

  // if (sourceMapURL) {
  //   try {
  //     lineNumber = await getSourceMappedLine(url, source, line, sourceMapURL)
  //   } catch (err) {
  //     log.error('Error processing script with source map', err)
  //   }
  //   if (lineNumber === null) {
  //     log.error('Could not find generated position for %s:%s', url, line)
  //     lineNumber = line
  //   }
  // }

  log.warn(`Source map: ${sourceMapURL}`)
  log.warn(`Actual line number ${lineNumber}`)

  try {
    const { breakpointId } = await session.post('Debugger.setBreakpoint', {
      location: {
        scriptId,
        lineNumber: lineNumber - 1
      }
    })
    log.warn(`breakpointId: ${breakpointId}`)

    breakpointIdToProbe.set(breakpointId, probe)
    probeIdToBreakpointId.set(probe.id, breakpointId)
  } catch (e) {
    log.error('Error setting breakpoint at %s:%s', url, line, e)
  }
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}
