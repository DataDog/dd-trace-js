'use strict'

const assert = require('assert')
const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

describe('Dynamic Instrumentation - Endpoint Fallback', function () {
  describe('v1 endpoint when agent does not advertise v2 support', function () {
    const t = setup({
      dependencies: ['fastify'],
      testApp: 'target-app/basic.js',
      agentOptions: {
        advertiseDebuggerV2IntakeSupport: false,
      },
    })

    it('should use v1 endpoint when agent does not advertise v2 support', async function () {
      let v2Called = false

      const v1InputPromise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.once('debugger-input-v1', ({ payload }) => {
          assertObjectContains(payload[0], {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { snapshot: {} },
          })
          resolve()
        })
      })

      t.agent.on('debugger-input-v2', () => {
        v2Called = true
      })

      t.agent.addRemoteConfig(t.rcConfig)
      const response = await t.triggerBreakpoint()
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'bar' })

      await v1InputPromise
      assert.strictEqual(v2Called, false, 'v2 endpoint should not be called')
    })

    it('should continue using v1 endpoint for multiple requests', async function () {
      const expectedSnapshots = 2
      let snapshotsReceived = 0

      let v2Called = false

      const v1InputsPromise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.on('debugger-input-v1', ({ payload }) => {
          // The payload is an array of snapshots, count them all
          snapshotsReceived += payload.length
          payload.forEach((item) => {
            assertObjectContains(item, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { snapshot: {} },
            })
          })
          if (snapshotsReceived >= expectedSnapshots) {
            resolve()
          }
        })
      })

      t.agent.on('debugger-input-v2', () => {
        v2Called = true
      })

      t.agent.addRemoteConfig(t.rcConfig)
      const response1 = await t.triggerBreakpoint()
      assert.strictEqual(response1.status, 200)
      assert.deepStrictEqual(response1.data, { hello: 'bar' })

      const response2 = await t.axios.get(t.breakpoint.url)
      assert.strictEqual(response2.status, 200)
      assert.deepStrictEqual(response2.data, { hello: 'bar' })

      await v1InputsPromise
      assert.strictEqual(v2Called, false, 'v2 endpoint should not be called')
    })
  })

  describe('v2 endpoint works when agent supports it', function () {
    const t = setup({ dependencies: ['fastify'], testApp: 'target-app/basic.js' })

    it('should successfully use v2 endpoint when agent supports it', async function () {
      let v1Called = false

      const v2InputPromise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.once('debugger-input-v2', ({ payload }) => {
          assertObjectContains(payload[0], {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { snapshot: {} },
          })
          resolve()
        })
      })

      t.agent.on('debugger-input-v1', () => {
        v1Called = true
      })

      t.agent.addRemoteConfig(t.rcConfig)
      const response = await t.triggerBreakpoint()
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'bar' })

      await v2InputPromise
      assert.strictEqual(v1Called, false, 'v1 endpoint should not be called')
    })
  })

  describe('runtime fallback from v2 to v1 when v2 returns 404', function () {
    const t = setup({
      dependencies: ['fastify'],
      testApp: 'target-app/basic.js',
      agentOptions: {
        // Agent advertises v2 support in /info, but returns 404 when actually called
        // This simulates an edge case where agent changes between /info and actual request
        advertiseDebuggerV2IntakeSupport: true,
        debuggerV2IntakeStatusCode: 404,
      },
    })

    it('should fallback to v1 endpoint when v2 returns 404 at runtime', async function () {
      const v2404Promise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.once('debugger-input-v2-404', () => resolve())
      })

      const v1InputPromise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.once('debugger-input-v1', ({ payload }) => {
          assertObjectContains(payload[0], {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { snapshot: {} },
          })
          resolve()
        })
      })

      t.agent.addRemoteConfig(t.rcConfig)
      const response = await t.triggerBreakpoint()
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'bar' })

      await Promise.all([v2404Promise, v1InputPromise])
    })

    it('should continue using v1 endpoint after runtime fallback', async function () {
      const expectedSnapshots = 2
      let snapshotsReceived = 0

      const v2404Promise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.once('debugger-input-v2-404', () => resolve())
      })

      const v1InputsPromise = new Promise(/** @type {() => void} */ (resolve) => {
        t.agent.on('debugger-input-v1', ({ payload }) => {
          // The payload is an array of snapshots, count them all
          snapshotsReceived += payload.length
          payload.forEach((item) => {
            assertObjectContains(item, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { snapshot: {} },
            })
          })
          if (snapshotsReceived >= expectedSnapshots) {
            resolve()
          }
        })
      })

      t.agent.addRemoteConfig(t.rcConfig)
      const response1 = await t.triggerBreakpoint()
      assert.strictEqual(response1.status, 200)
      assert.deepStrictEqual(response1.data, { hello: 'bar' })

      const response2 = await t.axios.get(t.breakpoint.url)
      assert.strictEqual(response2.status, 200)
      assert.deepStrictEqual(response2.data, { hello: 'bar' })

      await Promise.all([v2404Promise, v1InputsPromise])
    })
  })
})
