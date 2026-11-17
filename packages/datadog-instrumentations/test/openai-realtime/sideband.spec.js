'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const RealtimeSession = require('../../src/openai-realtime/session')

const EPOCH = 1_000_000

function materialize (value) {
  if (value?.$syntheticAudioBytes !== undefined) return Buffer.alloc(value.$syntheticAudioBytes, 1).toString('base64')
  if (Array.isArray(value)) return value.map(materialize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]))
  }
  return value
}

function replay (name, { retain = true, dropRetrievals = false } = {}) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.json'), 'utf8'))
  const clock = sinon.useFakeTimers({ now: EPOCH })
  const emitted = []
  const requests = []
  const session = new RealtimeSession({
    emitTurn: turn => emitted.push({ at: clock.now - EPOCH, turn }),
    captureContext: () => {},
    sessionId: 'synthetic-call',
    serverPlayback: true,
    shouldRetainAudio: () => retain,
    requestItem: (itemId, eventId) => requests.push({ itemId, eventId }),
  })
  for (const row of fixture.events) {
    clock.tick(Math.max(0, row.at - (clock.now - EPOCH)))
    const event = materialize(row.event)
    if (row.direction === 'server') {
      if (dropRetrievals && event.type === 'conversation.item.retrieved') continue
      session.onServerEvent(event, clock.now)
    } else session.onClientEvent(event, clock.now)
  }
  clock.tick(Math.max(0, fixture.finishAt - (clock.now - EPOCH)))
  session.finishSession(clock.now)
  return { emitted, requests, clock }
}

describe('OpenAI realtime sideband capture replays', () => {
  afterEach(() => sinon.restore())

  it('keeps generation, natural playback and the tool continuation separate', () => {
    const { emitted } = replay('sideband-tool')
    assert.strictEqual(emitted.length, 10)
    assert.ok(emitted.every(({ turn }) => turn.sessionId === 'synthetic-call'))
    const called = emitted.find(({ turn }) => turn.output.toolCalls?.length)
    assert.ok(called)
    assert.strictEqual(called.turn.output.toolCalls[0].name, 'check_availability')
    assert.strictEqual(called.turn.agentSpeech, undefined, 'a tool-only response did not speak')
    const answer = emitted.find(({ turn }) => turn.input.toolResults.length)
    assert.ok(answer)
    assert.strictEqual(answer.turn.input.toolResults[0].toolId, called.turn.output.toolCalls[0].toolId)
    assert.ok(answer.turn.agentSpeech)
    assert.strictEqual(answer.turn.agentSpeech.finishTime - answer.turn.llm.finishTime, 3091)
    assert.ok(answer.at >= answer.turn.agentSpeech.finishTime - EPOCH)
    assert.strictEqual(emitted.filter(({ turn }) => turn.agentSpeech).length, 6)
    assert.strictEqual(answer.turn.output.audio.length, 194400)
    assert.strictEqual(answer.turn.input.audio.length, 0, 'the continuation has no second user utterance')
  })

  it('uses the latest heard-audio version after an interruption', () => {
    const { emitted } = replay('sideband-interruption')
    assert.strictEqual(emitted.length, 3)
    const interrupted = emitted.find(({ turn }) => turn.output.audio.length === 107520)
    assert.ok(interrupted, 'the 168000-byte generated clip must be shortened to 107520 heard bytes')
    assert.ok(interrupted.turn.agentSpeech)
    assert.strictEqual(interrupted.turn.output.audio.length / 48, 2240)
    assert.ok(interrupted.at >= interrupted.turn.agentSpeech.finishTime - EPOCH)
    assert.ok(emitted[0].turn.output.audio.length <= 103680, 'first interruption is also capped')
  })

  it('preserves playback timing without retaining or requesting audio', () => {
    const { emitted, requests } = replay('sideband-tool', { retain: false })
    assert.strictEqual(requests.length, 0)
    assert.strictEqual(emitted.filter(({ turn }) => turn.agentSpeech).length, 6)
    assert.ok(emitted.every(({ turn }) => turn.input.audio.length === 0 && turn.output.audio.length === 0))
  })

  it('flushes a disconnected session whose audio retrieval never returned', () => {
    const { emitted } = replay('sideband-tool', { dropRetrievals: true })
    assert.strictEqual(emitted.length, 10)
    assert.ok(emitted.every(({ turn }) => turn.input.audio.length === 0 && turn.output.audio.length === 0))
    assert.ok(emitted.some(({ turn }) => turn.output.transcript), 'transcripts survive a retrieval failure')
  })
})
