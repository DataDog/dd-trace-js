'use strict'

const assert = require('node:assert/strict')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('source map support', function () {
    describe('Different file extension (TypeScript)', function () {
      const t = setup({
        testApp: 'target-app/source-map-support/typescript.js',
        testAppSource: 'target-app/source-map-support/typescript.ts'
      })

      beforeEach(() => { t.triggerBreakpoint() })

      it('should support source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location }, stack } } }] }) => {
          assert.deepStrictEqual(location, {
            file: 'target-app/source-map-support/typescript.ts',
            lines: ['11']
          })

          // Verify stack trace also uses original source locations
          assert.ok(Array.isArray(stack), 'stack should be an array')
          assert.ok(stack.length > 0, 'stack should have at least one frame')
          const topFrame = stack[0]
          assert.match(topFrame.fileName, /typescript\.ts$/, 'Top frame should reference original TypeScript file')
          assert.strictEqual(topFrame.lineNumber, 11, 'Top frame should have original line number')

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

      beforeEach(() => { t.triggerBreakpoint() })

      it('should support source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location }, stack } } }] }) => {
          assert.deepStrictEqual(location, {
            file: 'target-app/source-map-support/minify.js',
            lines: ['9']
          })

          // Verify stack trace also uses original source locations
          assert.ok(Array.isArray(stack), 'stack should be an array')
          assert.ok(stack.length > 0, 'stack should have at least one frame')
          const topFrame = stack[0]
          assert.match(topFrame.fileName, /minify\.js$/, 'Top frame should reference original minified source file')
          assert.strictEqual(topFrame.lineNumber, 9, 'Top frame should have original line number')

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

      beforeEach(() => { t.triggerBreakpoint() })

      it('should support relative source paths in source maps', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { probe: { location }, stack } } }] }) => {
          assert.deepStrictEqual(location, {
            file: 'target-app/source-map-support/hello/world.ts',
            lines: ['2']
          })

          // Verify stack trace also uses original source locations with relative paths
          assert.ok(Array.isArray(stack), 'stack should be an array')
          assert.ok(stack.length > 0, 'stack should have at least one frame')
          const topFrame = stack[0]
          assert.match(topFrame.fileName, /hello\/world\.ts$/, 'Top frame should reference original TypeScript file')
          assert.strictEqual(topFrame.lineNumber, 2, 'Top frame should have original line number')

          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })
})
