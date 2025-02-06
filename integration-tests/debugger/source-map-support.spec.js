'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('source map support', function () {
    describe('Different file extention (TypeScript)', function () {
      const t = setup({
        testApp: 'target-app/source-map-support/typescript.js',
        testAppSource: 'target-app/source-map-support/typescript.ts'
      })

      beforeEach(t.triggerBreakpoint)

      it('should support source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location } } } }] }) => {
          assert.deepEqual(location, {
            file: 'target-app/source-map-support/typescript.ts',
            lines: ['11']
          })
          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })

    describe('Column information required (Minified)', function () {
      const t = setup({
        testApp: 'target-app/source-map-support/minify.min.js',
        testAppSource: 'target-app/source-map-support/minify.js'
      })

      beforeEach(t.triggerBreakpoint)

      it('should support source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location } } } }] }) => {
          assert.deepEqual(location, {
            file: 'target-app/source-map-support/minify.js',
            lines: ['8']
          })
          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })

    // The source map for the bundled application contains a relative path in its `sources` array, which will fail this
    // test if not properly handled
    describe('Relative source paths', function () {
      const t = setup({
        testApp: 'target-app/source-map-support/bundle.js',
        testAppSource: 'target-app/source-map-support/hello/world.ts',
        dependencies: []
      })

      beforeEach(t.triggerBreakpoint)

      it('should support relative source paths in source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location } } } }] }) => {
          assert.deepEqual(location, {
            file: 'target-app/source-map-support/hello/world.ts',
            lines: ['2']
          })
          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })
})
