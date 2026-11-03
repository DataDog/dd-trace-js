'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const dc = require('dc-polyfill')
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

function loadFixture (name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname,
    '../../../../../datadog-instrumentations/test/openai-realtime/fixtures', name + '.json'), 'utf8'))
}

async function loadSdk (mode, version) {
  if (mode === 'esm') require('../../../../../../register')
  const versionModule = require('../../../../../../versions/@openai/agents-realtime@' + version)
  return mode === 'cjs'
    ? versionModule.get()
    : import(pathToFileURL(versionModule.getPath().replace(/index\\.js$/, 'index.mjs')).href)
}

function firstGeneration (fixture) {
  const start = fixture.events.findIndex(row => row.event.type === 'response.created')
  const id = fixture.events[start].event.response.id
  const end = fixture.events.findIndex(row => row.event.type === 'response.done' && row.event.response.id === id)
  const events = fixture.events.slice(start, end + 1)
    .filter(row => row.direction === 'server' && row.event.type !== 'conversation.item.retrieved')
    .map(row => materialize(row.event))
  return { id, events }
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

      it(mode + ' follows constructor, override, reconnect and call-ID URL precedence', async () => {
        const sdk = await loadSdk(mode, version)
        const fixture = loadFixture('sideband-tool')
        const { id, events } = firstGeneration(fixture)
        const retrieved = materialize(fixture.events.find(row =>
          row.event.type === 'conversation.item.retrieved' && row.event.item.role === 'assistant').event)
        const turns = []
        const channel = dc.tracingChannel('apm:openai:realtime:turn')
        const observe = ctx => turns.push(ctx.turn)
        channel.start.subscribe(observe)
        let socket
        let failNext = false
        const urls = []
        transport = new sdk.OpenAIRealtimeWebSocket({
          url: 'wss://user:synthetic-secret@proxy.example.test/custom/realtime?call_id=constructor-call&api_key=synthetic-secret',
          createWebSocket: options => {
            urls.push(options.url)
            if (failNext) {
              failNext = false
              return Promise.reject(new Error('synthetic connection failure'))
            }
            socket = new ReplaySocket()
            return Promise.resolve(socket)
          },
        })
        transport.on('error', () => {})
        const exercise = async (options, callId, basePath) => {
          await transport.connect({ apiKey: 'synthetic-key', model: 'gpt-realtime', ...options })
          const before = turns.length
          for (const event of events) socket.deliver(event)
          await new Promise(resolve => setImmediate(resolve))
          assert.strictEqual(turns.length, before, 'generation completion must not finish sideband playback')
          assert.ok(socket.sent.some(event => event.type === 'conversation.item.retrieve' &&
            event.event_id?.startsWith('ddtrace_realtime_audio_')))
          socket.deliver(retrieved)
          socket.deliver({ type: 'output_audio_buffer.stopped', response_id: id })
          assert.strictEqual(turns.length, before + 1)
          assert.strictEqual(turns.at(-1).sessionId, callId)
          assert.strictEqual(turns.at(-1).basePath, basePath)
          assert.ok(turns.at(-1).output.audio.length)
          transport.close()
        }
        try {
          await exercise({}, 'constructor-call', 'wss://proxy.example.test/custom/realtime')
          failNext = true
          await assert.rejects(transport.connect({
            apiKey: 'synthetic-key', url: 'wss://failed.example.test/realtime?call_id=failed-call',
          }), /synthetic connection failure/)
          await exercise({}, 'constructor-call', 'wss://proxy.example.test/custom/realtime')
          await exercise({
            url: 'wss://override.example.test/another/realtime?call_id=override-call',
            callId: 'ignored-call-id',
          }, 'override-call', 'wss://override.example.test/another/realtime')
          await exercise({}, 'override-call', 'wss://override.example.test/another/realtime')
          await exercise({ callId: 'direct-call' }, 'direct-call', 'wss://api.openai.com/v1/realtime')
          await exercise({}, 'override-call', 'wss://override.example.test/another/realtime')
          assert.ok(urls.at(-1).includes('override.example.test'))
          await getEvents(18)
        } finally {
          channel.start.unsubscribe(observe)
        }
      })

      it(mode + ' keeps tracer retrieval failures out of transport/session listeners', async () => {
        const sdk = await loadSdk(mode, version)
        const fixture = loadFixture('sideband-tool')
        const { id, events } = firstGeneration(fixture)
        const socket = new ReplaySocket()
        transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
        const session = new sdk.RealtimeSession(new sdk.RealtimeAgent({ name: 'Synthetic test agent' }), {
          transport, model: 'gpt-realtime', tracingDisabled: true,
        })
        const rawErrors = []
        transport.on('*', event => { if (event.type === 'error') rawErrors.push(event) })
        try {
          await session.connect({ apiKey: 'synthetic-key', callId: 'error-test-call' })
          for (const event of events) socket.deliver(event)
          await new Promise(resolve => setImmediate(resolve))
          const request = socket.sent.find(event => event.type === 'conversation.item.retrieve' &&
            event.event_id?.startsWith('ddtrace_realtime_audio_'))
          assert.ok(request)
          const errorEvent = eventId => ({
            type: 'error',
            event_id: 'server-error',
            error: {
              type: 'invalid_request_error',
              code: 'item_not_found',
              message: 'synthetic retrieval error',
              param: null,
              event_id: eventId,
            },
          })
          // No session error handler is installed: an SDK error emission would throw.
          socket.deliver(errorEvent(request.event_id))
          await new Promise(resolve => setImmediate(resolve))
          assert.strictEqual(rawErrors.length, 0)
          socket.deliver({ type: 'output_audio_buffer.stopped', response_id: id })
          const { llmobsSpans } = await getEvents(3)
          const llm = llmobsSpans.find(span => span.meta['span.kind'] === 'llm')
          assert.ok(llm)
          assert.strictEqual(llm.status, 'ok')

          // A delayed failure remains ours after the turn's request map has been cleared.
          socket.deliver(errorEvent(request.event_id))
          await new Promise(resolve => setImmediate(resolve))
          assert.strictEqual(rawErrors.length, 0)

          const sessionErrors = []
          const transportErrors = []
          session.on('error', event => sessionErrors.push(event))
          transport.on('error', event => transportErrors.push(event))
          for (const eventId of ['application-request', 'ddtrace_realtime_audio_1']) socket.deliver(errorEvent(eventId))
          await new Promise(resolve => setImmediate(resolve))
          assert.strictEqual(rawErrors.length, 2)
          assert.strictEqual(sessionErrors.length, 2)
          assert.strictEqual(transportErrors.length, 2)
        } finally {
          session.close()
        }
      })
    }
  })
})
