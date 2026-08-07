'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { NODE_MAJOR } = require('../../version')
const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

// Default settings is tested in unit tests, so we only need to test the env vars here
describe('Dynamic Instrumentation snapshot PII redaction', function () {
  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS=foo,bar', function () {
    const t = setup({
      env: { DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: 'foo,bar' },
      dependencies: ['fastify'],
    })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))

      const [{ payload: [{ debugger: { snapshot: { captures } } }] }] = await promise
      const { locals } = captures.lines[t.breakpoint.line]

      assertObjectContains(locals, {
        foo: { type: 'string', notCapturedReason: 'redactedIdent' },
        bar: { type: 'string', notCapturedReason: 'redactedIdent' },
        baz: { type: 'string', value: 'c' },
      })

      // existing redaction should not be impacted
      assertObjectContains(locals, { secret: { type: 'string', notCapturedReason: 'redactedIdent' } })
    })
  })

  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS=secret', function () {
    const t = setup({
      env: { DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: 'secret' },
      dependencies: ['fastify'],
    })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))

      const [{ payload: [{ debugger: { snapshot: { captures } } }] }] = await promise
      const { locals } = captures.lines[t.breakpoint.line]

      assertObjectContains(locals, {
        secret: { type: 'string', value: 'shh!' },
        password: { type: 'string', notCapturedReason: 'redactedIdent' },
      })
    })
  })

  describe('log probe message', function () {
    const t = setup({ dependencies: ['fastify'] })

    it('should redact sensitive identifiers when a template interpolates an object or map', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: 'obj={obj};map={map}',
        segments: [
          { str: 'obj=' },
          { dsl: 'obj', json: { ref: 'obj' } },
          { str: ';map=' },
          { dsl: 'map', json: { ref: 'map' } },
        ],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(
        message,
        "obj={ username: 'alice', password: '[redacted]', Symbol(password): '[redacted]' };" +
          "map=Map(3) { 'username' => 'alice', 'password' => '[redacted]', Symbol(password) => '[redacted]' }"
      )
    })

    it('should redact a template that references a sensitive identifier directly', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: 'local={password};member={obj.password}',
        segments: [
          { str: 'local=' },
          { dsl: 'password', json: { ref: 'password' } },
          { str: ';member=' },
          { dsl: 'obj.password', json: { getmember: [{ ref: 'obj' }, 'password'] } },
        ],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, 'local=[redacted];member=[redacted]')
    })

    it('should redact a Map created in another realm', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{vmMap}',
        segments: [{ dsl: 'vmMap', json: { ref: 'vmMap' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, "Map(1) { 'password' => '[redacted]' }")
    })

    it('should not invoke Proxy traps or leak a proxied value', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{proxy}',
        segments: [{ dsl: 'proxy', json: { ref: 'proxy' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, '[Proxy]')
      assert.doesNotMatch(message, /shh!/)
    })

    it('should redact own properties attached to a Map', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{mapWithProp}',
        segments: [{ dsl: 'mapWithProp', json: { ref: 'mapWithProp' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, "Map(1) { 'username' => 'alice', password: '[redacted]' }")
      assert.doesNotMatch(message, /shh!/)
    })

    it('should redact own properties attached to a function', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{fnWithSecret}',
        segments: [{ dsl: 'fnWithSecret', json: { ref: 'fnWithSecret' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, "[Function: handler] { password: '[redacted]', username: 'alice' }")
      assert.doesNotMatch(message, /shh!/)
    })

    it('should not invoke Proxy traps or leak a proxied function', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{fnProxy}',
        segments: [{ dsl: 'fnProxy', json: { ref: 'fnProxy' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, '[Proxy]')
      assert.doesNotMatch(message, /shh!/)
    })

    it('should redact a Map subclass without invoking its overridden keys()', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{mapWithOverriddenKeys}',
        segments: [{ dsl: 'mapWithOverriddenKeys', json: { ref: 'mapWithOverriddenKeys' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, "Map(1) { 'password' => '[redacted]' }")
      assert.doesNotMatch(message, /shh!/)
      assert.doesNotMatch(message, /must not be called/)
    })

    it('should not leak a redacted key beyond the rendered window of a large Map', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '{bigMap}',
        segments: [{ dsl: 'bigMap', json: { ref: 'bigMap' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      // On Node.js <= 18 util.inspect renders every Map entry, so the redacted key at position 5
      // is displayed and must be redacted; on Node.js > 18 only the first 3 entries render, so it
      // falls outside the window and is never displayed.
      assert.strictEqual(
        message,
        NODE_MAJOR > 18
          ? "Map(5) { 'k0' => 0, 'k1' => 1, 'k2' => 2, ... 2 more items }"
          : "Map(5) { 'k0' => 0, 'k1' => 1, 'k2' => 2, 'k3' => 3, 'password' => '[redacted]' }"
      )
      assert.doesNotMatch(message, /shh!/)
    })

    it('should still redact when intrinsics are shadowed in the paused scope', async function () {
      const breakpoint = t.breakpoints[1]
      breakpoint.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
        template: '{shadowObj}',
        segments: [{ dsl: 'shadowObj', json: { ref: 'shadowObj' } }],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(message, "{ username: 'alice', password: '[redacted]' }")
      assert.doesNotMatch(message, /shh!/)
    })
  })
})
