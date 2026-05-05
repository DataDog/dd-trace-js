'use strict'

const assert = require('assert')
const { setup, testBasicInput } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('DD_TRACE_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=true', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACE_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: true },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACE_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=false', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACE_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: false },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=true', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: true },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=false', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'true', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: false },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_TRACING_ENABLED=false (standalone APM mode)', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_TRACING_ENABLED: 'false' },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))
    })
  })

  describe('DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED=true', function () {
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: 'true' },
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should include process_tags at root level when enabled', function (done) {
        t.agent.on('debugger-input', ({ payload }) => {
          const { process_tags: processTags } = payload[0]

          assert.strictEqual(typeof processTags, 'string')
          assert.ok(processTags.includes('entrypoint.name:'))
          assert.ok(processTags.includes('entrypoint.type:script'))

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
      dependencies: ['fastify'],
    })

    describe('input messages', function () {
      it('should not include process_tags when disabled', function (done) {
        t.agent.on('debugger-input', ({ payload }) => {
          assert.strictEqual(payload[0].process_tags, undefined)

          done()
        })

        t.triggerBreakpoint()
        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })
})
