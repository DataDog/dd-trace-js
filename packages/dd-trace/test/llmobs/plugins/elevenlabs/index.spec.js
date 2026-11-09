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

      const rawAudioFrames = [
        ['canonical', '{"user_audio_chunk":"BwcHBw=="}'],
        ['leading whitespace', ' {"user_audio_chunk":"BwcHBw=="}'],
        ['extra field', '{"user_audio_chunk":"BwcHBw==","other":true}'],
        ['second key', '{"other":true,"user_audio_chunk":"BwcHBw=="}'],
        ['escaped value', '{"user_audio_chunk":"\\u0042wcHBw=="}'],
      ]
      for (const [label, raw] of rawAudioFrames) {
        it(`captures equivalent microphone samples from ${label} JSON`, async () => {
          await start()
          socket.send(raw)
          response(); close()
          const { llmobsSpans } = await getEvents(3)
          wav(byName(llmobsSpans, 'elevenlabs response').meta.input.messages[0].audio_parts[0],
            16000, Buffer.alloc(4, 7))
        })
      }

      it('keeps multiple protocol response IDs, streaming parts, and corrections within a turn', async () => {
        await start()
        event('agent_response', 'agent_response_event', 1, { response_id: 'a', agent_response: 'Same' })
        event('agent_chat_response_part', 'text_response_part', 1,
          { response_id: 'b', type: 'start', text: 'Second ' })
        event('agent_chat_response_part', 'text_response_part', 1,
          { response_id: 'b', type: 'delta', text: 'answer' })
        event('agent_chat_response_part', 'text_response_part', 1,
          { response_id: 'b', type: 'stop', text: '.' })
        event('agent_response_correction', 'agent_response_correction_event', 1,
          { response_id: 'a', original_agent_response: 'Same', corrected_agent_response: 'Corrected' })
        event('agent_response', 'agent_response_event', 1, { response_id: 'c', agent_response: 'Same' })
        event('agent_response', 'agent_response_event', 1, { response_id: 'd', agent_response: 'Same' })
        clock.tick(100)
        event('agent_chat_response_part', 'text_response_part', 1,
          { response_id: 'a', type: 'delta', text: 'late part' })
        close()
        const { llmobsSpans } = await getEvents(2)
        assert.equal(byName(llmobsSpans, 'elevenlabs response').meta.output.messages[0].content,
          'Corrected\nSecond answer.\nSame\nSame')
      })

      for (const [typed, audioFirst] of [[false, false], [true, false], [false, true], [true, true]]) {
        it(`preserves early model metadata, typed=${typed}, audioFirst=${audioFirst}`, async () => {
          await start()
          event('context_usage', 'context_usage_event', 1,
            { model: 'early-model', context_tokens: 99, context_limit_tokens: 1000 })
          if (typed) conversation.sendUserMessage('Typed after metadata')
          if (audioFirst) { output(1, 20); clock.tick(20) }
          response(); close()
          const { llmobsSpans } = await getEvents(audioFirst ? 3 : 2)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          assert.equal(llm.meta.model_name, 'early-model')
          assert.equal(llm.meta.metadata.configured_llm, 'early-model')
          assert.deepEqual(llm.metrics, {})
          if (typed) assert.equal(llm.meta.input.messages[0].content, 'Typed after metadata')
        })
      }

      it('does not create a turn from model metadata alone', async () => {
        await start()
        event('context_usage', 'context_usage_event', 1, { model: 'no-response-model' })
        conversation.endSession()
        require('../../../../../..').llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
        const { llmobsSpans } = await getEvents(1)
        assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
      })

      it('bounds early model hints and keeps them on their matching response IDs', async () => {
        await start()
        for (const id of [1, 2, 3]) event('context_usage', 'context_usage_event', id, { model: `model-${id}` })
        for (const id of [1, 2, 3]) response(id)
        close()
        const { llmobsSpans } = await getEvents(6)
        const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
        assert.notEqual(llms[0].meta.model_name, 'model-1')
        assert.equal(llms[1].meta.model_name, 'model-2')
        assert.equal(llms[2].meta.model_name, 'model-3')
      })

      it('ignores finalized model hints without displacing metadata for upcoming responses', async () => {
        await start()
        for (const id of [1, 2, 3]) response(id)
        for (const id of [4, 5, 1]) event('context_usage', 'context_usage_event', id, { model: `model-${id}` })
        response(4); response(5); close()
        const { llmobsSpans } = await getEvents(10)
        const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
        assert.equal(llms[3].meta.model_name, 'model-4')
        assert.equal(llms[4].meta.model_name, 'model-5')
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

      for (const mode of ['interruption', 'close']) {
        for (const gap of [0, 100]) {
          it(`trims a playback gap using queued audio on ${mode}, gap=${gap}`, async () => {
            await start()
            response(); output(1, 20)
            clock.tick(20 + gap)
            output(1, 100)
            clock.tick(10)
            if (mode === 'interruption') {
              event('interruption', 'interruption_event', 2)
              // A repeated cut and later close must not subtract queued samples twice.
              event('interruption', 'interruption_event', 2)
              close()
            } else {
              conversation.endSession()
            }
            const { llmobsSpans } = await getEvents(3)
            const llm = byName(llmobsSpans, 'elevenlabs response')
            wav(llm.meta.output.messages[0].audio_parts[0], 24000, pcm(30, 24000, 9))
            assert.equal(llm.meta.metadata.interrupted, mode === 'interruption')
            assert.equal(byName(llmobsSpans, 'agent speech').duration, (30 + gap) * 1e6)
            assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').duration, (30 + gap) * 1e6)
          })
        }
      }

      for (const gap of [0, 100]) {
        it(`preserves delivery gaps in completed agent speech, gap=${gap}`, async () => {
          await start()
          const began = Date.now()
          response(); output(1, 20)
          clock.tick(20 + gap)
          output(1, 20)
          close()
          const { llmobsSpans } = await getEvents(3)
          const speech = byName(llmobsSpans, 'agent speech')
          const root = byName(llmobsSpans, 'elevenlabs audio turn')
          assert.equal(speech.start_ns, began * 1e6)
          assert.equal(speech.duration, (40 + gap) * 1e6)
          assert.equal(root.duration, speech.duration)
          wav(byName(llmobsSpans, 'elevenlabs response').meta.output.messages[0].audio_parts[0],
            24000, pcm(40, 24000, 9))
        })
      }

      for (const textFirst of [false, true]) {
        for (const recover of [false, true]) {
          it(`omits failed output delivery, textFirst=${textFirst}, recover=${recover}`, async () => {
            await start()
            if (textFirst) response()
            const error = new TypeError('output rejected')
            audio.output = () => { throw error }
            const logged = sinon.stub(console, 'error')
            try {
              output(1, 200)
              assert.equal(logged.firstCall.args[1], error)
              if (!textFirst) response()
              clock.tick(300)
              if (recover) {
                audio.output = outputSpy
                output(1, 20)
                close()
              } else {
                conversation.on('error', () => {})
                socket.emit('error', new Error('transport failed after rejected audio'))
              }
              const { llmobsSpans } = await getEvents(recover ? 3 : 2)
              const llm = byName(llmobsSpans, 'elevenlabs response')
              assert.equal(llm.status, recover ? 'ok' : 'error')
              assert.equal(outputSpy.callCount, recover ? 1 : 0)
              if (recover) {
                wav(llm.meta.output.messages[0].audio_parts[0], 24000, pcm(20, 24000, 9))
                assert.equal(byName(llmobsSpans, 'agent speech').duration, 20e6)
              } else {
                assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
                assert.equal(llmobsSpans.some(span => span.name === 'agent speech'), false)
              }
            } finally { logged.restore() }
          })
        }
      }

      it('keeps the earliest typed send time and resets it for the next turn', async () => {
        await start()
        const first = Date.now()
        conversation.sendUserMessage('First')
        clock.tick(125)
        conversation.sendUserMessage('More input')
        clock.tick(375)
        response(1)
        clock.tick(100)
        const second = Date.now()
        conversation.sendUserMessage('Second')
        clock.tick(250)
        response(2); close()
        const { llmobsSpans } = await getEvents(4)
        const roots = llmobsSpans.filter(span => span.name === 'elevenlabs audio turn')
        assert.equal(roots[0].start_ns, first * 1e6)
        assert.equal(roots[0].duration, 500e6)
        assert.equal(roots[1].start_ns, second * 1e6)
        assert.equal(roots[1].duration, 250e6)
      })

      for (const typedFirst of [false, true]) {
        it(`uses the earliest typed send or microphone start, typedFirst=${typedFirst}`, async () => {
          await start()
          const began = Date.now()
          if (typedFirst) conversation.sendUserMessage('Typed before audio')
          input(20)
          if (!typedFirst) conversation.sendUserMessage('Typed after audio')
          clock.tick(100); response(); close()
          const { llmobsSpans } = await getEvents(3)
          assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').start_ns, began * 1e6)
        })
      }

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

      for (const mode of ['sync', 'promise', 'thenable']) {
        it(`finishes a ${mode} tool with its output and execution duration`, async () => {
          await start()
          tools.register('completion', () => {
            if (mode === 'thenable') return { then (resolve) { clock.tick(7); resolve('tool result') } }
            clock.tick(7)
            return mode === 'promise' ? Promise.resolve('tool result') : 'tool result'
          })
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'completion', tool_call_id: 'completion-call', parameters: {} })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(3)
          const tool = byName(llmobsSpans, 'completion')
          assert.equal(tool.meta.output.value, 'tool result')
          assert.equal(tool.duration, 7e6)
          assert.equal(tool.status, 'ok')
          assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').meta.metadata.tool_execution_incomplete, undefined)
          assert.equal(socket.sent.at(-1).result, 'tool result')
        })
      }

      for (const reject of [false, true]) {
        it(`runs a lazy thenable once and shares its SDK/span result, reject=${reject}`, async () => {
          await start()
          let calls = 0
          tools.register('lazy', () => ({
            then (resolve, fail) {
              calls++
              clock.tick(7)
              if (reject) fail(new TypeError(`lazy failure ${calls}`))
              else resolve(`lazy result ${calls}`)
            },
          }))
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'lazy', tool_call_id: 'lazy-call', parameters: {} })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(3)
          const tool = byName(llmobsSpans, 'lazy')
          assert.equal(calls, 1)
          assert.equal(tool.duration, 7e6)
          assert.equal(socket.sent.at(-1).is_error, reject)
          assert.equal(socket.sent.at(-1).result, reject ? 'lazy failure 1' : 'lazy result 1')
          assert.equal(tool.status, reject ? 'error' : 'ok')
          if (reject) assert.equal(tool.meta['error.message'], 'lazy failure 1')
          else assert.equal(tool.meta.output.value, 'lazy result 1')
        })
      }

      for (const kind of ['object', 'function']) {
        for (const outcome of ['resolve', 'reject', 'non-callable', 'throw']) {
          it(`assimilates a ${kind} tool result once when then will ${outcome}`, async () => {
            await start()
            let reads = 0
            const result = kind === 'function' ? function () {} : { value: 'plain result' }
            Object.defineProperty(result, 'then', {
              get () {
                reads++
                if (reads > 1) throw new Error('then read twice')
                if (outcome === 'throw') throw new TypeError('then getter failed')
                if (outcome === 'non-callable') return 42
                return function (resolve, reject) {
                  assert.equal(this, result)
                  clock.tick(7)
                  if (outcome === 'reject') reject(new TypeError('then rejected'))
                  else resolve('then resolved')
                }
              },
            })
            tools.register('accessor-result', () => result)
            event('client_tool_call', 'client_tool_call', 1,
              { tool_name: 'accessor-result', tool_call_id: 'accessor-call', parameters: {} })
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
            response(); close()
            const { llmobsSpans } = await getEvents(3)
            const tool = byName(llmobsSpans, 'accessor-result')
            assert.equal(reads, 1)
            const failed = outcome === 'throw' || outcome === 'reject'
            assert.equal(socket.sent.at(-1).is_error, failed)
            assert.equal(tool.status, failed ? 'error' : 'ok')
            if (failed) {
              const message = outcome === 'throw' ? 'then getter failed' : 'then rejected'
              assert.equal(socket.sent.at(-1).result, message)
              assert.equal(tool.meta['error.message'], message)
            } else if (outcome === 'resolve') {
              assert.equal(socket.sent.at(-1).result, 'then resolved')
              assert.equal(tool.meta.output.value, 'then resolved')
              assert.equal(tool.duration, 7e6)
            } else {
              assert.deepEqual(socket.sent.at(-1).result, kind === 'object' ? { value: 'plain result' } : undefined)
            }
          })
        }
      }

      for (const async of [false, true]) {
        for (const outcome of ['value', 'nested', 'throw']) {
          it(`captures serialized tool output, async=${async}, outcome=${outcome}`, async () => {
            await start()
            let serializations = 0
            const value = {
              toJSON () {
                serializations++
                clock.tick(11)
                if (outcome === 'throw') throw new TypeError('serialization failed')
                if (serializations > 1) throw new Error('serialized twice')
                return { count: serializations }
              },
            }
            const result = outcome === 'nested' ? { nested: value } : value
            tools.register('serialized-result', () => {
              clock.tick(7)
              return async ? Promise.resolve(result) : result
            })
            event('client_tool_call', 'client_tool_call', 1,
              { tool_name: 'serialized-result', tool_call_id: 'serialized-call', parameters: {} })
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
            response(); close()
            const { llmobsSpans } = await getEvents(3)
            assert.equal(serializations, 1)
            const sent = socket.sent.at(-1)
            assert.equal(sent.is_error, outcome === 'throw')
            const expected = outcome === 'throw'
              ? 'serialization failed'
              : outcome === 'nested' ? { nested: { count: 1 } } : { count: 1 }
            assert.deepEqual(sent.result, expected)
            const text = typeof expected === 'string' ? expected : JSON.stringify(expected)
            const tool = byName(llmobsSpans, 'serialized-result')
            assert.equal(tool.meta.output.value, text)
            assert.equal(tool.duration, 7e6)
            assert.equal(tool.status, outcome === 'throw' ? 'error' : 'ok')
            const llm = byName(llmobsSpans, 'elevenlabs response')
            assert.equal(llm.meta.input.messages[0].tool_results[0].result, text)
          })
        }
      }

      for (const size of [100_000 - 11, 100_000 - 10, 2 * 1024 * 1024]) {
        it(`uses bounded tool input at argument size ${size}`, async () => {
          await start()
          const handler = sinon.stub().returns('done')
          tools.register('bounded-input', handler)
          const parameters = { text: 'x'.repeat(size) }
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'bounded-input', tool_call_id: 'input-call', parameters })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(3)
          const tool = byName(llmobsSpans, 'bounded-input')
          assert.equal(handler.firstCall.args[0].text.length, size)
          assert.deepEqual(JSON.parse(tool.meta.input.value), size + 11 <= 100_000 ? parameters : {})
          assert.equal(tool.collection_errors, undefined)
          assert.ok(Buffer.byteLength(JSON.stringify(tool)) < 110_000)
        })
      }

      it('keeps bounded tool input tied to each invocation when a call ID is reused', async () => {
        await start()
        const complete = []
        tools.register('reuse', () => new Promise(resolve => complete.push(resolve)))
        for (const label of ['first', 'second']) {
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'reuse', tool_call_id: 'same', parameters: { label } })
        }
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        for (const resolve of complete) resolve('done')
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        response(); close()
        const { llmobsSpans } = await getEvents(4)
        const inputs = llmobsSpans.filter(span => span.name === 'reuse').map(span => JSON.parse(span.meta.input.value))
        assert.deepEqual(inputs, [{ label: 'first' }, { label: 'second' }])
      })

      for (const count of [64, 65]) {
        it(`marks omitted calls only past the call-count limit, count=${count}`, async () => {
          await start()
          const handler = sinon.stub().returns('done')
          tools.register('counted', handler)
          for (let i = 0; i < count; i++) {
            event('client_tool_call', 'client_tool_call', 1,
              { tool_name: 'counted', tool_call_id: `count-${i}`, parameters: {} })
          }
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(66)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          assert.equal(handler.callCount, count)
          assert.equal(llm.meta.output.messages[0].tool_calls.length, 64)
          assert.equal(llm.meta.metadata.tool_calls_omitted, count === 65 ? true : undefined)
          assert.equal(socket.sent.at(-1).tool_call_id, `count-${count - 1}`)
        })
      }

      it('keeps existing call updates at the call-count limit without claiming omissions', async () => {
        await start()
        for (let i = 0; i < 64; i++) {
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'remote', tool_call_id: `call-${i}`, parameters: {} })
        }
        event('client_tool_call', 'client_tool_call', 1,
          { tool_name: 'remote', tool_call_id: 'call-63', parameters: { updated: true } })
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        response(); close()
        const { llmobsSpans } = await getEvents(2)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        const calls = llm.meta.output.messages[0].tool_calls
        assert.equal(calls.length, 64)
        assert.deepEqual(calls[63].arguments, { updated: true })
        assert.equal(llm.meta.metadata.tool_calls_omitted, undefined)
      })

      for (const length of [1024, 1025, 100_000]) {
        it(`bounds tool names across a full turn at name length ${length}`, async () => {
          await start()
          const names = Array.from({ length: 64 }, (_, i) => `${i}:` + '界'.repeat(length - String(i).length - 1))
          const handler = sinon.stub().returns('done')
          for (const name of names) tools.register(name, handler)
          for (let i = 0; i < names.length; i++) {
            event('client_tool_call', 'client_tool_call', 1,
              { tool_name: names[i], tool_call_id: `name-${i}`, parameters: {} })
          }
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(66)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          const calls = llm.meta.output.messages[0].tool_calls
          assert.equal(handler.callCount, 64)
          assert.equal(calls.length, 64)
          assert.ok(calls.every(call => call.name.length <= 1024))
          assert.equal(llm.meta.metadata.tool_names_truncated, length > 1024 ? true : undefined)
          assert.equal(llm.collection_errors, undefined)
          assert.ok(Buffer.byteLength(JSON.stringify(llm)) < 300_000)
        })
      }

      it('records rejected async tools and preserves the SDK error response', async () => {
        await start()
        tools.register('rejecting', async () => { clock.tick(9); throw new RangeError('tool rejected') })
        event('client_tool_call', 'client_tool_call', 1,
          { tool_name: 'rejecting', tool_call_id: 'rejecting-call', parameters: {} })
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        response(); close()
        const { llmobsSpans } = await getEvents(3)
        const tool = byName(llmobsSpans, 'rejecting')
        assert.equal(tool.status, 'error')
        assert.equal(tool.meta['error.message'], 'tool rejected')
        assert.equal(tool.duration, 9e6)
        assert.equal(socket.sent.at(-1).is_error, true)
      })

      for (const disabled of [false, true]) {
        it(`traces tools registered before a session while disabled=${disabled}`, async () => {
          const tracer = require('../../../../../..')
          if (disabled) tracer.use('elevenlabs', false)
          try { tools.register('early-tool', () => 'registered early') } finally { tracer.use('elevenlabs', {}) }
          await start()
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'early-tool', tool_call_id: 'early-tool-call', parameters: {} })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          response(); close()
          const { llmobsSpans } = await getEvents(3)
          assert.equal(byName(llmobsSpans, 'early-tool').meta.output.value, 'registered early')
        })
      }

      for (const length of [1024, 1025, 2 * 1024 * 1024]) {
        it(`bounds retained tool IDs at length ${length} without blocking SDK execution`, async () => {
          await start()
          const handler = sinon.stub().returns('result')
          tools.register('bounded-id', handler)
          const id = 'i'.repeat(length)
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'bounded-id', tool_call_id: id, parameters: {} })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          event('agent_tool_response_full_payload', 'agent_tool_response_full_payload', 1,
            { tool_call_id: id, full_tool_result: 'provider result' })
          response(); close()
          const { llmobsSpans } = await getEvents(length <= 1024 ? 3 : 2)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          assert.equal(handler.callCount, 1)
          assert.equal(handler.firstCall.args[0].tool_call_id, id)
          assert.equal(socket.sent.at(-1).tool_call_id, id)
          if (length <= 1024) {
            assert.equal(llm.meta.output.messages[0].tool_calls[0].tool_id, id)
            assert.equal(llm.meta.input.messages[0].tool_results[0].tool_id, id)
          } else {
            assert.equal(llm.meta.output.messages[0].tool_calls, undefined)
            assert.equal(llm.meta.input.messages[0].tool_results, undefined)
            assert.equal(llm.meta.metadata.tool_calls_omitted, true)
            assert.ok(Buffer.byteLength(JSON.stringify(llm)) < 10_000)
          }
        })
      }

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

      for (const mode of ['shutdown', 'eviction']) {
        it(`encloses a pending tool in its turn when forced by ${mode}`, async () => {
          await start()
          /** @type {((value: string) => void) | undefined} */
          let complete
          tools.register('forced', () => new Promise(resolve => { complete = resolve }))
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'forced', tool_call_id: 'forced-call', parameters: {} })
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
          clock.tick(125)
          if (mode === 'eviction') { response(2); response(3) }
          close()
          const { llmobsSpans } = await getEvents(mode === 'eviction' ? 7 : 3)
          const tool = byName(llmobsSpans, 'forced')
          const root = llmobsSpans.find(span => span.span_id === tool.parent_id)
          assert.ok(root)
          assert.ok(root.start_ns + root.duration >= tool.start_ns + tool.duration)
          assert.equal(root.meta.metadata.tool_execution_incomplete, true)
          assert.ok(complete)
          complete('after forced finish')
          for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        })
      }

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

      for (const elapsed of [19, 20]) {
        it(`attributes transport failure after ${elapsed}ms of a 20ms response`, async () => {
          await start(); response(); output(1, 20)
          clock.tick(elapsed)
          conversation.on('error', () => {})
          socket.emit('error', new Error('later transport error'))
          const { llmobsSpans } = await getEvents(3)
          const expected = elapsed === 20 ? 'ok' : 'error'
          assert.equal(byName(llmobsSpans, 'elevenlabs response').status, expected)
          assert.equal(byName(llmobsSpans, 'elevenlabs audio turn').status, expected)
        })
      }

      it('accepts a real stream stop as final text and waits out queued playback gaps', async () => {
        await start()
        event('agent_chat_response_part', 'text_response_part', 1, { type: 'start', text: 'Hello' })
        output(1, 10)
        clock.tick(100)
        output(1, 20)
        event('agent_chat_response_part', 'text_response_part', 1, { type: 'stop', text: '.' })
        clock.tick(20)
        conversation.on('error', () => {})
        socket.emit('error', new Error('after playback'))
        const { llmobsSpans } = await getEvents(3)
        assert.equal(byName(llmobsSpans, 'elevenlabs response').status, 'ok')
      })

      it('keeps a response unfinished when final text is still missing after audio', async () => {
        await start(); output(1, 20); clock.tick(20)
        conversation.on('error', () => {})
        socket.emit('error', new Error('before final text'))
        const { llmobsSpans } = await getEvents(3)
        assert.equal(byName(llmobsSpans, 'elevenlabs response').status, 'error')
      })

      it('fails unfinished work on abnormal close and finalizes only once', async () => {
        await start(); response(); socket.emit('close', 1006, Buffer.alloc(0)); conversation.endSession()
        const { llmobsSpans } = await getEvents(2)
        assert.equal(llmobsSpans.length, 2)
        assert.ok(llmobsSpans.every(span => span.status === 'error'))
      })

      for (const target of ['callbackAgentResponse', 'callbackMessageReceived', 'output']) {
        it(`keeps tracing after a caught ${target} exception`, async () => {
          await start()
          const holder = target === 'output' ? audio : conversation
          const previous = holder[target]
          const error = new Error(`${target} failed`)
          holder[target] = () => { throw error }
          const logged = sinon.stub(console, 'error')
          try {
            response(1, 'First answer')
            if (target === 'output') output(1, 20)
            assert.equal(logged.firstCall.args[1], error)
            holder[target] = previous
            if (target !== 'output') output(1, 20)
            clock.tick(100)
            response(2, 'Second answer')
            output(2, 20)
            close()
            const { llmobsSpans } = await getEvents(target === 'output' ? 5 : 6)
            const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
            if (target === 'output') assert.equal(llms[0].meta.output.messages[0].audio_parts, undefined)
            assert.deepEqual(llms.map(llm => llm.meta.output.messages[0].content), ['First answer', 'Second answer'])
            assert.ok(llmobsSpans.every(span => span.status === 'ok'))
          } finally { holder[target] = previous; logged.restore() }
        })
      }

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

      it('reserves multibyte text and tool payloads before spending the audio budget', async () => {
        await start()
        const text = '界'.repeat(100_000)
        input(60_000)
        conversation.sendUserMessage(text)
        event('client_tool_call', 'client_tool_call', 1,
          { tool_name: 'remote', tool_call_id: 'payload-call', parameters: { text: text.slice(11) } })
        event('agent_tool_response_full_payload', 'agent_tool_response_full_payload', 1,
          { tool_call_id: 'payload-call', full_tool_result: text })
        response(1, text)
        output(1, 25_000)
        clock.tick(25_000)
        close()
        const { llmobsSpans } = await getEvents(4)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        assert.equal(llm.meta.input.messages[0].content, text)
        assert.equal(llm.meta.output.messages[0].content, text)
        assert.equal(llm.meta.input.messages[0].tool_results[0].result, text)
        assert.equal(llm.meta.output.messages[0].tool_calls[0].arguments.text, text.slice(11))
        assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
        assert.equal(llm.meta.metadata.audio_omitted, true)
        assert.equal(llm.collection_errors, undefined)
        const { EVP_EVENT_SIZE_LIMIT } = require('../../../../src/llmobs/constants/writers')
        assert.ok(Buffer.byteLength(JSON.stringify(llm)) < EVP_EVENT_SIZE_LIMIT)
        wav(llm.meta.input.messages[0].audio_parts[0], 16000, pcm(60_000))
      })

      it('does not turn accepted queue hold audio into agent speech or consume pending input', async () => {
        await start(); input(20)
        socket.deliver({ type: 'queue_status', queue_status_event: { status: 'waiting' } })
        output(1, 100)
        socket.deliver({ type: 'queue_status', queue_status_event: { status: 'admitted' } })
        response(2, 'Admitted answer'); output(2, 20); close()
        const { llmobsSpans } = await getEvents(4)
        const llms = llmobsSpans.filter(span => span.name === 'elevenlabs response')
        assert.equal(llms.length, 1)
        assert.equal(llms[0].meta.metadata.event_id, '2')
        wav(llms[0].meta.input.messages[0].audio_parts[0], 16000, pcm(20))
        wav(llms[0].meta.output.messages[0].audio_parts[0], 24000, pcm(20, 24000, 9))
        assert.equal(outputSpy.callCount, 2, 'SDK hold playback must remain unchanged')
      })

      it('emits no agent turn when the call queue times out', async () => {
        await start()
        socket.deliver({ type: 'queue_status', queue_status_event: { status: 'waiting' } })
        output(1, 100)
        socket.deliver({ type: 'queue_status', queue_status_event: { status: 'timed_out' } })
        output(1, 100)
        socket.emit('close', 4300, Buffer.from('queue timeout'))
        require('../../../../../..').llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
        const { llmobsSpans } = await getEvents(1)
        assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
      })

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

      for (const excess of [0, 1]) {
        it(`applies the argument budget at the exact limit plus ${excess}`, async () => {
          await start()
          const size = 100_000 - JSON.stringify({ text: '' }).length + excess
          event('client_tool_call', 'client_tool_call', 1,
            { tool_name: 'remote', tool_call_id: 'argument-limit', parameters: { text: 'x'.repeat(size) } })
          response(); close()
          const { llmobsSpans } = await getEvents(2)
          const llm = byName(llmobsSpans, 'elevenlabs response')
          const args = llm.meta.output.messages[0].tool_calls[0].arguments
          if (excess) assert.deepEqual(args, {})
          else assert.equal(args.text.length, size)
          assert.equal(llm.meta.metadata.tool_arguments_truncated, excess ? true : undefined)
        })
      }

      it('accounts for argument replacements and preserves the shared argument limit', async () => {
        await start()
        const call = (id, size) => event('client_tool_call', 'client_tool_call', 1,
          { tool_name: 'remote', tool_call_id: id, parameters: { text: 'x'.repeat(size) } })
        call('a', 70_000)
        call('a', 70_001) // replaces its prior argument size, rather than counting it twice
        call('b', 40_000) // exceeds the remaining shared budget
        response(); close()
        const { llmobsSpans } = await getEvents(2)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        const calls = llm.meta.output.messages[0].tool_calls
        assert.equal(calls[0].arguments.text.length, 70_001)
        assert.deepEqual(calls[1].arguments, {})
        assert.equal(llm.meta.metadata.tool_arguments_truncated, true)
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

      for (const early of [false, true]) {
        for (const format of ['ulaw_8000', 'opus_48000']) {
          it(`marks unsupported ${format} input omitted when early=${early}`, async () => {
            const started = conversation.startSession()
            socket.emit('open'); await started
            if (early) input(20)
            socket.deliver({
              type: 'conversation_initiation_metadata',
              conversation_initiation_metadata_event: {
                conversation_id: 'conv-test', user_input_audio_format: format, agent_output_audio_format: 'pcm_24000',
              },
            })
            if (!early) input(20)
            response(); close()
            const { llmobsSpans } = await getEvents(2)
            const llm = byName(llmobsSpans, 'elevenlabs response')
            assert.equal(llm.meta.input.messages[0].content, '[audio]')
            assert.equal(llm.meta.input.messages[0].audio_parts, undefined)
            assert.equal(llm.meta.metadata.audio_omitted, true)
          })
        }
      }

      it('does not claim omitted input when unsupported negotiation has no microphone audio', async () => {
        await start()
        socket.deliver({
          type: 'conversation_initiation_metadata',
          conversation_initiation_metadata_event: {
            conversation_id: 'conv-test', user_input_audio_format: 'ulaw_8000', agent_output_audio_format: 'pcm_24000',
          },
        })
        conversation.sendUserMessage('Typed only'); response(); close()
        const { llmobsSpans } = await getEvents(2)
        const llm = byName(llmobsSpans, 'elevenlabs response')
        assert.equal(llm.meta.input.messages[0].content, 'Typed only')
        assert.equal(llm.meta.metadata.audio_omitted, undefined)
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
