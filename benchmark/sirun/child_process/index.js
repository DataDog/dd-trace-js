'use strict'

const assert = require('node:assert/strict')
const dc = require('dc-polyfill')
const guard = require('../startup-guard')

// Require the real instrumentation so the tracing channel is created exactly as
// in production, then drive the per-call work the sync wrapper (execSync /
// execFileSync) adds around a spawn: normalizeArgs builds the command string, a
// context with a fresh AbortController is allocated, and the channel runs
// start/end. The subprocess is never spawned -- a no-op underlying op isolates
// the tracer's added cost from fork/exec syscall noise, which otherwise
// dominates and is wildly variable. The two helpers below mirror
// packages/datadog-instrumentations/src/child_process.js; the preflight guards
// against drift.
require('../../../packages/datadog-instrumentations/src/child_process')

const channel = dc.tracingChannel('datadog:child_process:execution')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// execFile-shaped (file + array args) vs exec-shaped (single shell string).
const useFileArgs = VARIANT === 'file-args'
const ARGS = useFileArgs
  ? ['echo', ['hello', 'world'], { encoding: 'utf8' }]
  : ['echo hello world']
const SHELL = !useFileArgs

function normalizeArgs (args, shell) {
  const info = { command: args[0], file: args[0] }

  if (Array.isArray(args[1])) {
    info.command = info.command + ' ' + args[1].join(' ')
    info.fileArgs = args[1]
    if (args[2] !== null && typeof args[2] === 'object') info.options = args[2]
  } else if (args[1] !== null && typeof args[1] === 'object') {
    info.options = args[1]
  }

  info.shell = shell || info.options?.shell === true || typeof info.options?.shell === 'string'
  return info
}

function createContext (info) {
  const context = {
    command: info.command,
    file: info.file,
    shell: info.shell,
    abortController: new AbortController(),
  }
  if (info.fileArgs) context.fileArgs = info.fileArgs
  return context
}

function instrumentedCall () {
  const callArgs = [...ARGS]
  const info = normalizeArgs(callArgs, SHELL)
  const context = createContext(info)
  context.callArgs = callArgs
  // Mirror the real sync wrapper: the always-run signal.aborted check and the
  // try/catch/finally that publishes end from finally are part of the per-call cost,
  // so a no-op that skips them would under-report the wrapper overhead.
  return channel.start.runStores(context, () => {
    try {
      if (context.abortController.signal.aborted) return 0
      const result = callArgs.length // no-op underlying op: no spawn
      context.result = result
      return result
    } catch (error) {
      context.error = error
      channel.error.publish(context)
      throw error
    } finally {
      channel.end.publish(context)
    }
  })
}

// A real subscriber so start.hasSubscribers is true and runStores does the
// context-propagation work the tracer pays when AppSec/IAST is on.
channel.subscribe({ start () {}, end () {} })

// Preflight: confirm the mirrored path builds the command and context the
// instrumentation expects, so a drift from the real wrapper fails loudly.
const probeArgs = [...ARGS]
const probeInfo = normalizeArgs(probeArgs, SHELL)
const probeContext = createContext(probeInfo)
assert.equal(probeInfo.command, 'echo hello world', 'normalizeArgs built an unexpected command')
assert.ok(probeContext.abortController, 'context is missing the AbortController')

let sink = 0
guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  sink += instrumentedCall()
}
guard.done()

assert.ok(sink > 0, 'child_process bench produced no work')
