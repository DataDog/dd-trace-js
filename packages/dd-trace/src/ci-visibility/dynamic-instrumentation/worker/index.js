'use strict'

const {
  workerData: {
    breakpointSetChannel,
    breakpointHitChannel,
    breakpointRemoveChannel,
  },
} = require('worker_threads')
const { randomUUID } = require('crypto')

// TODO: move debugger/devtools_client/session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: move debugger/devtools_client/source-maps to common place
const { getGeneratedPosition } = require('../../../debugger/devtools_client/source-maps')
// TODO: move debugger/devtools_client/snapshot to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')
const {
  DEFAULT_MAX_REFERENCE_DEPTH,
  DEFAULT_MAX_COLLECTION_SIZE,
  DEFAULT_MAX_FIELD_COUNT,
  DEFAULT_MAX_LENGTH,
} = require('../../../debugger/devtools_client/snapshot/constants')
// TODO: move debugger/devtools_client/state to common place
const {
  findScriptFromPartialPath,
  getStackFromCallFrames,
} = require('../../../debugger/devtools_client/state')
const log = require('../../../log')

let sessionStarted = false
let inFlightBreakpointHits = 0
let isBreakpointHitDrainScheduled = false

const breakpointIdToProbe = new Map()
const probeIdToBreakpointId = new Map()
const breakpointHitDrainRequests = []

const limits = {
  maxReferenceDepth: DEFAULT_MAX_REFERENCE_DEPTH,
  maxCollectionSize: DEFAULT_MAX_COLLECTION_SIZE,
  maxFieldCount: DEFAULT_MAX_FIELD_COUNT,
  maxLength: DEFAULT_MAX_LENGTH,
}

/**
 * Remove empty collection arrays before sending snapshots through the Test Optimization logs path.
 *
 * @param {object} value - Snapshot object or sub-object.
 * @returns {void}
 */
function removeEmptyCollectionProperties (value) {
  const stack = [value]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') {
          stack.push(item)
        }
      }
      continue
    }

    if (Array.isArray(current.elements)) {
      if (current.elements.length === 0) {
        delete current.elements
      } else {
        stack.push(current.elements)
      }
    }

    if (Array.isArray(current.entries)) {
      if (current.entries.length === 0) {
        delete current.entries
      } else {
        stack.push(current.entries)
      }
    }

    for (const key of Object.keys(current)) {
      if (key === 'elements' || key === 'entries') continue

      const child = current[key]
      if (child && typeof child === 'object') {
        stack.push(child)
      }
    }
  }
}

session.on('Debugger.paused', async ({ params: { hitBreakpoints: [hitBreakpoint], callFrames } }) => {
  const probe = breakpointIdToProbe.get(hitBreakpoint)
  if (!probe) {
    log.warn('No probe found for breakpoint', hitBreakpoint)
    return session.post('Debugger.resume')
  }

  inFlightBreakpointHits++
  try {
    const stack = await getStackFromCallFrames(callFrames)

    const { processLocalState } = await getLocalStateForCallFrame(callFrames[0], limits)

    await session.post('Debugger.resume')

    const snapshot = {
      id: randomUUID(),
      timestamp: Date.now(),
      probe: {
        id: probe.id,
        version: 0,
        location: probe.location,
      },
      captures: {
        lines: { [probe.location.lines[0]]: { locals: processLocalState() } },
      },
      stack,
      language: 'javascript',
    }

    removeEmptyCollectionProperties(snapshot.captures)

    breakpointHitChannel.postMessage({ snapshot })
  } finally {
    inFlightBreakpointHits--
    scheduleBreakpointHitDrain()
  }
})

breakpointHitChannel.on('message', ({ drainRequestId }) => {
  if (!drainRequestId) return

  breakpointHitDrainRequests.push(drainRequestId)
  scheduleBreakpointHitDrain()
})

breakpointRemoveChannel.on('message', async (probeId) => {
  await removeBreakpoint(probeId)
  breakpointRemoveChannel.postMessage(probeId)
})

breakpointSetChannel.on('message', async (probe) => {
  await addBreakpoint(probe)
  breakpointSetChannel.postMessage(probe.id)
})

async function removeBreakpoint (probeId) {
  if (!sessionStarted) {
    // We should not get in this state, but abort if we do, so the code doesn't fail unexpected
    throw new Error(`Cannot remove probe ${probeId}: Debugger not started`)
  }

  const breakpointId = probeIdToBreakpointId.get(probeId)
  if (!breakpointId) {
    throw new Error(`Unknown probe id: ${probeId}`)
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
    log.error('No loaded script found for', file)
    throw new Error(`No loaded script found for ${file}`)
  }

  const { url, scriptId, sourceMapURL, source } = script

  log.warn('Adding breakpoint at %s:%s', url, line)

  let lineNumber = line
  let columnNumber = 0

  if (sourceMapURL) {
    try {
      ({ line: lineNumber, column: columnNumber } = await getGeneratedPosition(url, source, line, sourceMapURL))
    } catch (err) {
      log.error('Error processing script with source map', err)
    }
    if (lineNumber === null) {
      log.error('Could not find generated position for %s:%s', url, line)
      lineNumber = line
      columnNumber = 0
    }
  }

  try {
    const { breakpointId } = await session.post('Debugger.setBreakpoint', {
      location: {
        scriptId,
        lineNumber: lineNumber - 1,
        columnNumber,
      },
    })

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

function drainBreakpointHitRequests () {
  if (inFlightBreakpointHits !== 0) return

  for (const drainRequestId of breakpointHitDrainRequests) {
    breakpointHitChannel.postMessage({ drainRequestId })
  }
  breakpointHitDrainRequests.length = 0
}

function scheduleBreakpointHitDrain () {
  if (isBreakpointHitDrainScheduled) return

  isBreakpointHitDrainScheduled = true
  setImmediate(() => {
    isBreakpointHitDrainScheduled = false
    drainBreakpointHitRequests()
  })
}
