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

  it('stays silent about late-loaded packages when startupLogs is off', (done) => {
    const off = { cwd: __dirname, env: { DD_TRACE_STARTUP_LOGS: 'false' } }
    exec(`${process.execPath} ./check-require-cache/bad-order.js`, off, (error, stdout, stderr) => {
      assert.strictEqual(error, null)
      assert.doesNotMatch(stderr, /Package 'express' was loaded/)
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

    it('warns about next even when startupLogs is off (the v5 default)', (done) => {
      const off = { cwd: __dirname, env: { DD_TRACE_STARTUP_LOGS: 'false' } }
      exec(`${process.execPath} ./check-require-cache/next-loaded-first.js`, off, (error, stdout, stderr) => {
        assert.strictEqual(error, null)
        assert.match(stderr, /DATADOG TRACER DIAGNOSTIC - 'next' was loaded before dd-trace/)
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

    it('collects next in output: standalone mode where next-server is copied under .next/standalone', () => {
      // `output: 'standalone'` copies next-server.js into the bundle and the generated server.js
      // requires it through normal resolution, so the cache key still ends with
      // next/dist/server/next-server.js (the last node_modules/next segment is the package).
      const restore = cacheModule(
        path.join('/app', '.next', 'standalone', 'node_modules', 'next', 'dist', 'server', 'next-server.js')
      )
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
      } finally {
        restore()
      }
    })

    it('detects standalone next when the cache key uses Windows separators', () => {
      const restore = cacheModule('C:\\app\\.next\\standalone\\node_modules\\next\\dist\\server\\next-server.js')
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
      } finally {
        restore()
      }
    })

    it('collects next for an App Router app where next-server and the app-route runtime are both cached', () => {
      // The App Router request path runs inside next-server (NextNodeServer), which lazily pulls
      // in the precompiled app-route runtime bundle, so next-server.js is always cached too. The
      // existing next-server.js match therefore already covers App Router apps.
      const restoreServer = cacheModule(
        path.join('/app', 'node_modules', 'next', 'dist', 'server', 'next-server.js')
      )
      const restoreRuntime = cacheModule(
        path.join('/app', 'node_modules', 'next', 'dist', 'compiled', 'next-server', 'app-route.runtime.prod.js')
      )
      try {
        checkForRequiredModules()
        assert.ok(drainFrameworkWarnings().some(message => message.includes("'next' was loaded before dd-trace")))
      } finally {
        restoreRuntime()
        restoreServer()
      }
    })

    it('ignores the app-route runtime bundle when next-server is not cached', () => {
      const nextWarnings = messages => messages.filter(message => message.includes("'next'")).length

      checkForRequiredModules()
      const before = nextWarnings(drainFrameworkWarnings())

      // The runtime bundle can never be the only cached next module under a Node server, so its
      // presence alone is not a late-load signal. The scan stays on next-server.js rather than
      // paying a pattern match for a state that cannot occur.
      const restore = cacheModule(
        path.join('/app', 'node_modules', 'next', 'dist', 'compiled', 'next-server', 'app-route.runtime.prod.js')
      )
      try {
        checkForRequiredModules()
        assert.strictEqual(nextWarnings(drainFrameworkWarnings()), before)
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
