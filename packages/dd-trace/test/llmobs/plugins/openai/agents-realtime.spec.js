'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { flushLiveSessions } = require('../../../../../datadog-instrumentations/src/openai-realtime')
const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')

const EPOCH = 1_000_000

function materialize (value) {
  if (value?.$syntheticAudioBytes !== undefined) return Buffer.alloc(value.$syntheticAudioBytes, 1).toString('base64')
  if (Array.isArray(value)) return value.map(materialize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]))
  }
  return value
}

class ReplaySocket extends EventTarget {
  readyState = 0
  sent = []

  constructor () {
    super()
    setImmediate(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }

  send (data) {
    this.sent.push(JSON.parse(data))
  }

  deliver (event) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }

  close () {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: 1000 })
    this.dispatchEvent(event)
  }
}

describe('Agents SDK realtime automatic tracing', () => {
  const { getEvents } = useLlmObs({ plugin: 'openai' })

  withVersions('openai', '@openai/agents-realtime', '0.20.0', version => {
    let transport

    afterEach(() => {
      transport?.close()
      flushLiveSessions()
      sinon.restore()
    })

    for (const mode of ['cjs', 'esm']) {
      for (const name of ['sideband-tool', 'sideband-interruption']) {
        it(mode + ' replays ' + name + ' through the real SIP SDK and preserves the span contract', async () => {
          const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,
            '../../../../../datadog-instrumentations/test/openai-realtime/fixtures', name + '.json'), 'utf8'))
          if (mode === 'esm') require('../../../../../../register')
          const versionModule = require('../../../../../../versions/@openai/agents-realtime@' + version)
          const sdk = mode === 'cjs'
            ? versionModule.get()
            : await import(pathToFileURL(versionModule.getPath().replace(/index\.js$/, 'index.mjs')).href)
          const socket = new ReplaySocket()
          const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
          transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
          const sdkErrors = []
          transport.on('error', event => sdkErrors.push(event))
          await transport.connect({ callId: 'replay-call', apiKey: 'synthetic-key', model: 'gpt-realtime' })
          await assert.rejects(transport.connect({ callId: 'other-call', apiKey: 'synthetic-key' }),
            /already connected or connecting/, 'a failed duplicate connect must not finalize the working connection')

          for (const row of fixture.events) {
            clock.tick(Math.max(0, row.at - (clock.now - EPOCH)))
            const event = materialize(row.event)
            if (row.direction === 'server') socket.deliver(event)
            else transport.sendEvent(event)
            await new Promise(resolve => setImmediate(resolve))
          }
          clock.tick(Math.max(0, fixture.finishAt - (clock.now - EPOCH)))
          transport.close()

          const roots = fixture.events.filter(row => row.event.type === 'response.created').length
          const users = fixture.events.filter(row => row.event.type === 'input_audio_buffer.speech_started').length
          const speech = fixture.events.filter(row =>
            ['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(row.event.type)).length
          const { llmobsSpans } = await getEvents(roots * 2 + users + speech)
          const turns = llmobsSpans.filter(span => span.name === 'realtime audio turn')
          const llms = llmobsSpans.filter(span => span.name === 'OpenAI.createRealtimeResponse')
          assert.strictEqual(sdkErrors.length, 0)
          assert.strictEqual(turns.length, roots)
          assert.strictEqual(llms.length, roots)
          assert.ok(llmobsSpans.every(span => span.session_id === 'replay-call'))
          for (const span of llmobsSpans) {
            assert.ok(['realtime audio turn', 'OpenAI.createRealtimeResponse', 'user speech', 'agent speech']
              .includes(span.name))
            const kind = span.name === 'OpenAI.createRealtimeResponse' ? 'llm' : 'workflow'
            assert.strictEqual(span.meta['span.kind'], kind)
            if (span.name !== 'realtime audio turn') {
              assert.ok(turns.some(turn => turn.span_id === span.parent_id))
            }
          }
          assert.ok(llms.some(span => span.meta.input.messages?.some(message => message.audio_parts?.length)))
          assert.ok(llms.some(span => span.meta.output.messages?.some(message => message.audio_parts?.length)))
          if (name === 'sideband-tool') {
            assert.ok(llms.some(span => span.meta.output.messages?.some(message => message.tool_calls?.length)))
            assert.ok(llms.some(span => span.meta.input.messages?.some(message => message.tool_results?.length)))
          }
        })
      }
    }
  })
})
