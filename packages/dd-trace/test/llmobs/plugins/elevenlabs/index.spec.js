'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')

/**
 * @param {number} duration
 * @param {number} rate
 * @param {number} value
 */
function pcm (duration, rate = 16000, value = 7) { return Buffer.alloc(duration * rate / 1000 * 2, value) }

class Socket extends EventEmitter {
  readyState = 1
  sent = []
  send (data) { this.sent.push(JSON.parse(data)) }
  deliver (event) { this.emit('message', Buffer.from(JSON.stringify(event))) }
  close () { this.emit('close', 1000, Buffer.alloc(0)) }
}

/**
 * @param {object[]} spans
 * @param {string} name
 */
function byName (spans, name) {
  const span = spans.find(span => span.name === name)
  assert.ok(span, `missing ${name}; got ${spans.map(span => span.name)}`)
  return span
}

/**
 * @param {object} part
 * @param {number} rate
 * @param {Buffer} expected
 */
function wav (part, rate, expected) {
  assert.equal(part.mime_type, 'audio/wav')
  const bytes = Buffer.from(part.content, 'base64')
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.readUInt32LE(24), rate)
  assert.equal(bytes.readUInt32LE(40), expected.length)
  assert.deepEqual(bytes.subarray(44), expected)
}

describe('integrations', () => {
  describe('elevenlabs', () => {
    const { getEvents } = useLlmObs({ plugin: 'elevenlabs', tracerConfigOptions: {} })
    withVersions('elevenlabs', '@elevenlabs/elevenlabs-js', '>=2.75.0 <3', version => {
      let Conversation, ClientTools, clock, conversation, socket, audio, tools, outputSpy

      beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
        const sdk = require(`../../../../../../versions/@elevenlabs/elevenlabs-js@${version}`).get(
          '@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation')
        Conversation = sdk.Conversation
        ClientTools = sdk.ClientTools
        tools = new ClientTools()
        outputSpy = sinon.spy()
        audio = {
          start: sinon.spy(callback => { audio.input = callback }),
          stop: sinon.spy(),
          output: outputSpy,
          interrupt: sinon.spy(),
        }
        socket = new Socket()
        conversation = new Conversation({
          agentId: 'agent-test',
          requiresAuth: false,
          audioInterface: audio,
          clientTools: tools,
          webSocketFactory: { create: () => socket },
        })
      })
      afterEach(() => {
        conversation.endSession()
        clock.restore()
      })

      async function start () {
        const promise = conversation.startSession()
        socket.emit('open')
        await promise
        socket.deliver({
          type: 'conversation_initiation_metadata',
          conversation_initiation_metadata_event: {
            conversation_id: 'conv-test', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
          },
        })
      }
      function event (type, field, id, data = {}) {
        socket.deliver({ type, [field]: { event_id: String(id), ...data } })
      }
      function input (ms, value = 7) { clock.tick(ms); audio.input(pcm(ms, 16000, value)) }
      /**
       * @param {string | number} id
       * @param {string} text
       */
      function response (id = 1, text = 'Hello') {
        event('agent_response', 'agent_response_event', id, { agent_response: text })
      }
      function output (id, ms) {
        event('audio', 'audio_event', id, {
          audio_base_64: pcm(ms, 24000,
            9).toString('base64'),
        })
      }
      function vad (score) { socket.deliver({ type: 'vad_score', vad_score_event: { vad_score: score } }) }
      function close () { clock.tick(2000); conversation.endSession() }

      it('exports bounded WAVs and direct phase children with explicit TTFA opt-out', async () => {
        await start()
        input(200)
        event('user_transcript', 'user_transcription_event', 1, { user_transcript: 'Hi' })
        clock.tick(50)
        output(1, 300)
        response()
        event('context_usage', 'context_usage_event', 1, { model: 'configured-model', used_tokens: 99 })
        close()
        const { llmobsSpans } = await getEvents(4)
        const root = byName(llmobsSpans, 'elevenlabs audio turn')
        const llm = byName(llmobsSpans, 'elevenlabs response')
        for (const span of llmobsSpans) {
          assert.equal(span.session_id, 'conv-test')
          assert.equal(span.meta.metadata.ttfa_eligible, false)
          assert.deepEqual(span.metrics, {})
          if (span !== root) assert.equal(span.parent_id, root.span_id)
          if (span !== llm) {
            assert.equal(span.meta.input?.messages, undefined)
            assert.equal(span.meta.output?.messages, undefined)
          }
        }
        assert.equal(llm.meta.model_name, 'configured-model')
        assert.equal(llm.meta.input.messages[0].content, 'Hi')
        wav(llm.meta.input.messages[0].audio_parts[0], 16000, pcm(200))
        wav(llm.meta.output.messages[0].audio_parts[0], 24000, pcm(300, 24000, 9))
        assert.equal(byName(llmobsSpans, 'user speech').duration, 200e6)
        assert.equal(byName(llmobsSpans, 'agent speech').duration, 300e6)
      })

      it('keeps repeated identical text in separate turns without completion events', async () => {
        await start()
        for (let id = 1; id <= 3; id++) { input(20, id); response(id, 'Same'); output(id, 30); clock.tick(40) }
        close()
        const { llmobsSpans } = await getEvents(12)
        const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
        assert.equal(new Set(llms.map(span => span.parent_id)).size, 3)
        for (let i = 0; i < llms.length; i++) {
          assert.equal(llms[i].meta.output.messages[0].content, 'Same')
          wav(llms[i].meta.input.messages[0].audio_parts[0], 16000, pcm(20, 16000, i + 1))
        }
      })

      it('accepts audio before text and typed input without a transcript echo', async () => {
        await start()
        conversation.sendUserMessage('Typed')
        output(1, 40)
        response(1, 'Answer')
        close()
        const { llmobsSpans } = await getEvents(3)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        assert.equal(llm.meta.input.messages[0].content, 'Typed')
        assert.equal(llm.meta.output.messages[0].content, 'Answer')
      })

      it('cuts queued audio after generation completes and rejects stale audio', async () => {
        await start()
        input(20)
        output(1, 1000)
        response()
        event('agent_response_complete', 'agent_response_complete_event', 1)
        clock.tick(250)
        event('interruption', 'interruption_event', 1)
        output(1, 100)
        close()
        const { llmobsSpans } = await getEvents(4)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        wav(llm.meta.output.messages[0].audio_parts[0], 24000, pcm(250, 24000, 9))
        assert.equal(llm.meta.metadata.interrupted, true)
        assert.equal(audio.interrupt.callCount, 1)
      })

      it('retains known late text while unknown stale IDs cannot steal the next input', async () => {
        await start()
        response(2)
        event('interruption', 'interruption_event', 5)
        input(80)
        conversation.sendUserMessage('Next')
        response(3, 'Unknown stale')
        event('agent_response_correction', 'agent_response_correction_event', 2,
          { corrected_agent_response: 'Corrected' })
        output(6, 20)
        close()
        const { llmobsSpans } = await getEvents(6)
        const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
        assert.equal(llms[0].meta.output.messages[0].content, 'Corrected')
        assert.equal(llms[1].meta.input.messages[0].content, 'Next')
        wav(llms[1].meta.input.messages[0].audio_parts[0], 16000, pcm(80))
      })

      for (const audioFirst of [false, true]) {
        it(`owns boundary-ID response text despite SDK audio filtering (audioFirst=${audioFirst})`, async () => {
          await start()
          response(1, 'Greeting')
          conversation.sendUserMessage('Next question')
          event('interruption', 'interruption_event', 10)
          if (audioFirst) output(10, 20)
          response(10, 'Replacement answer')
          if (!audioFirst) output(10, 20)
          conversation.sendUserMessage('Later question')
          response(20, 'Later answer')
          close()
          const { llmobsSpans } = await getEvents(6)
          const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
          assert.equal(llms[1].meta.input.messages[0].content, 'Next question')
          assert.equal(llms[1].meta.output.messages[0].content, 'Replacement answer')
          assert.equal(llms[1].meta.output.messages[0].audio_parts, undefined)
          assert.equal(llms[1].meta.metadata.output_audio_omitted_reason, 'sdk_interruption_filter')
          assert.equal(llms[2].meta.input.messages[0].content, 'Later question')
          assert.equal(outputSpy.callCount, 0)
        })
      }

      it('observes VAD silence without changing clip bytes or placement', async () => {
        await start()
        vad(0.1)
        input(200, 0)
        vad(0.6)
        input(200)
        vad(0.1)
        input(200, 0)
        vad(0.1)
        response()
        close()
        const { llmobsSpans } = await getEvents(3)
        const user = byName(llmobsSpans, 'user speech')
        assert.deepEqual(user.meta.metadata.user_speech_activity,
          { version: 1, source: 'elevenlabs_vad', timing: 'estimated', intervals_ms: [[200, 400]] })
        assert.equal(user.duration, 600e6)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        wav(llm.meta.input.messages[0].audio_parts[0], 16000, Buffer.concat([pcm(200, 16000, 0), pcm(200), pcm(200,
          16000, 0)]))
      })

      for (const score of [undefined, null, true, '0.1', -1, 2]) {
        it(`falls back to phase colors for invalid VAD ${score}`, async () => {
          await start(); vad(score); input(20); response(); close()
          const { llmobsSpans } = await getEvents(3)
          assert.equal(byName(llmobsSpans, 'user speech').meta.metadata.user_speech_activity, undefined)
        })
      }

      it('restores tool context for nested calls and records actual tool execution', async () => {
        await start()
        const tracer = require('../../../../../..')
        let nested
        tools.register('weather', async () => {
          nested = tracer.llmobs.trace({ kind: 'workflow', name: 'nested' }, () => 'sunny')
          return 'sunny'
        })
        event('client_tool_call', 'client_tool_call', 1, {
          tool_name: 'weather',
          tool_call_id: 'call-1',
          parameters: { city: 'NYC' },
        })
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        assert.equal(nested, 'sunny')
        response()
        close()
        const { llmobsSpans } = await getEvents(4)
        const root = byName(llmobsSpans, 'elevenlabs audio turn')
        const tool = byName(llmobsSpans, 'weather')
        assert.equal(tool.parent_id, root.span_id)
        assert.equal(byName(llmobsSpans, 'nested').parent_id, tool.span_id)
        assert.equal(tool.meta.output.value, 'sunny')
        assert.equal(tool.meta['span.kind'], 'tool')
      })

      it('reports thrown tools without changing the SDK error result', async () => {
        await start()
        tools.register('broken', () => { throw new TypeError('tool failed') })
        event('client_tool_call', 'client_tool_call', 1, {
          tool_name: 'broken',
          tool_call_id: 'broken-1',
          parameters: {},
        })
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        assert.equal(socket.sent.at(-1).is_error, true)
        response()
        close()
        const { llmobsSpans } = await getEvents(3)
        const tool = byName(llmobsSpans, 'broken')
        assert.equal(tool.status, 'error')
        assert.equal(tool.meta['error.message'], 'tool failed')
      })

      it('bounds pending tool spans and finalizes them once across late settlement', async () => {
        await start()
        const Writer = require('../../../../src/llmobs/writers/spans')
        const appended = sinon.spy(Writer.prototype, 'append')
        const resolvers = []
        tools.register('pending', () => new Promise(resolve => resolvers.push(resolve)))
        try {
          for (let i = 0; i < 65; i++) {
            event('client_tool_call', 'client_tool_call', 1,
              { tool_name: 'pending', tool_call_id: 'duplicate', parameters: {} })
          }
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          assert.equal(resolvers.length, 65, 'all SDK handlers must execute')
          response(); close()
          const { llmobsSpans } = await getEvents(66)
          assert.equal(llmobsSpans.filter(span => span.name === 'pending').length, 64)
          const root = byName(llmobsSpans, 'elevenlabs audio turn')
          assert.equal(root.meta.metadata.tool_spans_omitted, true)
          assert.equal(root.meta.metadata.tool_execution_incomplete, true)
          const count = appended.callCount
          for (const finish of resolvers) finish('settled after shutdown')
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          assert.equal(appended.callCount, count)
        } finally { appended.restore() }
      })

      it('observes errors through a custom transport without adding error listeners', async () => {
        conversation.webSocketFactory = {
          create: () => ({
            readyState: 1, on: socket.on.bind(socket), send: socket.send.bind(socket), close: socket.close.bind(socket),
          }),
        }
        conversation.on('error', () => {})
        await start(); response()
        const listeners = conversation.listenerCount('error')
        socket.emit('error', new Error('custom transport failed'))
        assert.equal(conversation.listenerCount('error'), listeners)
        const { llmobsSpans } = await getEvents(2)
        assert.ok(llmobsSpans.every(span => span.status === 'error'))
      })

      it('does not fail a completed response on a later transport error', async () => {
        await start(); response(); event('agent_response_complete', 'agent_response_complete_event', 1)
        conversation.on('error', () => {})
        socket.emit('error', new Error('transport failed'))
        const { llmobsSpans } = await getEvents(2)
        assert.ok(llmobsSpans.every(span => span.status === 'ok'))
      })

      it('fails unfinished work on abnormal close and finalizes only once', async () => {
        await start(); response(); socket.emit('close', 1006, Buffer.alloc(0)); conversation.endSession()
        const { llmobsSpans } = await getEvents(2)
        assert.equal(llmobsSpans.length, 2)
        assert.ok(llmobsSpans.every(span => span.status === 'error'))
      })

      it('fails unfinished work on SDK dispatch errors while preserving SDK error handling', async () => {
        await start()
        response()
        const error = new Error('output interface failed')
        audio.output = () => { throw error }
        const logged = sinon.stub(console, 'error')
        try {
          output(1, 20)
          assert.equal(logged.firstCall.args[1], error)
          const { llmobsSpans } = await getEvents(2)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          assert.equal(llm.status, 'error')
          assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
        } finally { logged.restore() }
      })

      it('preserves shutdown exceptions and fails unfinished work exactly once', async () => {
        await start()
        response()
        audio.stop = () => { throw new TypeError('stop failed') }
        try {
          assert.throws(() => conversation.endSession(), { name: 'TypeError', message: 'stop failed' })
          const { llmobsSpans } = await getEvents(2)
          assert.ok(llmobsSpans.every(span => span.status === 'error'))
        } finally { audio.stop = () => {} }
      })

      it('preserves an ongoing session after a redundant failed start', async () => {
        await start(); response()
        await assert.rejects(conversation.startSession(), { message: 'Session already started' })
        output(1, 20); close()
        const { llmobsSpans } = await getEvents(3)
        assert.equal(byName(llmobsSpans, 'elevenlabs response').status, 'ok')
      })

      it('captures a finished caller parent and restores the event-processing context', async () => {
        const tracer = require('../../../../../..')
        await tracer.llmobs.trace({ kind: 'workflow', name: 'caller' }, start)
        const processing = tracer.startSpan('processing')
        tracer.scope().activate(processing, () => { input(20); response(); close() })
        assert.equal(tracer.scope().active(), null)
        processing.finish()
        const { llmobsSpans } = await getEvents(4)
        assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').parent_id, byName(llmobsSpans, 'caller').span_id)
      })

      it('captures explicit parent absence instead of adopting a later caller', async () => {
        const tracer = require('../../../../../..')
        await start()
        tracer.llmobs.trace({ kind: 'workflow', name: 'unrelated' }, () => { response(); close() })
        const { llmobsSpans } = await getEvents(3)
        assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').parent_id, 'undefined')
      })

      it('retries failed startup with the new caller', async () => {
        const tracer = require('../../../../../..')
        conversation.requiresAuth = true
        const error = new Error('auth failed')
        conversation.conversationClient = {
          conversationalAi: {
            conversations: {
              getSignedUrl: sinon.stub().rejects(error),
            },
          },
        }
        await assert.rejects(conversation.startSession(), { message: 'auth failed' })
        conversation.requiresAuth = false
        await tracer.llmobs.trace({ kind: 'workflow', name: 'retry' }, start)
        response(); close()
        const { llmobsSpans } = await getEvents(3)
        assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').parent_id, byName(llmobsSpans, 'retry').span_id)
      })

      it('preserves large provider IDs without rounding', async () => {
        await start()
        response('9007199254740993', 'First')
        response('9007199254740994', 'Second')
        close()
        const { llmobsSpans } = await getEvents(4)
        const ids = llmobsSpans.filter(span => span.name === 'elevenlabs response')
          .map(span => span.meta.metadata.event_id)
        assert.deepEqual(ids, ['9007199254740993', '9007199254740994'])
      })

      it('retains bounded audio sent before initiation metadata', async () => {
        const promise = conversation.startSession()
        socket.emit('open'); await promise
        input(20)
        socket.deliver({
          type: 'conversation_initiation_metadata',
          conversation_initiation_metadata_event: {
            conversation_id: 'conv-test', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
          },
        })
        response(); close()
        const { llmobsSpans } = await getEvents(3)
        wav(byName(llmobsSpans, 'elevenlabs response').meta.input.messages[0].audio_parts[0], 16000, pcm(20))
      })

      for (const mode of ['count', 'bytes']) {
        it(`omits the entire early clip after the ${mode} limit`, async () => {
          const promise = conversation.startSession()
          socket.emit('open'); await promise
          if (mode === 'count') for (let i = 0; i < 257; i++) input(1)
          else input(100_000)
          socket.deliver({
            type: 'conversation_initiation_metadata',
            conversation_initiation_metadata_event: {
              conversation_id: 'conv-test',
              user_input_audio_format: 'pcm_16000',
              agent_output_audio_format: 'pcm_24000',
            },
          })
          input(20); response(); close()
          const { llmobsSpans } = await getEvents(3)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          assert.equal(llm.meta.input.messages[0].audio_parts, undefined)
          assert.equal(llm.meta.metadata.audio_omitted, true)
        })
      }

      it('shares the audio budget and never exports an overflowed prefix', async () => {
        await start()
        input(60_000) // 1.92 MB raw input
        output(1, 40_000) // another 1.92 MB would exceed the shared 3 MiB raw bound
        response(); close()
        const { llmobsSpans } = await getEvents(4)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        assert.ok(llm.meta.input.messages[0].audio_parts)
        assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
        assert.equal(llm.meta.metadata.audio_omitted, true)
      })

      it('shares one tool-result budget across calls and duplicate result events', async () => {
        await start()
        for (const id of ['a', 'b']) {
          event('client_tool_call', 'client_tool_call', 1, { tool_name: 'remote', tool_call_id: id, parameters: {} })
          event('agent_tool_response_full_payload', 'agent_tool_response_full_payload', 1,
            { tool_call_id: id, full_tool_result: 'x'.repeat(70_000) })
        }
        event('agent_tool_response_full_payload', 'agent_tool_response_full_payload', 1,
          { tool_call_id: 'a', full_tool_result: 'y'.repeat(80_000) })
        response(); close()
        const { llmobsSpans } = await getEvents(2)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        const results = llm.meta.input.messages[0].tool_results
        assert.equal(results.reduce((size, result) => size + result.result.length, 0), 100_000)
        assert.equal(llm.meta.metadata.tool_results_truncated, true)
        assert.equal(llmobsSpans.some(span => span.meta['span.kind'] === 'tool'), false)
      })

      it('keeps unknown audio formats as transcript fallback', async () => {
        await start()
        socket.deliver({
          type: 'conversation_initiation_metadata',
          conversation_initiation_metadata_event: {
            conversation_id: 'conv-test', user_input_audio_format: 'opus_48000', agent_output_audio_format: 'ulaw_8000',
          },
        })
        input(20); response(); output(1, 20); close()
        const { llmobsSpans } = await getEvents(2)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        assert.equal(llm.meta.output.messages[0].content, 'Hello')
        assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
        assert.equal(llm.meta.metadata.audio_omitted, true)
      })

      it('extends the final microphone window and VAD through shutdown', async () => {
        await start()
        vad(0.1); input(100, 0); vad(0.1); response()
        input(100, 0); vad(0.1)
        close()
        const { llmobsSpans } = await getEvents(3)
        const user = byName(llmobsSpans, 'user speech')
        assert.equal(user.duration, 200e6)
        assert.deepEqual(user.meta.metadata.user_speech_activity.intervals_ms, [])
      })

      it('isolates concurrent conversations, tool calls, and tenant routing', async () => {
        const tracer = require('../../../../../..')
        const Writer = require('../../../../src/llmobs/writers/spans')
        const appended = sinon.stub(Writer.prototype, 'append').returns(true)
        const otherSocket = new Socket()
        const other = new Conversation({
          agentId: 'other',
          requiresAuth: false,
          clientTools: tools,
          audioInterface: { start () {}, stop () {}, output () {}, interrupt () {} },
          webSocketFactory: { create: () => otherSocket },
        })
        try {
          await tracer.llmobs.routingContext({ ddApiKey: 'tenant-a', ddSite: 'tenant-a.invalid' }, start)
          await tracer.llmobs.routingContext({ ddApiKey: 'tenant-b', ddSite: 'tenant-b.invalid' }, async () => {
            const promise = other.startSession(); otherSocket.emit('open'); await promise
          })
          tools.register('shared', () => 'tool result')
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'shared', tool_call_id: 'same-id', parameters: {} })
          otherSocket.deliver({
            type: 'client_tool_call',
            client_tool_call: {
              event_id: 1, tool_name: 'shared', tool_call_id: 'same-id', parameters: {},
            },
          })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(1, 'A')
          otherSocket.deliver({ type: 'agent_response', agent_response_event: { event_id: 1, agent_response: 'B' } })
          other.endSession(); close()
          const llmobsSpans = appended.getCalls().map(call => call.args[0])
          const roots = llmobsSpans.filter(span => span.name === 'elevenlabs audio turn')
          assert.equal(new Set(roots.map(span => span.trace_id)).size, 2)
          const children = llmobsSpans.filter(span => span.name === 'shared')
          assert.equal(new Set(children.map(span => span.parent_id)).size, 2)
          for (const call of appended.getCalls()) {
            const root = roots.find(root => root.trace_id === call.args[0].trace_id)
            assert.ok(root)
            const key = root.meta.output.value === 'A' ? 'tenant-a' : 'tenant-b'
            assert.deepEqual(call.args[1], { apiKey: key, site: `${key}.invalid` })
          }
        } finally { other.endSession(); appended.restore() }
      })

      it('honors the per-integration LLMObs opt-out and restores capture after re-enable', async () => {
        const tracer = require('../../../../../..')
        const dc = require('dc-polyfill')
        tracer.use('elevenlabs', { llmobs: false })
        try {
          assert.equal(dc.channel('dd-trace:elevenlabs:audio').hasSubscribers, false)
          await start(); input(20); response(); close()
          tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
          const { llmobsSpans, apmSpans } = await getEvents(1)
          assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
          assert.ok(apmSpans.some(span => span.name === 'elevenlabs.request'))
        } finally { tracer.use('elevenlabs', {}) }
        assert.equal(dc.channel('dd-trace:elevenlabs:audio').hasSubscribers, true)
      })

      it('annotates deferred spans, speech phases, and async tools before finish after re-enable', async () => {
        const tracer = require('../../../../../..')
        tracer.use('elevenlabs', { llmobs: false })
        tracer.use('elevenlabs', {})
        await start()
        tools.register('reenabled', async () => 'tool output')
        input(20)
        response()
        output(1, 20)
        event('client_tool_call', 'client_tool_call', 1,
          { tool_name: 'reenabled', tool_call_id: 'reenabled-call', parameters: {} })
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        close()
        const { llmobsSpans } = await getEvents(5)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        wav(llm.meta.input.messages[0].audio_parts[0], 16000, pcm(20))
        wav(llm.meta.output.messages[0].audio_parts[0], 24000, pcm(20, 24000, 9))
        assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').meta.output.value, 'Hello')
        assert.equal(byName(llmobsSpans, 'reenabled').meta.output.value, 'tool output')
        for (const span of llmobsSpans) assert.equal(span.meta.metadata.ttfa_eligible, false)
      })

      it('observes a replaced output handler without changing its receiver or return value', async () => {
        await start()
        const replacement = sinon.stub().returns('output accepted')
        audio.output = replacement
        output(1, 20)
        close()
        const { llmobsSpans } = await getEvents(3)
        assert.equal(replacement.callCount, 1)
        assert.equal(replacement.firstCall.thisValue, audio)
        wav(byName(llmobsSpans, 'elevenlabs response').meta.output.messages[0].audio_parts[0],
          24000, pcm(20, 24000, 9))
        assert.equal(audio.output(Buffer.alloc(0)), 'output accepted')
      })

      it('preserves callbacks, selected events, sends, and audio interfaces', async () => {
        const callback = sinon.spy()
        conversation.callbackMessageReceived = callback
        await start(); input(20); response(); output(1, 20)
        close()
        await getEvents(4)
        assert.equal(callback.callCount, 3)
        assert.equal(audio.start.callCount, 1)
        assert.equal(outputSpy.callCount, 1)
        assert.deepEqual(socket.sent[0], {
          type: 'conversation_initiation_client_data',
          custom_llm_extra_body: {},
          conversation_config_override: {},
          dynamic_variables: {},
        })
        assert.equal(socket.sent[1].user_audio_chunk, pcm(20).toString('base64'))
      })
    })
  })
})
