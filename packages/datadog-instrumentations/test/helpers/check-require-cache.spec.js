'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const path = require('node:path')
const Module = require('node:module')

const { describe, it } = require('mocha')

const { checkForRequiredModules, flushFrameworkWarnings } = require('../../src/helpers/check-require-cache')

describe('check-require-cache', () => {
  const opts = {
    cwd: __dirname,
    env: {
      DD_TRACE_STARTUP_LOGS: 'true',
    },
  }

  it('should be no warnings when tracer is loaded first', (done) => {
    exec(`${process.execPath} ./check-require-cache/good-order.js`, opts, (error, stdout, stderr) => {
      assert.strictEqual(error, null)
      assert.doesNotMatch(stderr, /Package 'express' was loaded/)
      done()
    })
  })

  it('should find warnings when tracer loaded late', (done) => {
    exec(`${process.execPath} ./check-require-cache/bad-order.js`, opts, (error, stdout, stderr) => {
      assert.strictEqual(error, null)
      assert.match(stderr, /Package 'express' was loaded/)
      done()
    })
  })

  describe('frameworks that must load before the tracer', () => {
    // No DD_TRACE_DEBUG here on purpose: the framework warning has to surface by
    // default, since the users hitting this (issues #5430 / #5432) never turned
    // debug logging on.
    const defaultOpts = { cwd: __dirname, env: {} }

    it('should warn by default when next is loaded before the tracer', (done) => {
      exec(`${process.execPath} ./check-require-cache/next-loaded-first.js`, defaultOpts, (error, stdout, stderr) => {
        assert.strictEqual(error, null)
        assert.match(stderr, /'next' was loaded before dd-trace/)
        assert.match(stderr, /--require dd-trace\/init/)
        assert.match(stderr, /--import dd-trace\/initialize\.mjs/)
        assert.match(stderr, /serverExternalPackages/)
        done()
      })
    })

    it('should not warn when next is loaded after the tracer', (done) => {
      exec(`${process.execPath} ./check-require-cache/next-loaded-after.js`, defaultOpts, (error, stdout, stderr) => {
        assert.strictEqual(error, null)
        assert.doesNotMatch(stderr, /'next' was loaded before dd-trace/)
        done()
      })
    })

    it('should not warn when only a non-server file of next is loaded first', (done) => {
      exec(`${process.execPath} ./check-require-cache/next-util-loaded-first.js`, defaultOpts, (error, _, stderr) => {
        assert.strictEqual(error, null)
        assert.doesNotMatch(stderr, /'next' was loaded before dd-trace/)
        done()
      })
    })
  })

  describe('checkForRequiredModules framework detection', () => {
    function cacheModule (modulePath) {
      const fakeModule = new Module(modulePath)
      fakeModule.exports = {}
      fakeModule.loaded = true
      require.cache[modulePath] = fakeModule
      return () => delete require.cache[modulePath]
    }

    function drainFrameworkWarnings () {
      const messages = []
      flushFrameworkWarnings(message => messages.push(message))
      return messages
    }

    // Clear any residue collected from the real require.cache before asserting.
    beforeEach(() => drainFrameworkWarnings())

    it('collects a curated framework whose server module is already cached', () => {
      const restore = cacheModule(
        path.join('/app', 'node_modules', 'next', 'dist', 'server', 'next-server.js')
      )
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
      } finally {
        restore()
      }
    })

    it('drains collected warnings so a second flush does not repeat them', () => {
      const restore = cacheModule(
        path.join('/app', 'node_modules', 'next', 'dist', 'server', 'next-server.js')
      )
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
        assert.deepStrictEqual(drainFrameworkWarnings(), [])
      } finally {
        restore()
      }
    })

    it('detects a curated framework when the cache key uses Windows separators', () => {
      // Literal backslash key reproduces a Windows require.cache entry on any OS.
      const restore = cacheModule('C:\\app\\node_modules\\next\\dist\\server\\next-server.js')
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
      } finally {
        restore()
      }
    })

    it('ignores non-server files of a curated framework', () => {
      const nextWarnings = messages => messages.filter(message => message.includes("'next'")).length

      checkForRequiredModules()
      const before = nextWarnings(drainFrameworkWarnings())

      const restore = cacheModule(path.join('/app', 'node_modules', 'next', 'package.json'))
      try {
        checkForRequiredModules()
        // Caching only a non-server file must not add a warning, regardless of
        // whatever else is already in the real require.cache.
        assert.strictEqual(nextWarnings(drainFrameworkWarnings()), before)
      } finally {
        restore()
      }
    })

    it('does not collect packages outside the curated set', () => {
      const restore = cacheModule(path.join('/app', 'node_modules', 'express', 'lib', 'express.js'))
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().every(message => !message.includes("'express'")))
      } finally {
        restore()
      }
    })
  })
})
