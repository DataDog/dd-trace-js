'use strict'

const assert = require('node:assert/strict')

// PCM16 mono at 24 kHz — the Realtime default — is 48 bytes per millisecond, so every duration in
// these tests is a whole number of milliseconds and every window assertion is exact.
const PCM16_BYTES_PER_MS = 48

/**
 * A stand-in for the WebSocket the OpenAI SDK opens, implementing both consumer surfaces so one
 * class serves both realtime transports: the `ws` package's Node EventEmitter API used by
 * `OpenAIRealtimeWS`, and the DOM API used by `OpenAIRealtimeWebSocket`.
 *
 * Only the transport is faked. The real SDK constructor, URL building, message parsing, event
 * dispatch and `send`/`close` all run, and so do the real dd-trace hooks on them.
 */
class FakeRealtimeSocket {
  /**
   * Every socket the SDK has constructed this test, newest last.
   *
   * @type {FakeRealtimeSocket[]}
   */
  static instances = []

  /**
   * @param {string | URL} url
   * @param {unknown} [options]
   */
  constructor (url, options) {
    this.url = url
    this.options = options
    this.readyState = 1
    /**
     * Raw JSON strings the SDK wrote, in order.
     *
     * @type {string[]}
     */
    this.sent = []
    /** @type {Map<string, Function[]>} */
    this.emitterListeners = new Map()
    /** @type {Map<string, Function[]>} */
    this.domListeners = new Map()

    FakeRealtimeSocket.instances.push(this)
  }

  // -- `ws` (Node EventEmitter) surface --

  on (event, listener) {
    const listeners = this.emitterListeners.get(event) ?? []
    listeners.push(listener)
    this.emitterListeners.set(event, listeners)
    return this
  }

  once (event, listener) {
    const wrapped = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  off (event, listener) {
    const listeners = this.emitterListeners.get(event)
    if (listeners === undefined) return this
    const index = listeners.indexOf(listener)
    if (index !== -1) listeners.splice(index, 1)
    return this
  }

  // -- DOM surface --

  addEventListener (event, listener, options) {
    const wrapped = options?.once
      ? (...args) => {
          this.removeEventListener(event, wrapped)
          listener(...args)
        }
      : listener

    const listeners = this.domListeners.get(event) ?? []
    listeners.push(wrapped)
    this.domListeners.set(event, listeners)
  }

  removeEventListener (event, listener) {
    const listeners = this.domListeners.get(event)
    if (listeners === undefined) return
    const index = listeners.indexOf(listener)
    if (index !== -1) listeners.splice(index, 1)
  }

  // -- what the SDK calls --

  send (data) {
    this.sent.push(data)
  }

  close () {
    this.readyState = 3
    this.#dispatch('close', undefined, {})
  }

  // -- what the test drives --

  /**
   * Hand a server event to the SDK, synchronously, exactly as the real socket would.
   *
   * @param {object} event
   * @returns {void}
   */
  deliver (event) {
    const json = JSON.stringify(event)
    // `ws` hands over a Buffer (the SDK calls `.toString()`); the DOM surface hands over a
    // MessageEvent whose `data` is a string.
    this.#dispatch('message', Buffer.from(json), { data: json })
  }

  /**
   * @returns {object[]} The client events the SDK has written, parsed.
   */
  clientEvents () {
    return this.sent.map(data => JSON.parse(data))
  }

  #dispatch (event, emitterArg, domArg) {
    for (const listener of [...(this.emitterListeners.get(event) ?? [])]) listener(emitterArg)
    for (const listener of [...(this.domListeners.get(event) ?? [])]) listener(domArg)
  }
}

/**
 * Point both realtime transports at the fake socket for the duration of a test.
 *
 * `OpenAIRealtimeWS` reads `WS.WebSocket` through the namespace object openai's `__importStar`
 * builds, and that helper installs a *live getter* (`get: () => m[k]`) for a writable, configurable
 * source property — which `ws`'s `module.exports.WebSocket = WebSocket` is. So assigning here is
 * visible to the SDK whether or not `realtime/ws.js` has already loaded.
 *
 * @param {string} openaiPath - Resolved path to the version-under-test's openai package.
 * @returns {() => void} Restores both seams.
 */
function installFakeSocket (openaiPath) {
  const wsModule = require(require.resolve('ws', { paths: [openaiPath] }))

  // If a future SDK or tslib change breaks either seam, fail loudly here rather than silently
  // letting the suite dial api.openai.com.
  const descriptor = Object.getOwnPropertyDescriptor(wsModule, 'WebSocket')
  assert.ok(descriptor?.writable && descriptor?.configurable,
    'ws.WebSocket is no longer a writable data property; the realtime fake-socket seam has moved')

  const realWs = wsModule.WebSocket

  // `OpenAIRealtimeWebSocket` reads the global `WebSocket`, which Node only provides from 21. We
  // *install* it here rather than depend on the runtime having it, so this harness works on every
  // supported Node version — hence the rule is not applicable to these four lines.
  /* eslint-disable n/no-unsupported-features/node-builtins */
  const realGlobal = globalThis.WebSocket
  globalThis.WebSocket = FakeRealtimeSocket
  wsModule.WebSocket = FakeRealtimeSocket

  return () => {
    wsModule.WebSocket = realWs
    if (realGlobal === undefined) delete globalThis.WebSocket
    else globalThis.WebSocket = realGlobal
  }
  /* eslint-enable n/no-unsupported-features/node-builtins */
}

/**
 * Base64 PCM16 of a given duration, with a recognizable fill so a trimmed or capped clip can be
 * checked to have kept the right bytes.
 *
 * @param {number} durationMs
 * @param {number} [fill]
 * @returns {string}
 */
function pcm16 (durationMs, fill = 0) {
  return Buffer.alloc(durationMs * PCM16_BYTES_PER_MS, fill).toString('base64')
}

/**
 * A client that streams the microphone continuously, the way a server-VAD app does: the input buffer
 * is open from the moment the previous turn was committed, so the first frame of a turn marks when
 * we started listening, not when the human started speaking.
 */
class Mic {
  /**
   * @param {object} realtime - The `OpenAIRealtimeWS` / `OpenAIRealtimeWebSocket` under test.
   * @param {import('sinon').SinonFakeTimers} clock
   */
  constructor (realtime, clock) {
    this.realtime = realtime
    this.clock = clock
    this.socket = realtime.socket
    /** Offset (ms) into all audio appended this session, mirroring the server's own buffer clock. */
    this.bufferMs = 0
  }

  /**
   * Append `durationMs` of microphone audio in 10 ms frames, advancing the clock in step.
   *
   * @param {number} durationMs
   * @param {number} [fill]
   * @returns {void}
   */
  stream (durationMs, fill = 0) {
    // Tick before sending: a real microphone hands over the frame covering [t-10ms, t) at t, so the
    // wall clock at append time already accounts for that frame. Sending first would leave the
    // buffer clock one frame ahead of the wall clock and skew every projected onset by 10 ms.
    for (let elapsed = 0; elapsed < durationMs; elapsed += 10) {
      this.clock.tick(10)
      this.realtime.send({ type: 'input_audio_buffer.append', audio: pcm16(10, fill) })
      this.bufferMs += 10
    }
  }

  /** @returns {void} */
  speechStarted () {
    this.socket.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: this.bufferMs })
  }

  /**
   * @param {string} itemId
   * @returns {void}
   */
  commit (itemId) {
    this.socket.deliver({ type: 'input_audio_buffer.committed', item_id: itemId })
  }
}

module.exports = { FakeRealtimeSocket, Mic, PCM16_BYTES_PER_MS, installFakeSocket, pcm16 }
