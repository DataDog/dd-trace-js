const { parentPort } = require('worker_threads')
// TODO: move session to common place?
const session = require('../../../debugger/devtools_client/session')
// TODO: move getLocalStateForCallFrame to common place?
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')
const log = require('../../log')

let sessionStarted = false

const scriptIds = []
const scriptUrls = new Map()

const probes = new Map()
const breakpoints = new Map()

function findScriptFromPartialPath (path) {
  return scriptIds
    .filter(([url]) => url.endsWith(path))
    .sort(([a], [b]) => a.length - b.length)[0]
}

session.on('Debugger.scriptParsed', ({ params }) => {
  scriptUrls.set(params.scriptId, params.url)
  if (params.url.startsWith('file:')) {
    scriptIds.push([params.url, params.scriptId])
  }
})

session.on('Debugger.paused', async ({ params }) => {
  const { hitBreakpoints: [hitBreakpoint], callFrames } = params

  const probe = breakpoints.get(hitBreakpoint)
  const probeId = probes.get(hitBreakpoint)

  const stack = callFrames.map(({ functionName, location: { scriptId, lineNumber, columnNumber } }) => {
    let fileName = scriptUrls.get(scriptId)
    if (fileName.startsWith('file://')) fileName = fileName.substr(7) // TODO: This might not be required

    return {
      fileName,
      function: functionName,
      lineNumber: lineNumber + 1,
      columnNumber: columnNumber + 1
    }
  })

  const getLocalState = await getLocalStateForCallFrame(callFrames[0])

  await session.post('Debugger.resume')

  if (!probe) {
    return
  }

  const snapshot = {
    id: probe.snapshotId,
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

  parentPort.postMessage({ probe, snapshot, id: probeId })
})

parentPort.on('message', async ({ snapshotId, probe: { id: probeId, file, line } }) => {
  // only message at the moment is a line probe
  // TODO: add option to remove breakpoint
  await addBreakpoint({ probeId, file, line, snapshotId })
})

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()
  const { file, line, probeId } = probe

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

  probes.set(breakpointId, probeId)

  breakpoints.set(breakpointId, probe)
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}
