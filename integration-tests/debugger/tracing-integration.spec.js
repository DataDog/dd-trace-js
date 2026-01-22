'use strict'

const assert = require('assert')
const { setup, testBasicInput, testBasicInputWithoutDD } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=true', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: true },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=false', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: false },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACING_ENABLED=false', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'false' },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it(
        'should capture and send expected payload when a log line probe is triggered',
        testBasicInputWithoutDD.bind(null, t)
      )
    })
  })

  describe('DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED=true', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: 'true' },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it('should include process_tags in snapshot when enabled', function (done) {
        t.agent.on('debugger-input', ({ payload }) => {
          const snapshot = payload[0].debugger.snapshot

          // Check for expected process tags keys
          assert.ok(snapshot.process_tags['entrypoint.name'])
          assert.ok(snapshot.process_tags['entrypoint.type'])
          assert.strictEqual(snapshot.process_tags['entrypoint.type'], 'script')

          done()
        })

        t.triggerBreakpoint()
        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })

  describe('DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED=false', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: 'false' },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it('should not include process_tags in snapshot when disabled', function (done) {
        t.agent.on('debugger-input', ({ payload }) => {
          const snapshot = payload[0].debugger.snapshot

          // Assert that process_tags are not present
          assert.strictEqual(snapshot.process_tags, undefined)

          done()
        })

        t.triggerBreakpoint()
        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })
})
