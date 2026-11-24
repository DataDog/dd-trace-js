'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')

const Session = require('../packages/datadog-instrumentations/src/elevenlabs/session')
const { Conversation } = require('../versions/@elevenlabs/elevenlabs-js@2.75.0').get(
  '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation')

// Compare the actual protocol-state implementation against a reproducible Git revision. The send
// benchmark also drives the published SDK's normal microphone callback and JSON serialization.
const baselineRef = process.argv[2]
if (!baselineRef) throw new Error('Usage: npm run bench:elevenlabs -- <baseline-ref>')
const filename = join(__dirname, '../packages/datadog-instrumentations/src/elevenlabs/session.js')
const baselineModule = new Module(filename, module)
baselineModule.filename = filename
baselineModule.paths = module.paths
const sourcePath = 'packages/datadog-instrumentations/src/elevenlabs/session.js'
const baselineSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' })
baselineModule._compile(baselineSource, filename)
const BaselineSession = baselineModule.exports

/**
 * @param {typeof Session} Type
 * @param {boolean} retain
 */
function session (Type, retain) {
  const state = new Type({ agentId: 'benchmark', retain: () => retain, begin () {}, finish () {} })
  state.receive({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: {
      user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
    },
  }, 1_000_000)
  return state
}

/**
 * @param {typeof Session} Type
 * @param {boolean} retain
 */
async function sender (Type, retain) {
  const state = session(Type, retain)
  const socket = new EventEmitter()
  socket.readyState = 1
  let frames = 0
  socket.send = raw => {
    if (typeof state.sendRaw === 'function') state.sendRaw(raw, 1_000_000 + frames * 20)
    else state.send(JSON.parse(raw), 1_000_000 + frames * 20)
    if (++frames % 64 === 0) {
      state.receive({ type: 'agent_response', agent_response_event: { event_id: frames, agent_response: 'ok' } },
        1_000_000 + frames * 20)
    }
  }
  let input
  const conversation = new Conversation({
    agentId: 'benchmark',
    requiresAuth: false,
    client: {},
    audioInterface: { start (callback) { input = callback }, stop () {}, output () {}, interrupt () {} },
    webSocketFactory: { create: () => socket },
  })
  const started = conversation.startSession()
  socket.emit('open')
  await started
  const pcm = Buffer.alloc(640, 7) // one ordinary 20 ms, 16 kHz microphone frame
  return () => input(pcm)
}

/** @param {typeof Session} Type */
function argumentsReceiver (Type) {
  const state = session(Type, false)
  let index = 0
  const parameters = { value: 'x'.repeat(1400) }
  return () => {
    const eventId = Math.floor(index / 64) + 1
    state.receive({
      type: 'client_tool_call',
      client_tool_call: {
        event_id: eventId, tool_name: 'tool', tool_call_id: String(index % 64), parameters,
      },
    }, 1_000_000 + index++)
  }
}

/**
 * @param {() => void} fn
 * @param {number} count
 */
function time (fn, count) {
  const before = performance.now()
  for (let i = 0; i < count; i++) fn()
  return (performance.now() - before) * 1e6 / count
}

/** @param {number[]} values */
function median (values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] }

/**
 * @param {string} name
 * @param {() => void} baseline
 * @param {() => void} current
 * @param {number} count
 */
function compare (name, baseline, current, count) {
  time(baseline, 5000)
  time(current, 5000)
  const old = []
  const next = []
  for (let i = 0; i < 7; i++) {
    if (i % 2) {
      next.push(time(current, count))
      old.push(time(baseline, count))
    } else {
      old.push(time(baseline, count))
      next.push(time(current, count))
    }
  }
  const before = median(old)
  const after = median(next)
  assert.ok(before > 0 && after > 0)
  return {
    name,
    baselineNs: Math.round(before),
    currentNs: Math.round(after),
    improvementPercent: Number(((1 - after / before) * 100).toFixed(1)),
    baselineSamplesNs: old.map(Math.round),
    currentSamplesNs: next.map(Math.round),
  }
}

async function main () {
  const results = []
  for (const retain of [false, true]) {
    const baseline = await sender(BaselineSession, retain)
    const current = await sender(Session, retain)
    results.push(compare(`SDK microphone frame, retain=${retain}`, baseline, current, 40_000))
  }
  results.push(compare('64 tool argument sets per turn', argumentsReceiver(BaselineSession),
    argumentsReceiver(Session), 12_800))
  process.stdout.write(JSON.stringify({ node: process.version, baselineRef, samples: 7, results }, null, 2) + '\n')
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
