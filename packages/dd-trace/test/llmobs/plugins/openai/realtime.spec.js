'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { flushLiveSessions } = require('../../../../../datadog-instrumentations/src/openai-realtime')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, useLlmObs, MOCK_STRING } = require('../../util')
const { FakeRealtimeSocket, Mic, installFakeSocket, pcm16 } = require('./realtime/fake-socket')

const MS = 1_000_000 // nanoseconds per millisecond

// Deliberately a small epoch. Span events carry `start_ns` as a JS number, and at a present-day
// epoch that is ~1.7e21 — well past `Number.MAX_SAFE_INTEGER` — so differences between two spans'
// timestamps would be quantized to ~0.26ms and no window assertion could be exact. Starting the
// fake clock near zero keeps every timestamp inside the safe integer range.
const CLOCK_START = 1_000_000

const TURN_ROOT = 'realtime audio turn'
const USER_SPEECH = 'user speech'
const AGENT_SPEECH = 'agent speech'
const LLM = 'OpenAI.createRealtimeResponse'

/**
 * The spans keyed by their LLM Observability name, with boundaries in nanoseconds.
 *
 * Read off the span events rather than the paired APM spans: these are the numbers the backend
 * derives time-to-first-agent-audio from, and both come from the same `_startTime`. Capture this
 * before calling `assertLlmObsSpanEvent`, which mutates the event it is given.
 *
 * @param {object[]} llmobsSpans
 * @returns {Record<string, { start: number, end: number }>}
 */
function timeline (llmobsSpans) {
  const windows = {}
  for (const span of llmobsSpans) {
    windows[span.name] = { start: span.start_ns, end: span.start_ns + span.duration }
  }
  return windows
}

/**
 * Pair each LLM Observability span event with its APM span by id. Never by sorted index: the turn
 * root and the user-speech span share a start timestamp, so index pairing is tie-fragile.
 *
 * @param {object[]} apmSpans
 * @returns {Map<string, object>}
 */
function apmSpansById (apmSpans) {
  return new Map(apmSpans.map(span => [span.span_id.toString(10), span]))
}

/**
 * @param {object[]} llmobsSpans
 * @param {string} name
 * @returns {object}
 */
function byName (llmobsSpans, name) {
  const span = llmobsSpans.find(candidate => candidate.name === name)
  assert.ok(span, `expected an LLMObs span named "${name}", got: ${llmobsSpans.map(s => s.name).join(', ')}`)
  return span
}

/**
 * @param {object[]} llmobsSpans
 * @returns {string[]}
 */
function names (llmobsSpans) {
  return llmobsSpans.map(span => span.name)
}

/**
 * Assert an audio part is a WAV clip of exactly `durationMs` at `sampleRate`, by reading the header
 * the UI would read. Pinning the duration is what proves the pre-speech lead-in was trimmed off, and
 * that a barge-in cap kept only what was heard.
 *
 * Returns the raw content so it can be fed back into the strict span-event diff, which — unlike the
 * mock-tolerant output side — compares input messages exactly.
 *
 * @param {{ mime_type: string, content: string }} audioPart
 * @param {{ durationMs: number, sampleRate: number }} expected
 * @returns {string}
 */
function assertWavClip (audioPart, { durationMs, sampleRate }) {
  assert.strictEqual(audioPart.mime_type, 'audio/wav')

  const wav = Buffer.from(audioPart.content, 'base64')
  const dataBytes = durationMs * sampleRate * 2 / 1000 // PCM16 is 2 bytes per sample

  assert.strictEqual(wav.toString('latin1', 0, 4), 'RIFF')
  assert.strictEqual(wav.toString('latin1', 8, 12), 'WAVE')
  assert.strictEqual(wav.readUInt16LE(22), 1, 'should be mono')
  assert.strictEqual(wav.readUInt32LE(24), sampleRate)
  assert.strictEqual(wav.readUInt32LE(40), dataBytes, `WAV should hold ${durationMs}ms of audio`)
  assert.strictEqual(wav.length, 44 + dataBytes)

  return audioPart.content
}

/**
 * Drain whatever LLM Observability span events the agent has received.
 *
 * `useLlmObs`'s own `assertNoLlmObsSpans` first awaits an APM trace, so it can't express "nothing at
 * all was emitted" — which is exactly what the negative cases here need.
 *
 * @returns {Promise<object[]>}
 */
async function drainLlmObsSpans () {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  return agent.getLlmObsSpanEventsRequests(true).flat().map(request => request.spans[0])
}

describe('integrations', () => {
  describe('openai realtime', () => {
    const { getEvents } = useLlmObs({ plugin: 'openai' })

    // `realtime/*` first ships in openai 5.17.0; before that it lived only under `beta/`, which is a
    // fully duplicated implementation and is covered by its own transport entry below.
    withVersions('openai', 'openai', '>=5.17.0', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`

      const transports = [
        { label: 'OpenAIRealtimeWS', file: 'openai/realtime/ws', className: 'OpenAIRealtimeWS' },
        { label: 'OpenAIRealtimeWebSocket', file: 'openai/realtime/websocket', className: 'OpenAIRealtimeWebSocket' },
        // The beta path still ships alongside the current one, with its own emitter and transport
        // classes, so an app that never migrated its imports must still be instrumented.
        { label: 'beta OpenAIRealtimeWS', file: 'openai/beta/realtime/ws', className: 'OpenAIRealtimeWS' },
      ]

      for (const transport of transports) {
        describe(`with openai ${version} over ${transport.label}`, () => {
          let clock
          let restoreSocket
          let versionModule
          let RealtimeTransport
          let client
          let realtime
          let socket
          let mic

          beforeEach(() => {
            versionModule = require(moduleRequirePath)
            restoreSocket = installFakeSocket(versionModule.getPath('openai'))
            FakeRealtimeSocket.instances.length = 0

            // Only `Date`. Faking timers would deadlock `getEvents`, which polls on `setImmediate`,
            // and the tracer captured `Date.now` at module load, so this moves the instrumentation's
            // clock without disturbing span internals — every realtime span carries an explicit
            // start and finish anyway.
            clock = sinon.useFakeTimers({ now: CLOCK_START, toFake: ['Date'] })

            const { OpenAI } = versionModule.get()
            RealtimeTransport = versionModule.get(transport.file)[transport.className]

            client = new OpenAI({ apiKey: 'sk-test-realtime' })
            realtime = new RealtimeTransport({ model: 'gpt-realtime' }, client)
            socket = realtime.socket
            mic = new Mic(realtime, clock)
          })

          afterEach(() => {
            clock.restore()
            restoreSocket()
          })

          // Announce the session the way the server does, so the state machine learns the audio
          // format, sample rate and whether input transcription is on.
          function sessionCreated ({ transcription = true, format } = {}) {
            const audioFormat = format ?? { type: 'audio/pcm', rate: 24_000 }
            socket.deliver({
              type: 'session.created',
              session: {
                model: 'gpt-realtime-2025-08-28',
                instructions: 'Be concise.',
                output_modalities: ['audio'],
                audio: {
                  input: {
                    format: audioFormat,
                    ...(transcription ? { transcription: { model: 'whisper-1' } } : {}),
                  },
                  output: { format: audioFormat, voice: 'alloy' },
                },
              },
            })
          }

          // Drive one spoken turn: lead-in, VAD onset, speech, commit, then the model's response.
          function spokenTurn ({
            id = 'resp_1',
            item = 'item_1',
            leadInMs = 300,
            speechMs = 500,
            ttfaMs = 120,
            agentAudioMs = 600,
            generationTailMs = 80,
            transcript = 'Sure, here you go.',
            inputTranscript = 'What is the weather?',
            status = 'completed',
          } = {}) {
            mic.stream(leadInMs)
            mic.speechStarted()
            mic.stream(speechMs)
            mic.commit(item)

            socket.deliver({ type: 'response.created', response: { id } })
            clock.tick(ttfaMs)
            if (agentAudioMs > 0) {
              socket.deliver({
                type: 'response.output_audio.delta',
                response_id: id,
                item_id: `out_${id}`,
                delta: pcm16(agentAudioMs),
              })
            }
            socket.deliver({ type: 'response.output_audio_transcript.done', response_id: id, transcript })
            clock.tick(generationTailMs)
            socket.deliver({
              type: 'response.done',
              response: {
                id,
                status,
                model: 'gpt-realtime-2025-08-28',
                usage: { input_tokens: 11, output_tokens: 22 },
              },
            })
            socket.deliver({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: item,
              transcript: inputTranscript,
            })
          }

          it('models a spoken turn as a workflow root with user speech, llm and agent speech', async () => {
            sessionCreated()
            spokenTurn()

            const { apmSpans, llmobsSpans } = await getEvents(4)
            const windows = timeline(llmobsSpans)
            const byId = apmSpansById(apmSpans)

            const root = byName(llmobsSpans, TURN_ROOT)
            const userSpeech = byName(llmobsSpans, USER_SPEECH)
            const llm = byName(llmobsSpans, LLM)
            const agentSpeech = byName(llmobsSpans, AGENT_SPEECH)

            // -- the tree, which is the FE/BE consumer contract ----------------------------
            assert.strictEqual(llmobsSpans.length, 4)
            for (const child of [userSpeech, llm, agentSpeech]) {
              assert.strictEqual(child.parent_id, root.span_id, `${child.name} should hang off the turn root`)
            }
            assert.strictEqual(root.parent_id, 'undefined')

            // Every span of a connection shares one session id, so the UI groups the conversation.
            assert.strictEqual(new Set(llmobsSpans.map(span => span.session_id)).size, 1)

            // -- the boundaries, which are the sole carrier of timing ----------------------
            // Anchored on the VAD onset, not the first buffered frame, so the window covers the
            // 500ms of speech and not the 300ms of lead-in before it.
            assert.strictEqual(windows[USER_SPEECH].end - windows[USER_SPEECH].start, 500 * MS)
            // The llm span measures model work: it opens where user speech ends.
            assert.strictEqual(windows[LLM].start, windows[USER_SPEECH].end)
            assert.strictEqual(windows[LLM].end - windows[LLM].start, 200 * MS)
            // The agent-speech window is sized from the delivered audio, so it outlives generation.
            assert.strictEqual(windows[AGENT_SPEECH].end - windows[AGENT_SPEECH].start, 600 * MS)
            assert.ok(windows[AGENT_SPEECH].start >= windows[LLM].start)
            assert.ok(windows[AGENT_SPEECH].end > windows[LLM].end)

            // This is the value the backend turns into time-to-first-agent-audio.
            assert.strictEqual(windows[AGENT_SPEECH].start - windows[USER_SPEECH].end, 120 * MS)

            // The root spans the whole perceived turn and contains every child.
            assert.strictEqual(windows[TURN_ROOT].start, windows[USER_SPEECH].start)
            assert.strictEqual(windows[TURN_ROOT].end, windows[AGENT_SPEECH].end)

            // -- the payloads --------------------------------------------------------------
            // Raw PCM16 isn't renderable, so it is WAV-wrapped, and the bytes ride on the llm span
            // only. The input clip is 500ms rather than the 800ms buffered because the pre-onset
            // lead-in was trimmed to keep the stored audio in step with the reported window.
            const inputAudio = assertWavClip(
              llm.meta.input.messages[0].audio_parts[0], { durationMs: 500, sampleRate: 24_000 }
            )
            assertWavClip(llm.meta.output.messages[0].audio_parts[0], { durationMs: 600, sampleRate: 24_000 })

            assertLlmObsSpanEvent(llm, {
              span: byId.get(llm.span_id),
              parentId: byId.get(root.span_id).span_id,
              spanKind: 'llm',
              name: LLM,
              modelName: 'gpt-realtime-2025-08-28',
              modelProvider: 'openai',
              sessionId: llm.session_id,
              inputMessages: [{
                role: 'user',
                content: 'What is the weather?',
                audio_parts: [{ mime_type: 'audio/wav', content: inputAudio }],
              }],
              outputMessages: [{
                role: 'assistant',
                content: 'Sure, here you go.',
                audio_parts: [{ mime_type: 'audio/wav', content: MOCK_STRING }],
              }],
              metadata: {
                instructions: 'Be concise.',
                output_modalities: ['audio'],
                input_audio_format: 'audio/pcm',
                output_audio_format: 'audio/pcm',
                voice: 'alloy',
              },
              metrics: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
              tags: { ml_app: 'test', integration: 'openai' },
            })

            // The phase spans are timing regions: transcripts only, no audio.
            assertLlmObsSpanEvent(userSpeech, {
              span: byId.get(userSpeech.span_id),
              parentId: byId.get(root.span_id).span_id,
              spanKind: 'workflow',
              name: USER_SPEECH,
              sessionId: userSpeech.session_id,
              outputValue: 'What is the weather?',
              tags: { ml_app: 'test', integration: 'openai' },
            })

            assertLlmObsSpanEvent(agentSpeech, {
              span: byId.get(agentSpeech.span_id),
              parentId: byId.get(root.span_id).span_id,
              spanKind: 'workflow',
              name: AGENT_SPEECH,
              sessionId: agentSpeech.session_id,
              outputValue: 'Sure, here you go.',
              tags: { ml_app: 'test', integration: 'openai' },
            })

            assertLlmObsSpanEvent(root, {
              span: byId.get(root.span_id),
              spanKind: 'workflow',
              name: TURN_ROOT,
              sessionId: root.session_id,
              inputValue: 'What is the weather?',
              outputValue: 'Sure, here you go.',
              tags: { ml_app: 'test', integration: 'openai' },
            })
          })

          it('keeps consecutive turns on one session and off each other', async () => {
            sessionCreated()
            spokenTurn({ id: 'resp_1', item: 'item_1' })
            // The microphone keeps streaming through the agent's reply, so turn two's buffer is
            // already open well before the human speaks again.
            spokenTurn({ id: 'resp_2', item: 'item_2', leadInMs: 700 })

            const { llmobsSpans } = await getEvents(8)
            assert.strictEqual(llmobsSpans.length, 8)

            // One conversation, two traces.
            assert.strictEqual(new Set(llmobsSpans.map(span => span.session_id)).size, 1)
            const roots = llmobsSpans.filter(span => span.name === TURN_ROOT)
            assert.strictEqual(roots.length, 2)
            assert.notStrictEqual(roots[0].trace_id, roots[1].trace_id)

            // Without VAD anchoring, turn two's user-speech window would reach back to the moment
            // turn one was committed and swallow the whole agent reply.
            const speech = llmobsSpans
              .filter(span => span.name === USER_SPEECH || span.name === AGENT_SPEECH)
              .sort((a, b) => a.start_ns - b.start_ns)
            for (let i = 1; i < speech.length; i++) {
              const previousEnd = speech[i - 1].start_ns + speech[i - 1].duration
              assert.ok(
                speech[i].start_ns >= previousEnd,
                `${speech[i].name} starts before ${speech[i - 1].name} ends`
              )
            }
          })

          it('omits the user-speech span for a text-only turn', async () => {
            sessionCreated({ transcription: false })

            realtime.send({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ping.' }] },
            })
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(50)
            socket.deliver({
              type: 'response.output_audio.delta',
              response_id: 'resp_1',
              item_id: 'o1',
              delta: pcm16(200),
            })
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'resp_1',
              transcript: 'Pong.',
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)

            assert.deepStrictEqual(names(llmobsSpans).sort(), [TURN_ROOT, LLM, AGENT_SPEECH].sort())
            assert.strictEqual(byName(llmobsSpans, LLM).meta.input.messages[0].content, 'Ping.')
          })

          it('omits the agent-speech span for a tool-only turn and carries the call across turns', async () => {
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(40)
            socket.deliver({
              type: 'response.done',
              response: {
                id: 'resp_1',
                status: 'completed',
                output: [{
                  type: 'function_call',
                  name: 'get_weather',
                  call_id: 'call_1',
                  arguments: '{"city":"Paris"}',
                }],
              },
            })

            const { llmobsSpans } = await getEvents(3)

            assert.deepStrictEqual(names(llmobsSpans).sort(), [TURN_ROOT, USER_SPEECH, LLM].sort())
            assert.deepStrictEqual(byName(llmobsSpans, LLM).meta.output.messages, [{
              role: 'assistant',
              content: '',
              tool_calls: [{
                name: 'get_weather',
                arguments: { city: 'Paris' },
                tool_id: 'call_1',
                type: 'function',
              }],
            }])

            // The app feeds the result back, and it lands on the *next* turn's input, labelled with
            // the name carried by the originating call (the output event only has the call id).
            realtime.send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":14}' },
            })
            socket.deliver({ type: 'response.created', response: { id: 'resp_2' } })
            clock.tick(30)
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'resp_2',
              transcript: 'It is 14.',
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_2', status: 'completed' } })

            const second = await getEvents(2)
            assert.deepStrictEqual(byName(second.llmobsSpans, LLM).meta.input.messages, [{
              role: 'user',
              content: '',
              tool_results: [{
                name: 'get_weather',
                result: '{"tempC":14}',
                tool_id: 'call_1',
                type: 'function_call_output',
              }],
            }])
          })

          it('captures an MCP call together with its inline result', async () => {
            // Unlike a function call, an MCP call runs server-side, so its result arrives on the
            // same item rather than coming back from the app on the next turn.
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(30)
            socket.deliver({
              type: 'response.done',
              response: {
                id: 'resp_1',
                status: 'completed',
                output: [{
                  type: 'mcp_call',
                  id: 'mcp_1',
                  name: 'search_docs',
                  arguments: '{"q":"realtime"}',
                  output: 'found 3 results',
                }],
              },
            })

            const { llmobsSpans } = await getEvents(3)

            assert.deepStrictEqual(byName(llmobsSpans, LLM).meta.output.messages, [{
              role: 'assistant',
              content: '',
              tool_calls: [{
                name: 'search_docs',
                arguments: { q: 'realtime' },
                tool_id: 'mcp_1',
                type: 'mcp_call',
              }],
              tool_results: [{
                name: 'search_docs',
                result: 'found 3 results',
                tool_id: 'mcp_1',
                type: 'mcp_tool_result',
              }],
            }])
          })

          it('discards buffered audio the client clears, and ignores non-user items', async () => {
            sessionCreated({ transcription: false })

            // Audio the client abandons must not be attributed to the next response.
            mic.stream(200)
            realtime.send({ type: 'input_audio_buffer.clear' })

            // Assistant and system items are not the user's input either.
            realtime.send({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
            })
            // An app can also supply the user's turn inline instead of streaming it to the buffer.
            realtime.send({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'kept' },
                  { type: 'input_audio', audio: pcm16(150), transcript: ' and heard' },
                ],
              },
            })

            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(30)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)

            // The inline audio replaces the cleared buffer, so the speech window covers it alone.
            assert.deepStrictEqual(names(llmobsSpans).sort(), [TURN_ROOT, USER_SPEECH, LLM].sort())

            const inputMessage = byName(llmobsSpans, LLM).meta.input.messages[0]
            assert.strictEqual(inputMessage.content, ' and heard')
            assertWavClip(inputMessage.audio_parts[0], { durationMs: 150, sampleRate: 24_000 })
          })

          it('finalizes a waiting turn when its transcription fails', async () => {
            sessionCreated({ transcription: true })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(40)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            assert.deepStrictEqual(await drainLlmObsSpans(), [])

            // No transcript is coming, so the turn must not hang until the next one or close.
            socket.deliver({
              type: 'conversation.item.input_audio_transcription.failed',
              item_id: 'item_1',
            })

            const { llmobsSpans } = await getEvents(3)
            assert.strictEqual(llmobsSpans.length, 3)
          })

          it('submits a turn still open at process exit', async () => {
            // The last-resort backstop for a connection the app drops without closing. A
            // FinalizationRegistry cannot serve here: the socket's own message handler closes over
            // the emitter, so it stays reachable for as long as the connection is open.
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(30)
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'resp_1',
              transcript: 'Half a thought',
            })

            assert.deepStrictEqual(await drainLlmObsSpans(), [])

            flushLiveSessions()

            const { llmobsSpans } = await getEvents(3)
            assert.strictEqual(byName(llmobsSpans, TURN_ROOT).meta.output.value, 'Half a thought')
          })

          it('decodes G.711 telephony audio and wraps it as 8kHz WAV', async () => {
            // Phone-call integrations negotiate mu-law, which is 8kHz and 1 byte per sample.
            sessionCreated({ transcription: false, format: { type: 'audio/pcmu' } })

            realtime.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(800, 0xFF).toString('base64') })
            socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'item_1' })
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(25)
            socket.deliver({
              type: 'response.output_audio.delta',
              response_id: 'resp_1',
              item_id: 'o1',
              delta: Buffer.alloc(1600, 0xFF).toString('base64'),
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(4)
            const llm = byName(llmobsSpans, LLM)

            // 800 mu-law bytes is 100ms at 8kHz; decoded to PCM16 it doubles in size but not in
            // duration, and is re-wrapped at the G.711 rate rather than the session's 24kHz.
            assertWavClip(llm.meta.input.messages[0].audio_parts[0], { durationMs: 100, sampleRate: 8000 })
            assertWavClip(llm.meta.output.messages[0].audio_parts[0], { durationMs: 200, sampleRate: 8000 })

            const windows = timeline(llmobsSpans)
            assert.strictEqual(windows[AGENT_SPEECH].end - windows[AGENT_SPEECH].start, 200 * MS)
          })

          it('falls back to an [audio] marker when the audio cannot be made playable', async () => {
            // A format that is neither renderable on its own nor convertible: keep the turn and the
            // fact that audio was there, drop the bytes.
            sessionCreated({ transcription: false, format: { type: 'audio/basic' } })

            realtime.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(64, 1).toString('base64') })
            socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'item_1' })
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(20)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(2)
            const llm = byName(llmobsSpans, LLM)

            assert.deepStrictEqual(llm.meta.input.messages, [{ role: 'user', content: '[audio]' }])
          })

          it('keeps the transcript and drops the bytes when the audio is over budget', async () => {
            sessionCreated({ transcription: false })

            // One byte past the retention cap, so nothing is kept — but the turn is still reported,
            // with its transcript, and the window is still derived from the byte count.
            const overBudgetMs = 3 * 1024 * 1024 / 48 + 1
            realtime.send({ type: 'input_audio_buffer.append', audio: pcm16(Math.ceil(overBudgetMs)) })
            socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'item_1' })
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(20)
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'resp_1',
              transcript: 'Ok.',
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)
            const llm = byName(llmobsSpans, LLM)

            assert.strictEqual(llm.meta.input.messages[0].audio_parts, undefined)
            assert.strictEqual(llm.meta.input.messages[0].content, '[audio]')
            assert.strictEqual(llm.meta.output.messages[0].content, 'Ok.')
          })

          it('flags a failed response on both the llm span and the turn root', async () => {
            sessionCreated({ transcription: false })
            spokenTurn({ status: 'failed', transcript: '' })

            const { llmobsSpans } = await getEvents(4)

            assert.strictEqual(byName(llmobsSpans, LLM).status, 'error')
            assert.strictEqual(byName(llmobsSpans, TURN_ROOT).status, 'error')
            // The phase spans describe windows, not the model call, so they stay ok.
            assert.strictEqual(byName(llmobsSpans, USER_SPEECH).status, 'ok')
          })

          it('holds a turn open for a late input transcription', async () => {
            sessionCreated({ transcription: true })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(40)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            // Transcription is enabled but hasn't landed, so nothing is submitted yet.
            assert.deepStrictEqual(await drainLlmObsSpans(), [])

            socket.deliver({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'item_1',
              transcript: 'Late transcript.',
            })

            const { llmobsSpans } = await getEvents(3)
            assert.strictEqual(byName(llmobsSpans, USER_SPEECH).meta.output.value, 'Late transcript.')
          })

          it('does not wait for a transcript the session never enabled', async () => {
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(40)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            // No transcript is ever coming, so waiting would delay every turn until the next one.
            const { llmobsSpans } = await getEvents(3)
            assert.strictEqual(llmobsSpans.length, 3)
          })

          it('anchors on the first append when the client does its own turn detection', async () => {
            // A push-to-talk client sends no VAD events and appends only while the user talks, so
            // the first frame really is the onset and nothing should be trimmed.
            sessionCreated({ transcription: false })

            mic.stream(400)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(30)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)
            const windows = timeline(llmobsSpans)

            // The window opens when the first frame was observed, and that frame carried the 10ms
            // preceding it — so the window trails the clip by exactly one frame. Nothing is trimmed:
            // without VAD events the first append really is the onset.
            assert.strictEqual(windows[USER_SPEECH].end - windows[USER_SPEECH].start, 390 * MS)
            assertWavClip(
              byName(llmobsSpans, LLM).meta.input.messages[0].audio_parts[0],
              { durationMs: 400, sampleRate: 24_000 }
            )
          })

          // A turn where the model generates more audio than the listener actually hears.
          function bargeInTurn ({ id, item, ttfaMs = 60, generatedMs = 800, heardMs }) {
            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit(item)
            socket.deliver({ type: 'response.created', response: { id } })
            clock.tick(ttfaMs)
            socket.deliver({
              type: 'response.output_audio.delta',
              response_id: id,
              item_id: `out_${id}`,
              delta: pcm16(generatedMs),
            })
            socket.deliver({ type: 'response.done', response: { id, status: 'completed' } })

            // The report always arrives after response.done — that is what makes holding necessary.
            clock.tick(heardMs)
            realtime.send({ type: 'conversation.item.truncate', item_id: `out_${id}`, audio_end_ms: heardMs })
          }

          it('reports the first barge-in on a connection untruncated', async () => {
            // Holding every finished turn would cost submission latency for every client, so a turn
            // is only held once this connection's client has been seen to truncate. The documented
            // cost of that trade is that the first interruption is reported as generated.
            sessionCreated({ transcription: false })
            bargeInTurn({ id: 'resp_1', item: 'item_1', heardMs: 250 })

            const { llmobsSpans } = await getEvents(4)
            const windows = timeline(llmobsSpans)

            assert.strictEqual(windows[AGENT_SPEECH].end - windows[AGENT_SPEECH].start, 800 * MS)
          })

          it('caps the agent-speech window at what a later barge-in actually played', async () => {
            sessionCreated({ transcription: false })

            // The first interruption teaches the connection that this client cuts playback short.
            bargeInTurn({ id: 'resp_1', item: 'item_1', heardMs: 250 })
            await getEvents(4)

            // The second is held while its audio plays, so the truncation still lands.
            bargeInTurn({ id: 'resp_2', item: 'item_2', heardMs: 250 })

            const { llmobsSpans } = await getEvents(4)
            const windows = timeline(llmobsSpans)

            assert.strictEqual(windows[AGENT_SPEECH].end - windows[AGENT_SPEECH].start, 250 * MS)
            // Truncation moves the end, never the start, so time-to-first-agent-audio is unaffected.
            assert.strictEqual(windows[AGENT_SPEECH].start - windows[USER_SPEECH].end, 60 * MS)
            // The stored audio is capped to match the window: we keep only what was heard.
            assertWavClip(
              byName(llmobsSpans, LLM).meta.output.messages[0].audio_parts[0],
              { durationMs: 250, sampleRate: 24_000 }
            )
          })

          it('interprets a segment with the format it was captured under', async () => {
            // The audio arrives as 24kHz PCM16, then the session switches to 8kHz G.711 mid-turn. The
            // already-captured bytes must keep their original format: read as G.711 the same 600ms
            // clip would time as 3600ms and be decoded as telephony audio.
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(50)
            socket.deliver({
              type: 'response.output_audio.delta',
              response_id: 'resp_1',
              item_id: 'out_1',
              delta: pcm16(600),
            })
            socket.deliver({
              type: 'session.updated',
              session: { audio: { output: { format: { type: 'audio/pcmu' } } } },
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(4)
            const windows = timeline(llmobsSpans)

            assert.strictEqual(windows[AGENT_SPEECH].end - windows[AGENT_SPEECH].start, 600 * MS)
            assertWavClip(
              byName(llmobsSpans, LLM).meta.output.messages[0].audio_parts[0],
              { durationMs: 600, sampleRate: 24_000 }
            )
          })

          it('does not trim audio buffered before the session announced a format', async () => {
            // A client streaming from its own thread routinely beats `session.created`. Those bytes
            // cannot be placed on the input-buffer timeline, so the turn has no base offset — and
            // treating that as an offset of zero would read as "this turn starts at the session
            // origin" and trim the front of the segment away.
            mic.stream(300)
            sessionCreated({ transcription: false })
            mic.speechStarted()
            mic.stream(500)
            mic.commit('item_1')

            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(30)
            socket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)
            const windows = timeline(llmobsSpans)

            // The window is still anchored on the VAD onset...
            assert.strictEqual(windows[USER_SPEECH].end - windows[USER_SPEECH].start, 500 * MS)
            // ...but the clip keeps every byte, since there was no timeline to trim against.
            assertWavClip(
              byName(llmobsSpans, LLM).meta.input.messages[0].audio_parts[0],
              { durationMs: 800, sampleRate: 24_000 }
            )
          })

          it('bounds how long a finished turn is held waiting for playback', async () => {
            sessionCreated({ transcription: false })

            // Teach the connection that this client truncates, so later turns are held at all.
            bargeInTurn({ id: 'resp_1', item: 'item_1', heardMs: 250 })
            await getEvents(4)

            // 8s of generated audio would otherwise hold the turn for the full 8s. A connection that
            // goes idle right after a response is the gap this bound exists for.
            mic.stream(100)
            mic.commit('item_2')
            socket.deliver({ type: 'response.created', response: { id: 'resp_2' } })
            clock.tick(40)
            socket.deliver({
              type: 'response.output_audio.delta',
              response_id: 'resp_2',
              item_id: 'out_resp_2',
              delta: pcm16(8000),
            })
            socket.deliver({ type: 'response.done', response: { id: 'resp_2', status: 'completed' } })

            // Still inside the bound: held.
            clock.tick(4000)
            socket.deliver({ type: 'session.updated', session: {} })
            assert.deepStrictEqual(await drainLlmObsSpans(), [])

            // Past it: submitted, without waiting out the remaining ~4s of audio.
            clock.tick(1500)
            socket.deliver({ type: 'session.updated', session: {} })

            const { llmobsSpans } = await getEvents(3)
            assert.ok(names(llmobsSpans).includes(TURN_ROOT))
          })

          it('finalizes when the server closes the connection, with no explicit close()', async () => {
            sessionCreated({ transcription: false })

            mic.stream(100)
            mic.speechStarted()
            mic.stream(200)
            mic.commit('item_1')
            socket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(40)
            socket.deliver({
              type: 'response.output_audio_transcript.done',
              response_id: 'resp_1',
              transcript: 'Bye.',
            })

            // No response.done: the connection drops mid-generation. Whatever we have is submitted.
            socket.close()

            const { llmobsSpans } = await getEvents(3)
            assert.strictEqual(byName(llmobsSpans, TURN_ROOT).meta.output.value, 'Bye.')
          })

          it('finalizes exactly once across close() and the socket close that follows', async () => {
            sessionCreated({ transcription: false })
            spokenTurn()

            realtime.close()
            socket.close()

            const { llmobsSpans } = await getEvents(4)
            assert.strictEqual(llmobsSpans.length, 4)
            assert.deepStrictEqual(await drainLlmObsSpans(), [])
          })

          it('emits nothing for a connection that never completes a turn', async () => {
            sessionCreated()
            // A hot path that must stay silent: the microphone streams continuously between turns.
            mic.stream(500)

            assert.deepStrictEqual(await drainLlmObsSpans(), [])
          })

          it('leaves the SDK observably unchanged', async () => {
            // The instrumentation must not perturb the emitter's own dispatch: it snapshots and
            // filters `once` listeners, and `_onError` branches on whether an `error` listener
            // exists, so registering one would change unhandled-rejection behaviour.
            const seen = []
            realtime.on('event', event => seen.push(event.type))
            realtime.once('session.created', () => seen.push('once:session.created'))

            sessionCreated()
            socket.deliver({ type: 'session.updated', session: { voice: 'verse' } })

            assert.deepStrictEqual(seen, ['session.created', 'once:session.created', 'session.updated'])
            assert.ok(!realtime._hasListener('error'))

            // `send` is a passthrough: the event reaches the socket untouched.
            realtime.send({ type: 'input_audio_buffer.append', audio: pcm16(10) })
            assert.deepStrictEqual(socket.clientEvents().at(-1), {
              type: 'input_audio_buffer.append',
              audio: pcm16(10),
            })
          })

          it('instruments a connection built by the async create() factory', async function () {
            // `create()` constructs through the class's own internal binding, not the module export,
            // which is why the constructor is not what gets wrapped. Not every version ships it.
            if (typeof RealtimeTransport.create !== 'function') return this.skip()

            const created = await RealtimeTransport.create(client, { model: 'gpt-realtime' })
            const createdSocket = created.socket
            const createdMic = new Mic(created, clock)

            createdSocket.deliver({
              type: 'session.created',
              session: { model: 'gpt-realtime', audio: { input: { format: { type: 'audio/pcm', rate: 24_000 } } } },
            })
            createdMic.stream(100)
            createdMic.commit('item_1')
            createdSocket.deliver({ type: 'response.created', response: { id: 'resp_1' } })
            clock.tick(20)
            createdSocket.deliver({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })

            const { llmobsSpans } = await getEvents(3)
            assert.ok(names(llmobsSpans).includes(TURN_ROOT))
          })
        })
      }
    })
  })
})
