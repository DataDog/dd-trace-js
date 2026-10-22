'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { flushLiveSessions } = require('../../../../../datadog-instrumentations/src/openai-realtime')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')
const { FakeRealtimeSocket, installFakeSocket, pcm16 } = require('./realtime/fake-socket')

describe('openai realtime reconnect', () => {
  const { getEvents } = useLlmObs({ plugin: 'openai' })

  withVersions('openai', 'openai', '>=7.39.0', version => {
    for (const transport of ['ws', 'websocket']) {
      describe(`over ${transport}`, () => {
        let clock
        let restoreSocket
        let realtime
        let socket

        beforeEach(() => {
          const versionModule = require(`../../../../../../versions/openai@${version}`)
          restoreSocket = installFakeSocket(versionModule.getPath('openai'))
          FakeRealtimeSocket.instances.length = 0
          // Keep setImmediate real: the test agent uses it to drain trace payloads.
          clock = sinon.useFakeTimers({
            now: 1_000_000,
            shouldClearNativeTimers: true,
            toFake: ['Date', 'setTimeout', 'clearTimeout'],
          })

          const { OpenAI } = versionModule.get()
          const exports = versionModule.get(`openai/realtime/${transport}`)
          const Realtime = exports.OpenAIRealtimeWS ?? exports.OpenAIRealtimeWebSocket
          realtime = new Realtime({
            model: 'gpt-realtime',
            reconnect: true,
            reconnectInitialDelay: 0,
            reconnectMaxDelay: 0,
          }, new OpenAI({ apiKey: 'sk-test-realtime' }))
          socket = realtime.socket
        })

        afterEach(() => {
          try {
            realtime.close()
          } finally {
            clock.restore()
            restoreSocket()
          }
        })

        /**
         * @param {boolean} [transcription]
         */
        function sessionCreated (transcription = false) {
          socket.deliver({
            type: 'session.created',
            session: {
              model: 'gpt-realtime',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24_000 },
                  ...(transcription ? { transcription: { model: 'whisper-1' } } : {}),
                },
              },
            },
          })
        }

        /**
         * @param {string} id
         */
        function startResponse (id) {
          socket.deliver({ type: 'response.created', response: { id } })
          clock.tick(10)
          socket.deliver({ type: 'response.output_text.done', response_id: id, text: id })
        }

        /**
         * @param {string} id
         */
        function finishResponse (id) {
          socket.deliver({ type: 'response.done', response: { id, status: 'completed' } })
        }

        async function reconnect () {
          sessionCreated()
          startResponse('before reconnect')
          finishResponse('before reconnect')
          const first = await getEvents(2)

          const previous = socket
          previous.close(1012, 'service restart')
          await clock.tickAsync(0)
          socket = realtime.socket
          assert.notStrictEqual(socket, previous)
          return first.llmobsSpans[0].session_id
        }

        for (const pending of ['unfinished response', 'deferred transcription']) {
          for (const end of ['server close', 'client close', 'process exit']) {
            it(`flushes ${pending} after reconnect on ${end}`, async () => {
              const previousSessionId = await reconnect()
              const deferred = pending === 'deferred transcription'
              sessionCreated(deferred)
              if (deferred) {
                realtime.send({ type: 'input_audio_buffer.append', audio: pcm16(100) })
                socket.deliver({ type: 'input_audio_buffer.committed', item_id: 'input_1' })
              }
              startResponse('after reconnect')
              if (deferred) finishResponse('after reconnect')

              if (end === 'server close') socket.close(1006, 'network drop')
              else if (end === 'client close') realtime.close()
              else flushLiveSessions()

              const { apmSpans, llmobsSpans } = await getEvents(deferred ? 3 : 2)
              const response = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
              assert.ok(response)
              assert.notStrictEqual(response.session_id, previousSessionId)
              assert.deepStrictEqual(response.meta.output.messages, [{ content: 'after reconnect', role: 'assistant' }])
              const failed = !deferred && end === 'server close'
              assert.strictEqual(response.status, failed ? 'error' : 'ok')
              const apm = apmSpans.find(span => span.span_id.toString(10) === response.span_id)
              assert.ok(apm)
              assert.strictEqual(apm.error, failed ? 1 : 0)

              realtime.close()
              flushLiveSessions()
              for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
              assert.deepStrictEqual(agent.getLlmObsSpanEventsRequests(true), [])
            })
          }
        }

        it('keeps completed turns observable across successive reconnects', async () => {
          const firstSessionId = await reconnect()
          const secondSessionId = await reconnect()
          assert.notStrictEqual(secondSessionId, firstSessionId)

          // Exercise the client-event path before any server event on this replacement.
          realtime.send({
            type: 'conversation.item.create',
            item: { role: 'user', content: [{ type: 'input_text', text: 'new session' }] },
          })
          startResponse('completed')
          finishResponse('completed')
          const { apmSpans, llmobsSpans } = await getEvents(2)
          assert.strictEqual(apmSpans.length, 2)
          assert.notStrictEqual(llmobsSpans[0].session_id, secondSessionId)
          assert.strictEqual(llmobsSpans[0].status, 'ok')
          const response = llmobsSpans.find(span => span.name === 'OpenAI.createRealtimeResponse')
          assert.deepStrictEqual(response.meta.input.messages, [{ content: 'new session', role: 'user' }])
        })
      })
    }
  })
})
