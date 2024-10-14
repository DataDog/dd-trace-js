const { randomUUID } = require('crypto')
const { parentPort } = require('worker_threads')
// TODO: maybe move session to common place
const session = require('../../../debugger/devtools_client/session')
// TODO: maybe move getLocalStateForCallFrame to common place
const { getLocalStateForCallFrame } = require('../../../debugger/devtools_client/snapshot')

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
  const probe = breakpoints.get(params.hitBreakpoints[0])

  // so the parent knows what probe it's getting a response from
  const probeId = probes.get(params.hitBreakpoints[0])

  const stack = params.callFrames.map((frame) => {
    let fileName = scriptUrls.get(frame.location.scriptId)
    if (fileName.startsWith('file://')) fileName = fileName.substr(7) // TODO: This might not be required
    return {
      fileName,
      function: frame.functionName,
      lineNumber: frame.location.lineNumber + 1, // Beware! lineNumber is zero-indexed
      columnNumber: frame.location.columnNumber + 1 // Beware! columnNumber is zero-indexed
    }
  })

  const getLocalState = await getLocalStateForCallFrame(params.callFrames[0])
  await session.post('Debugger.resume')

  if (!probe) {
    return
  }

  const snapshot = {
    id: global.__snapshotId,
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

  // const state = getLocalState()

  parentPort.postMessage({ probe, snapshot, id: probeId })
})

// TODO: add option to remove breakpoint
// message handling
parentPort.on('message', async ({ snapshotId, probe: { id: probeId, file, line } }) => {
  global.__snapshotId = snapshotId
  // only message at the moment is a line probe
  await addBreakpoint({ probeId, file, line })
})

async function addBreakpoint (probe) {
  if (!sessionStarted) await start()
  const { file, line, probeId } = probe

  probe.location = { file, lines: [String(line)] }

  const script = findScriptFromPartialPath(file)
  if (!script) throw new Error(`No loaded script found for ${file}`)

  const [path, scriptId] = script

  console.log(`Adding breakpoint at ${path}:${line}`)

  const { breakpointId } = await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })

  probes.set(breakpointId, probeId)

  breakpoints.set(breakpointId, probe)
}

function start () {
  sessionStarted = true
  return session.post('Debugger.enable') // return instead of await to reduce number of promises created
}
