'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()

  // Simulate SDK module load so the plugin manager activates channel
  // subscriptions (same event that fires when the real ESM SDK is loaded).
  const { channel } = require('dc-polyfill')
  channel('dd-trace:instrumentation:load').publish({ name: '@anthropic-ai/claude-agent-sdk' })
}

const { tracingChannel } = require('dc-polyfill')

const sessionCh = tracingChannel('apm:claude-agent-sdk:session')
const turnCh = tracingChannel('apm:claude-agent-sdk:turn')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')

const SESSIONS = 500

// Simulate hook calls as the SDK would invoke them.
// Each session: 3 turns, 2 tool calls each = 10 spans, 22 hook invocations.
function runSession () {
  const sessionCtx = { prompt: 'bench', model: 'claude-opus-4-6', sessionId: 'bench' }

  sessionCh.start.runStores(sessionCtx, () => {
    sessionCh.end.publish(sessionCtx)

    for (let t = 0; t < 3; t++) {
      const turnCtx = { sessionId: 'bench', prompt: 'p' }
      turnCh.start.runStores(turnCtx, () => {
        turnCh.end.publish(turnCtx)

        for (let u = 0; u < 2; u++) {
          const toolCtx = { sessionId: 'bench', toolName: 'Read', toolUseId: 'tu-' + t + '-' + u }
          toolCh.start.runStores(toolCtx, () => {
            toolCh.end.publish(toolCtx)
          })
          toolCtx.toolResponse = 'ok'
          toolCh.asyncEnd.publish(toolCtx)
        }
      })
      turnCtx.stopReason = 'end_turn'
      turnCh.asyncEnd.publish(turnCtx)
    }
  })
  sessionCtx.endReason = 'done'
  sessionCh.asyncEnd.publish(sessionCtx)
}

let count = 0
function runNext () {
  if (count++ >= SESSIONS) return
  runSession()
  setImmediate(runNext)
}

runNext()
