'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { useEnv } = require('../../../../../../integration-tests/helpers')
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
  if (mode === 'cjs') return versionModule.get()
  const sdkPath = versionModule.getPath().replace(/index\.js$/, 'index.mjs')
  assert.match(sdkPath, /\/index\.mjs$/, 'the ESM case must load the ESM build')
  return import(pathToFileURL(sdkPath).href)
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
  closeCode = 1000
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

  close (code = this.closeCode) {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
}

describe('Agents SDK realtime automatic tracing', () => {
  const { getEvents } = useLlmObs({ plugin: 'openai' })

  withVersions('openai', '@openai/agents-realtime', '>=0.20.0', version => {
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
            const expected = fixture.events.find(row => row.direction === 'client' &&
              row.event.item?.type === 'function_call_output').event.item
            const result = llms.flatMap(span => span.meta.input.messages ?? [])
              .flatMap(message => message.tool_results ?? []).find(result => result.tool_id === expected.call_id)
            assert.ok(result)
            assert.strictEqual(result.name, 'check_availability')
            assert.strictEqual(result.result, expected.output)
            for (const row of fixture.events.filter(row => row.direction === 'server' &&
              row.event.item?.type === 'function_call_output' && row.event.item.call_id === expected.call_id)) {
              assert.strictEqual(row.event.item.output, expected.output)
            }
          }
        })
      }

      it(mode + ' emits derived shared-playback timing and audio through the real SIP SDK', async () => {
        const sdk = await loadSdk(mode, version)
        const socket = new ReplaySocket()
        const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
        transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
        transport.on('error', event => assert.fail(event.error?.message || 'Unexpected SDK error'))
        await transport.connect({ callId: 'shared-playback-call', apiKey: 'synthetic-key', model: 'gpt-realtime' })
        const item = id => ({
          id,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'audio', transcript: 'Synthetic response' }],
        })
        for (const id of ['r1', 'r2']) {
          socket.deliver({ type: 'response.created', response: { id, conversation_id: 'conversation' } })
          socket.deliver({ type: 'response.output_item.added', response_id: id, item: item('a' + id) })
          if (id === 'r1') socket.deliver({ type: 'output_audio_buffer.started', response_id: id })
          socket.deliver({
            type: 'response.done', response: { id, status: 'completed', output: [item('a' + id)] },
          })
        }
        await new Promise(resolve => setImmediate(resolve))
        for (const id of ['ar1', 'ar2']) {
          socket.deliver({
            type: 'conversation.item.retrieved',
            item: {
              ...item(id),
              content: [{ type: 'audio', format: 'pcm16', audio: Buffer.alloc(48000, 1).toString('base64') }],
            },
          })
        }
        clock.tick(2000)
        socket.deliver({ type: 'output_audio_buffer.stopped', response_id: 'r2' })
        transport.close()
        const { llmobsSpans } = await getEvents(6)
        const speech = llmobsSpans.filter(span => span.name === 'agent speech').sort((a, b) => a.start_ns - b.start_ns)
        const llms = llmobsSpans.filter(span => span.name === 'OpenAI.createRealtimeResponse')
        assert.strictEqual(speech.length, 2)
        assert.strictEqual(speech[1].start_ns - speech[0].start_ns, 1e9)
        assert.ok(speech.every(span => span.duration === 1e9))
        assert.strictEqual(llms.length, 2)
        assert.ok(llms.every(span => span.meta.metadata.agent_speech_timing === 'audio_duration'))
        assert.ok(llms.every(span => span.meta.output.messages[0].audio_parts.length === 1))
        assert.ok(llmobsSpans.every(span => span.session_id === 'shared-playback-call'))
      })

      it(mode + ' reports per-response multimodal usage and model identity on SIP LLM spans', async () => {
        const sdk = await loadSdk(mode, version)
        const socket = new ReplaySocket()
        transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
        await transport.connect({ callId: 'usage-test-call', apiKey: 'synthetic-key', model: 'configured-model' })
        const cases = [
          {
            id: 'mixed',
            usage: {
              input_tokens: 5000,
              output_tokens: 1300,
              total_tokens: 6300,
              input_token_details: {
                text_tokens: 200,
                audio_tokens: 4800,
                cached_tokens: 4000,
                cached_tokens_details: { text_tokens: 100, audio_tokens: 3900 },
              },
              output_token_details: { text_tokens: 100, audio_tokens: 1200 },
            },
            expected: {
              input_tokens: 5000,
              output_tokens: 1300,
              total_tokens: 6300,
              input_text_tokens: 200,
              input_audio_tokens: 4800,
              output_text_tokens: 100,
              output_audio_tokens: 1200,
              cache_read_input_tokens: 4000,
              cache_text_read_tokens: 100,
              cache_audio_read_tokens: 3900,
            },
          },
          {
            id: 'next-response',
            usage: { input_tokens: 10, output_tokens: 5, input_token_details: { audio_tokens: 0, cached_tokens: 0 } },
            expected: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_audio_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          {
            id: 'partial',
            usage: { input_token_details: { cached_tokens_details: { audio_tokens: 0 } }, output_tokens: 0 },
            expected: { output_tokens: 0, cache_audio_read_tokens: 0 },
          },
          {
            id: 'invalid',
            usage: {
              input_tokens: -1,
              output_tokens: 1.5,
              total_tokens: true,
              input_token_details: { audio_tokens: '3', cached_tokens: -1, text_tokens: 0 },
            },
            expected: { input_text_tokens: 0 },
          },
        ]
        for (const { id, usage } of cases) {
          socket.deliver({ type: 'response.created', response: { id } })
          socket.deliver({
            type: 'response.done',
            response: {
              id, status: 'completed', model: 'gpt-realtime-2025-08-28', output: [], usage,
            },
          })
        }
        transport.close()
        const { llmobsSpans } = await getEvents(cases.length * 2)
        const llms = llmobsSpans.filter(span => span.name === 'OpenAI.createRealtimeResponse')
        assert.strictEqual(llms.length, cases.length)
        const actual = llms.map(span => JSON.stringify(Object.entries(span.metrics).sort())).sort()
        const expected = cases.map(row => JSON.stringify(Object.entries(row.expected).sort())).sort()
        assert.deepStrictEqual(actual, expected, 'each response must preserve its own counts independently')
        assert.ok(llms.every(span => span.meta.model_name === 'gpt-realtime-2025-08-28'))
        assert.ok(llms.every(span => span.meta.model_provider === 'openai'))
        assert.ok(llmobsSpans.filter(span => span.name !== 'OpenAI.createRealtimeResponse')
          .every(span => Object.keys(span.metrics).length === 0))
        assert.ok(llmobsSpans.every(span => Object.keys(span.metrics).every(key => !key.startsWith('ml_obs.'))))
      })

      for (const enabled of [true, false]) {
        describe(mode + ' ordinary WebSocket with sideband retrieval enabled=' + enabled, () => {
          useEnv({ DD_OPENAI_REALTIME_SIDEBAND_AUDIO_RETRIEVAL_ENABLED: String(enabled) })

          it('captures streamed audio without call_id or injected retrievals', async () => {
            const sdk = await loadSdk(mode, version)
            const socket = new ReplaySocket()
            const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
            let connectedUrl
            transport = new sdk.OpenAIRealtimeWebSocket({
              createWebSocket: ({ url }) => {
                connectedUrl = new URL(url)
                return Promise.resolve(socket)
              },
            })
            const receivedAudio = []
            transport.on('audio', event => receivedAudio.push(event))
            await transport.connect({ apiKey: 'synthetic-key', model: 'gpt-realtime' })
            assert.strictEqual(connectedUrl.searchParams.has('call_id'), false)
            assert.strictEqual(connectedUrl.searchParams.get('model'), 'gpt-realtime')
            socket.deliver({
              type: 'session.created',
              event_id: 'session-event',
              session: {
                id: 'ordinary-session',
                type: 'realtime',
                model: 'gpt-realtime',
                tracing: null,
                output_modalities: ['audio'],
                audio: {
                  input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: null },
                  output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'alloy' },
                },
              },
            })
            clock.tick(1000)
            const input = Buffer.alloc(48000, 1)
            transport.sendAudio(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
            socket.deliver({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 })
            socket.deliver({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1000 })
            socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' })
            socket.deliver({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'u1',
              content_index: 0,
              transcript: 'Synthetic user speech',
            })
            socket.deliver({ type: 'response.created', response: { id: 'r1', conversation_id: 'conversation' } })
            clock.tick(100)
            socket.deliver({
              type: 'response.output_audio.delta',
              event_id: 'audio-event',
              response_id: 'r1',
              item_id: 'a1',
              output_index: 0,
              content_index: 0,
              delta: Buffer.alloc(24000, 2).toString('base64'),
            })
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'r1',
              item_id: 'a1',
              output_index: 0,
              content_index: 0,
              transcript: 'Synthetic answer',
            })
            clock.tick(50)
            socket.deliver({
              type: 'response.done',
              response: {
                id: 'r1',
                status: 'completed',
                model: 'gpt-realtime',
                output: [],
                usage: { input_tokens: 10, output_tokens: 20 },
              },
            })
            transport.close()
            const { llmobsSpans } = await getEvents(4)
            const llm = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
            assert.strictEqual(receivedAudio.length, 1)
            assert.strictEqual(llmobsSpans.filter(span => span.name === 'realtime audio turn').length, 1)
            assert.strictEqual(llmobsSpans.filter(span => span.name === 'user speech').length, 1)
            assert.strictEqual(llmobsSpans.filter(span => span.name === 'agent speech').length, 1)
            assert.strictEqual(llm.meta.model_name, 'gpt-realtime')
            assert.strictEqual(llm.meta.model_provider, 'openai')
            assert.deepStrictEqual(llm.metrics, { input_tokens: 10, output_tokens: 20, total_tokens: 30 })
            assert.strictEqual(Buffer.from(llm.meta.input.messages[0].audio_parts[0].content, 'base64').length, 48044)
            assert.strictEqual(Buffer.from(llm.meta.output.messages[0].audio_parts[0].content, 'base64').length, 24044)
            assert.strictEqual(new Set(llmobsSpans.map(span => span.session_id)).size, 1)
            assert.ok(llmobsSpans.every(span => span.session_id))
            assert.ok(socket.sent.some(event => event.type === 'input_audio_buffer.append'))
            assert.ok(socket.sent.every(event => !event.event_id?.startsWith('ddtrace_realtime_audio_')))
          })
        })
      }

      describe(mode + ' with tracer sideband audio retrieval disabled', () => {
        useEnv({ DD_OPENAI_REALTIME_SIDEBAND_AUDIO_RETRIEVAL_ENABLED: 'false' })

        it('keeps SDK/application requests, passive audio capture, and application errors', async () => {
          const sdk = await loadSdk(mode, version)
          const fixture = loadFixture('sideband-tool')
          const { id, events } = firstGeneration(fixture)
          const retrieved = materialize(fixture.events.find(row =>
            row.event.type === 'conversation.item.retrieved' && row.event.item.role === 'assistant').event)
          const socket = new ReplaySocket()
          const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
          transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
          const applicationErrors = []
          transport.on('error', event => applicationErrors.push(event))
          await transport.connect({ callId: 'retrieval-disabled-call', apiKey: 'synthetic-key', model: 'gpt-realtime' })
          for (const event of events) socket.deliver(event)
          await new Promise(resolve => setImmediate(resolve))
          const inputTranscript = events.find(event =>
            event.type === 'conversation.item.input_audio_transcription.completed')
          assert.deepStrictEqual(socket.sent.filter(event => event.type === 'conversation.item.retrieve'), [
            { type: 'conversation.item.retrieve', item_id: inputTranscript.item_id },
          ])
          transport.sendEvent({
            type: 'conversation.item.retrieve', item_id: retrieved.item.id, event_id: 'application-audio-request',
          })
          clock.tick(50)
          socket.deliver({
            type: 'conversation.item.truncated',
            event_id: 'truncation-event',
            item_id: retrieved.item.id,
            content_index: 0,
            audio_end_ms: 50,
          })
          assert.ok(socket.sent.some(event => event.type === 'conversation.item.retrieve' && !event.event_id))
          socket.deliver(retrieved)
          socket.deliver({ type: 'output_audio_buffer.stopped', response_id: id })
          const { llmobsSpans } = await getEvents(3)
          const llm = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
          assert.ok(llm)
          assert.strictEqual(llm.status, 'ok')
          assert.strictEqual(Buffer.from(llm.meta.output.messages[0].audio_parts[0].content, 'base64').length, 2444)
          assert.strictEqual(llmobsSpans.filter(span => span.name === 'agent speech').length, 1)
          assert.deepStrictEqual(socket.sent.filter(event => event.type === 'conversation.item.retrieve'), [
            { type: 'conversation.item.retrieve', item_id: inputTranscript.item_id },
            { type: 'conversation.item.retrieve', item_id: retrieved.item.id, event_id: 'application-audio-request' },
            { type: 'conversation.item.retrieve', item_id: retrieved.item.id },
          ])
          assert.ok(socket.sent.every(event => !event.event_id?.startsWith('ddtrace_realtime_audio_')))
          socket.deliver({
            type: 'error',
            event_id: 'server-error',
            error: {
              type: 'invalid_request_error',
              code: 'item_not_found',
              message: 'Synthetic application failure',
              param: null,
              event_id: 'application-audio-request',
            },
          })
          assert.strictEqual(applicationErrors.length, 1)
          assert.strictEqual(applicationErrors[0].error.error.event_id, 'application-audio-request')
        })
      })

      it(mode + ' emits caller speech for manually committed sideband audio', async () => {
        const sdk = await loadSdk(mode, version)
        const socket = new ReplaySocket()
        const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
        transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
        await transport.connect({ callId: 'manual-call', apiKey: 'synthetic-key', model: 'gpt-realtime' })
        clock.tick(2000)
        socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'manual-input' })
        clock.tick(500)
        socket.deliver({
          type: 'conversation.item.retrieved',
          item: {
            id: 'manual-input',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{
              type: 'input_audio',
              format: 'pcm16',
              audio: Buffer.alloc(48000).toString('base64'),
              transcript: 'Manual caller input',
            }],
          },
        })
        socket.deliver({ type: 'response.created', response: { id: 'manual-response' } })
        clock.tick(100)
        socket.deliver({
          type: 'response.done',
          response: { id: 'manual-response', status: 'completed', model: 'gpt-realtime', output: [] },
        })
        transport.close()
        const { llmobsSpans } = await getEvents(3)
        const root = llmobsSpans.find(span => span.name === 'realtime audio turn')
        const speech = llmobsSpans.find(span => span.name === 'user speech')
        const llm = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
        assert.strictEqual(speech.start_ns, (EPOCH + 1000) * 1e6)
        assert.strictEqual(speech.duration, 1e9)
        assert.strictEqual(root.start_ns, speech.start_ns)
        assert.strictEqual(llm.start_ns, (EPOCH + 2000) * 1e6)
        assert.strictEqual(Buffer.from(llm.meta.input.messages[0].audio_parts[0].content, 'base64').length, 48044)
        assert.strictEqual(llm.session_id, 'manual-call')
      })

      for (const initialSideband of [false, true]) {
        it(mode + ' retains disabled-connect URL changes (initial sideband=' + initialSideband + ')', async () => {
          const sdk = await loadSdk(mode, version)
          const tracer = require('../../../../../..')
          let socket
          let failNext = false
          const urls = []
          transport = new sdk.OpenAIRealtimeWebSocket({
            url: initialSideband
              ? 'wss://constructor.example.test/realtime?call_id=constructor-call'
              : 'wss://constructor.example.test/realtime?model=gpt-realtime',
            createWebSocket: ({ url }) => {
              urls.push(String(url))
              if (failNext) { failNext = false; return Promise.reject(new Error('synthetic connection failure')) }
              socket = new ReplaySocket()
              return Promise.resolve(socket)
            },
          })
          transport.on('error', () => {})
          try {
            tracer.use('openai', { enabled: false })
            assert.strictEqual(dc.tracingChannel('apm:openai:realtime:turn').start.hasSubscribers, false)
            await transport.connect({
              apiKey: 'synthetic-key',
              url: initialSideband
                ? 'wss://updated.example.test/realtime?model=gpt-realtime'
                : 'wss://updated.example.test/realtime?call_id=updated-call',
            })
            transport.close()
            failNext = true
            await assert.rejects(transport.connect({
              apiKey: 'synthetic-key', url: 'wss://failed.example.test/realtime?call_id=failed-call',
            }), /synthetic connection failure/)
            tracer.use('openai', { enabled: true })
            await transport.connect({ apiKey: 'synthetic-key', model: 'gpt-realtime' })
            const session = materialize(loadFixture('sideband-tool').events.find(row =>
              row.event.type === 'session.updated').event)
            socket.deliver(session)
            socket.deliver({ type: 'response.created', response: { id: 'toggle-response' } })
            if (initialSideband) {
              socket.deliver({
                type: 'response.output_audio.delta',
                event_id: 'toggle-audio',
                response_id: 'toggle-response',
                item_id: 'toggle-item',
                output_index: 0,
                content_index: 0,
                delta: Buffer.alloc(24000).toString('base64'),
              })
            }
            socket.deliver({
              type: 'response.done',
              response: {
                id: 'toggle-response',
                status: 'completed',
                model: 'gpt-realtime',
                output: initialSideband
                  ? [{
                      id: 'toggle-item',
                      type: 'message',
                      role: 'assistant',
                      status: 'completed',
                      content: [{ type: 'output_audio', transcript: 'ordinary answer' }],
                    }]
                  : [],
              },
            })
            await new Promise(resolve => setImmediate(resolve))
            if (initialSideband) {
              assert.ok(socket.sent.every(event => !event.event_id?.startsWith('ddtrace_realtime_audio_')))
            }
            transport.close()
            const { llmobsSpans } = await getEvents(initialSideband ? 3 : 2)
            const actualUrl = new URL(urls.at(-1))
            assert.strictEqual(actualUrl.hostname, 'updated.example.test')
            assert.strictEqual(actualUrl.searchParams.get('call_id'), initialSideband ? null : 'updated-call')
            const sessions = new Set(llmobsSpans.map(span => span.session_id))
            assert.strictEqual(sessions.size, 1)
            if (initialSideband) {
              assert.ok(llmobsSpans.every(span => span.session_id && span.session_id !== 'constructor-call'))
              assert.strictEqual(llmobsSpans.filter(span => span.name === 'agent speech').length, 1)
              const llm = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
              const audio = llm.meta.output.messages[0].audio_parts[0].content
              assert.strictEqual(Buffer.from(audio, 'base64').length, 24044)
            } else {
              assert.strictEqual(sessions.has('updated-call'), true)
            }
          } finally {
            tracer.use('openai', { enabled: true })
          }
        })
      }

      for (const enabled of [true, false]) {
        describe(mode + ' SDK input retrieval with tracer retrieval enabled=' + enabled, () => {
          useEnv({ DD_OPENAI_REALTIME_SIDEBAND_AUDIO_RETRIEVAL_ENABLED: String(enabled) })

          it('captures the SDK caller retrieval after generation has completed', async () => {
            const sdk = await loadSdk(mode, version)
            const fixture = loadFixture('sideband-tool')
            const socket = new ReplaySocket()
            const clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
            transport = new sdk.OpenAIRealtimeSIP({ createWebSocket: () => Promise.resolve(socket) })
            await transport.connect({ callId: 'sdk-input-call', apiKey: 'synthetic-key', model: 'gpt-realtime' })
            socket.deliver(materialize(fixture.events.find(row => row.event.type === 'session.updated').event))
            const transcript = fixture.events.find(row =>
              row.event.type === 'conversation.item.input_audio_transcription.completed').event
            const itemId = transcript.item_id
            clock.tick(2000)
            socket.deliver(materialize(fixture.events.find(row =>
              row.event.type === 'input_audio_buffer.committed' && row.event.item_id === itemId).event))
            socket.deliver(materialize(fixture.events.find(row =>
              row.event.type === 'conversation.item.done' && row.event.item.id === itemId).event))
            await new Promise(resolve => setImmediate(resolve))
            assert.strictEqual(socket.sent.filter(event => event.type === 'conversation.item.retrieve').length, 0)
            const response = fixture.events.find(row => row.event.type === 'response.done' &&
              row.event.response.output.some(item => item.type === 'function_call')).event
            socket.deliver({ type: 'response.created', response: { id: response.response.id } })
            socket.deliver(materialize(response))
            clock.tick(200)
            socket.deliver(materialize(transcript))
            await new Promise(resolve => setImmediate(resolve))
            assert.deepStrictEqual(socket.sent.filter(event => event.type === 'conversation.item.retrieve'), [
              { type: 'conversation.item.retrieve', item_id: itemId },
            ])
            const retrieval = fixture.events.find(row => row.event.type === 'conversation.item.retrieved' &&
              row.event.item.id === itemId && row.event.item.content[0].transcript)
            socket.deliver(materialize(retrieval.event))
            transport.close()
            const { llmobsSpans } = await getEvents(3)
            const llm = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
            const encoded = llm.meta.input.messages[0].audio_parts[0].content
            assert.strictEqual(Buffer.from(encoded, 'base64').length,
              retrieval.event.item.content[0].audio.$syntheticAudioBytes + 44)
            assert.ok(llmobsSpans.every(span => span.session_id === 'sdk-input-call'))
            assert.strictEqual(socket.sent.filter(event => event.type === 'conversation.item.retrieve').length, 1)
          })
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

      for (const notification of ['disconnected', 'connection_change']) {
        for (const cause of ['normal', 'abnormal', 'error', 'close']) {
          it(mode + ' traces reconnect from ' + notification + ' after ' + cause, async () => {
            const sdk = await loadSdk(mode, version)
            const turns = []
            const channel = dc.tracingChannel('apm:openai:realtime:turn')
            const observe = ctx => turns.push(ctx.turn)
            channel.start.subscribe(observe)
            let socket
            let reconnect
            transport = new sdk.OpenAIRealtimeSIP({
              createWebSocket: () => {
                socket = new ReplaySocket()
                return Promise.resolve(socket)
              },
            })
            transport.on('error', () => {})
            const listener = status => {
              if (notification === 'connection_change' && status !== 'disconnected') return
              transport.off(notification, listener)
              reconnect = transport.connect({ callId: 'replacement-call', apiKey: 'synthetic-key' })
            }
            try {
              await transport.connect({ callId: 'original-call', apiKey: 'synthetic-key' })
              socket.deliver({ type: 'response.created', response: { id: 'original-response' } })
              transport.on(notification, listener)
              if (cause === 'close') transport.close()
              else if (cause === 'error') {
                socket.closeCode = 1006
                socket.dispatchEvent(new Event('error'))
              } else socket.close(cause === 'abnormal' ? 1006 : 1000)
              assert.ok(reconnect, 'the SDK must accept the reconnect from its disconnect notification')
              await reconnect
              socket.deliver({ type: 'response.created', response: { id: 'replacement-response' } })
              socket.deliver({
                type: 'response.done',
                response: { id: 'replacement-response', status: 'completed', output: [] },
              })
              assert.strictEqual(turns.length, 2)
              assert.strictEqual(turns[0].sessionId, 'original-call')
              assert.strictEqual(turns[0].failed, cause === 'abnormal' || cause === 'error')
              assert.strictEqual(turns[1].sessionId, 'replacement-call')
              assert.strictEqual(turns[1].failed, false)
              await getEvents(4)
            } finally {
              transport.off(notification, listener)
              channel.start.unsubscribe(observe)
            }
          })
        }
      }

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
