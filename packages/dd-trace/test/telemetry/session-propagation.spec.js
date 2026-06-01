'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

require('../setup/core')

/**
 * @typedef {{
 *   callArgs?: unknown[],
 *   shell: boolean,
 *   command?: string,
 *   file?: string
 * }} ChildProcessContext
 */
/**
 * @typedef {{
 *   telemetry?: { enabled?: boolean },
 *   DD_ROOT_JS_SESSION_ID?: string,
 *   tags?: { 'runtime-id'?: string }
 * }} SessionPropagationConfigOverrides
 */
/**
 * @typedef {{
 *   subscribe(subscribers: { start?: (context: ChildProcessContext) => void }): void,
 *   start: { publish(context: ChildProcessContext): void }
 * }} FakeTracingChannel
 */

describe('session-propagation', () => {
  /** @type {FakeTracingChannel} */
  let childProcessChannel
  let sessionPropagation

  /**
   * @param {SessionPropagationConfigOverrides} [overrides]
   */
  function createConfig (overrides = {}) {
    /**
     * @type {{
     *   telemetry: { enabled: boolean },
     *   DD_ROOT_JS_SESSION_ID: string | undefined,
     *   tags: { 'runtime-id': string }
     * }}
     */
    const config = {
      telemetry: { enabled: true, ...overrides.telemetry },
      DD_ROOT_JS_SESSION_ID: undefined,
      tags: { 'runtime-id': 'current-id', ...overrides.tags },
    }

    if (overrides.DD_ROOT_JS_SESSION_ID) {
      config.DD_ROOT_JS_SESSION_ID = overrides.DD_ROOT_JS_SESSION_ID
    }

    return config
  }

  /**
   * @param {Record<string, string>} additions
   * @returns {NodeJS.ProcessEnv}
   */
  function createExpectedEnv (additions) {
    return {
      ...process.env,
      ...additions,
    }
  }

  /**
   * @param {ChildProcessContext} context
   * @returns {ChildProcessContext}
   */
  function publishStart (context) {
    childProcessChannel.start.publish(context)
    return context
  }

  /**
   * @returns {FakeTracingChannel}
   */
  function createTracingChannel () {
    /** @type {((context: ChildProcessContext) => void)[]} */
    const startSubscribers = []

    return {
      subscribe (subscribers) {
        if (typeof subscribers.start === 'function') {
          startSubscribers.push(subscribers.start)
        }
      },
      start: {
        publish (context) {
          for (const subscriber of startSubscribers) {
            subscriber(context)
          }
        },
      },
    }
  }

  beforeEach(() => {
    childProcessChannel = createTracingChannel()
    sessionPropagation = proxyquire('../../src/telemetry/session-propagation', {
      'dc-polyfill': {
        tracingChannel () {
          return childProcessChannel
        },
      },
    })
  })

  describe('child process execution contexts', () => {
    it('seeds child process options with the current runtime id when there is no inherited root', () => {
      sessionPropagation.start(createConfig())

      const context = {
        callArgs: ['node', ['test.js'], { cwd: '/tmp', env: { FOO: 'bar' } }],
        shell: false,
      }

      publishStart(context)

      assert.deepStrictEqual(context.callArgs, [
        'node',
        ['test.js'],
        {
          cwd: '/tmp',
          env: {
            FOO: 'bar',
            DD_ROOT_JS_SESSION_ID: 'current-id',
          },
        },
      ])
    })

    it('uses process.env as the base when the execution context provides options without env', () => {
      sessionPropagation.start(createConfig())

      const context = {
        callArgs: ['npm', ['run', 'test'], { cwd: '/tmp' }],
        shell: false,
      }

      publishStart(context)

      assert.deepStrictEqual(context.callArgs, [
        'npm',
        ['run', 'test'],
        {
          cwd: '/tmp',
          env: createExpectedEnv({ DD_ROOT_JS_SESSION_ID: 'current-id' }),
        },
      ])
    })

    it('adds shell options when the execution context does not provide any', () => {
      sessionPropagation.start(createConfig())

      const context = {
        callArgs: ['ls -la'],
        shell: true,
      }

      publishStart(context)

      assert.deepStrictEqual(context.callArgs, [
        'ls -la',
        { env: createExpectedEnv({ DD_ROOT_JS_SESSION_ID: 'current-id' }) },
      ])
    })

    it('preserves callbacks when it needs to insert child process options', () => {
      sessionPropagation.start(createConfig())

      const cb = () => {}
      const context = {
        callArgs: ['cmd', cb],
        shell: false,
      }

      publishStart(context)

      assert.deepStrictEqual(context.callArgs, [
        'cmd',
        [],
        { env: createExpectedEnv({ DD_ROOT_JS_SESSION_ID: 'current-id' }) },
        cb,
      ])
    })

    it('does not change child process execution when telemetry is disabled', () => {
      sessionPropagation.start(createConfig({ telemetry: { enabled: false } }))

      const context = {
        callArgs: ['node', ['test.js'], { cwd: '/tmp', env: { FOO: 'bar' } }],
        shell: false,
      }

      publishStart(context)

      assert.deepStrictEqual(context.callArgs, ['node', ['test.js'], { cwd: '/tmp', env: { FOO: 'bar' } }])
    })

    it('preserves an inherited root session id instead of replacing it with the current runtime id', () => {
      sessionPropagation.start(createConfig({ DD_ROOT_JS_SESSION_ID: 'root-id' }))

      const context = publishStart({ callArgs: ['node', ['test.js'], {}], shell: false })

      assert.deepStrictEqual(context.callArgs, [
        'node',
        ['test.js'],
        { env: createExpectedEnv({ DD_ROOT_JS_SESSION_ID: 'root-id' }) },
      ])
    })

    it('uses process.env as the base when it adds options for non-shell commands', () => {
      sessionPropagation.start(createConfig())

      const context = publishStart({ callArgs: ['node'], shell: false })

      assert.deepStrictEqual(context.callArgs, [
        'node',
        [],
        { env: createExpectedEnv({ DD_ROOT_JS_SESSION_ID: 'current-id' }) },
      ])
    })

    it('ignores execution contexts without call arguments', () => {
      sessionPropagation.start(createConfig())

      const context = {
        command: 'node test.js',
        file: 'node',
        shell: false,
      }

      publishStart(context)

      assert.strictEqual(context.callArgs, undefined)
    })
  })
})
