'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')

const { ddBasePath } = require('../src/util')

const USER_FILE = '/users/me/app/index.js'
const DD_TRACE_FILE = path.join(ddBasePath, 'packages', 'dd-trace', 'src', 'tracer.js')
const DD_INST_FILE = path.join(ddBasePath, 'packages', 'datadog-instrumentations', 'src', 'fs.js')
const NODE_INTERNAL_FILE = 'node:internal/fs/promises'

/**
 * Build a synthetic CallSite-shaped POJO. Only the methods the filter calls
 * (`getFileName`, `isNative`) plus the V8-default `toString` format matter; the
 * other accessors round out the realism for the chain handler.
 *
 * @param {{
 *   fileName?: string,
 *   native?: boolean,
 *   functionName?: string,
 *   lineNumber?: number,
 *   columnNumber?: number
 * }} options
 */
function makeFrame ({ fileName, native = false, functionName = '<anonymous>', lineNumber = 1, columnNumber = 1 }) {
  const location = fileName ?? (native ? 'native' : '<anonymous>')
  const display = `${functionName} (${location}:${lineNumber}:${columnNumber})`
  return {
    getFileName: () => fileName,
    isNative: () => native,
    getFunctionName: () => functionName,
    getLineNumber: () => lineNumber,
    getColumnNumber: () => columnNumber,
    toString: () => display,
  }
}

function userFrame (functionName) {
  return makeFrame({ fileName: USER_FILE, functionName })
}

function ddFrame (functionName, file = DD_INST_FILE) {
  return makeFrame({ fileName: file, functionName })
}

function nodeInternalFrame (functionName) {
  return makeFrame({ fileName: NODE_INTERNAL_FILE, functionName })
}

function nativeFrame (functionName) {
  return makeFrame({ functionName, native: true })
}

function loadStackFilter () {
  return proxyquire.noPreserveCache()('../src/stack-filter', {})
}

// Prime the module loader so @babel/core's setupPrepareStackTrace runs once
// before the suite. nyc routes the first instrumentation call through
// @babel/core which installs its own `stackTraceRewriter` on Error.prepareStackTrace;
// after that the helper turns itself into a no-op, so subsequent reloads no longer
// race the per-test Error.prepareStackTrace dance.
loadStackFilter()

describe('Error.prepareStackTrace dd-trace frame filter', () => {
  let originalPrepareStackTrace

  beforeEach(() => {
    originalPrepareStackTrace = Error.prepareStackTrace
  })

  afterEach(() => {
    Error.prepareStackTrace = originalPrepareStackTrace
  })

  describe('install()', () => {
    it('does not install when no env vars are set', () => {
      const stackFilter = loadStackFilter()
      const before = Error.prepareStackTrace
      stackFilter.install({})
      assert.strictEqual(Error.prepareStackTrace, before)
    })

    it('does not install when only DD_TRACE_FILTER_OWN_FRAMES is set (experimental flag absent)', () => {
      const stackFilter = loadStackFilter()
      const before = Error.prepareStackTrace
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES: true })
      assert.strictEqual(Error.prepareStackTrace, before)
    })

    it('does not install when DD_TRACE_FILTER_OWN_FRAMES is explicitly false', () => {
      const stackFilter = loadStackFilter()
      const before = Error.prepareStackTrace
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES: false, DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })
      assert.strictEqual(Error.prepareStackTrace, before)
    })

    it('does not install when DD_TRACE_INTERNAL_TEST_HARNESS is truthy', () => {
      const stackFilter = loadStackFilter()
      const before = Error.prepareStackTrace
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true, DD_TRACE_INTERNAL_TEST_HARNESS: 1 })
      assert.strictEqual(Error.prepareStackTrace, before)
    })

    it('installs once when the experimental flag is set', () => {
      const stackFilter = loadStackFilter()
      const before = Error.prepareStackTrace
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })
      const installed = Error.prepareStackTrace
      assert.notStrictEqual(installed, before)
      assert.strictEqual(typeof installed, 'function')

      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })
      assert.strictEqual(Error.prepareStackTrace, installed)
    })

    it('captures the prior Error.prepareStackTrace and chains through it', () => {
      const stackFilter = loadStackFilter()
      const previousCalls = []
      Error.prepareStackTrace = (error, callsites) => {
        previousCalls.push({ error, callsites })
        return 'CHAINED'
      }
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const error = new Error('boom')
      const callsites = [userFrame('top'), ddFrame('wrap'), nodeInternalFrame('open')]
      const result = Error.prepareStackTrace(error, callsites)

      assert.strictEqual(result, 'CHAINED')
      assert.strictEqual(previousCalls.length, 1)
      assert.strictEqual(previousCalls[0].error, error)
      assert.deepStrictEqual(previousCalls[0].callsites, [callsites[0], callsites[2]])
    })
  })

  describe('contiguous trailing run removal', () => {
    it('removes the dd-trace fs-wrap frame between user code and node-internal (canonical fs.readFile case)', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const error = new Error('ENOENT')
      const callsites = [
        userFrame('Object.<anonymous>'),
        ddFrame('wrappedReadFile'),
        nodeInternalFrame('readFile'),
      ]
      const stack = Error.prepareStackTrace(error, callsites)
      const lines = stack.split('\n')

      assert.strictEqual(lines[0], 'Error: ENOENT')
      assert.match(lines[1], /Object\.<anonymous>.*\/index\.js/)
      assert.match(lines[2], /readFile.*node:internal\/fs\/promises/)
      assert.strictEqual(lines.length, 3)
      assert.ok(!/packages[\\/](dd-trace|datadog-instrumentations)/.test(stack))
    })

    it('drops a single trailing dd-trace frame at the end of the stack', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [userFrame('main'), ddFrame('lastInstrumentation')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.strictEqual(stack.split('\n').length, 2)
      assert.ok(!/datadog-instrumentations/.test(stack))
    })

    it('drops a dd-trace run between a user frame and a native frame', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [userFrame('main'), ddFrame('wrap'), nativeFrame('builtin')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.ok(!/datadog-instrumentations/.test(stack))
      assert.match(stack, /builtin/)
    })

    it('drops a dd-trace run between an internal frame and a user frame', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [nodeInternalFrame('open'), ddFrame('wrap'), userFrame('main')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.ok(!/datadog-instrumentations/.test(stack))
      assert.match(stack, /node:internal\/fs\/promises/)
      assert.match(stack, /main/)
    })

    it('drops a multi-frame dd-trace run as one unit', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [
        userFrame('main'),
        ddFrame('outerWrap', DD_TRACE_FILE),
        ddFrame('innerWrap', DD_INST_FILE),
        nodeInternalFrame('open'),
      ]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.ok(!stack.includes('outerWrap'))
      assert.ok(!stack.includes('innerWrap'))
      assert.match(stack, /main/)
      assert.match(stack, /node:internal/)
    })

    it('drops a second run after an earlier drop without reallocating filtered', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [
        userFrame('user1'),
        ddFrame('firstDrop'),
        nodeInternalFrame('open'),
        userFrame('user2'),
        ddFrame('secondDrop'),
        nativeFrame('builtin'),
      ]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.ok(!stack.includes('firstDrop'))
      assert.ok(!stack.includes('secondDrop'))
      assert.match(stack, /user1/)
      assert.match(stack, /user2/)
      assert.match(stack, /builtin/)
    })
  })

  describe('sandwiched runs are kept', () => {
    it('keeps a dd-trace run that sits between two user frames', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [
        userFrame('user1'),
        ddFrame('wrap'),
        userFrame('user2'),
        ddFrame('inner'),
        nodeInternalFrame('open'),
      ]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      const lines = stack.split('\n')

      assert.match(lines[1], /user1/)
      assert.match(lines[2], /wrap.*datadog-instrumentations/)
      assert.match(lines[3], /user2/)
      assert.match(lines[4], /node:internal/)
      assert.strictEqual(lines.length, 5)
    })

    it('mixes kept and dropped runs in the same stack', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [
        userFrame('userA'),
        ddFrame('kept1', DD_TRACE_FILE),
        userFrame('userB'),
        ddFrame('dropped1'),
        nodeInternalFrame('open'),
      ]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)

      assert.match(stack, /kept1.*dd-trace/)
      assert.ok(!stack.includes('dropped1'))
    })

    it('preserves a kept run after an earlier drop has forced allocation', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [
        userFrame('user1'),
        ddFrame('dropped'),
        nodeInternalFrame('open'),
        userFrame('user2'),
        ddFrame('kept', DD_TRACE_FILE),
        userFrame('user3'),
      ]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)

      assert.ok(!stack.includes('dropped'))
      assert.match(stack, /kept.*dd-trace/)
      assert.match(stack, /user3/)
    })
  })

  describe('default formatter (no prior installer)', () => {
    it('formats the filtered stack with V8\'s default shape', () => {
      const stackFilter = loadStackFilter()
      Error.prepareStackTrace = undefined
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [userFrame('main'), ddFrame('wrap'), nodeInternalFrame('open')]
      const stack = Error.prepareStackTrace(new Error('boom'), callsites)
      assert.strictEqual(typeof stack, 'string')
      assert.ok(stack.startsWith('Error: boom\n    at '))
      assert.ok(!stack.includes('datadog-instrumentations'))
    })

    it('returns the bare error string when the filtered list is empty', () => {
      const stackFilter = loadStackFilter()
      Error.prepareStackTrace = undefined
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      assert.strictEqual(Error.prepareStackTrace(new Error('bare'), []), 'Error: bare')
    })
  })

  describe('pass-through cases', () => {
    it('passes through when frame[0] is a dd-trace frame', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [ddFrame('top'), userFrame('user'), nodeInternalFrame('internal')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.match(stack, /datadog-instrumentations/)
      assert.match(stack, /\/index\.js/)
      assert.match(stack, /node:internal/)
    })

    it('passes through an empty callsite list', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const stack = Error.prepareStackTrace(new Error('x'), [])
      assert.strictEqual(stack, 'Error: x')
    })

    it('passes through when no dd-trace frames are present', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [userFrame('main'), nativeFrame('builtin'), nodeInternalFrame('open')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.match(stack, /main/)
      assert.match(stack, /builtin/)
      assert.match(stack, /node:internal/)
    })

    it('passes through a stack made entirely of native frames', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [nativeFrame('builtinA'), nativeFrame('builtinB')]
      const stack = Error.prepareStackTrace(new Error('x'), callsites)
      assert.match(stack, /builtinA/)
      assert.match(stack, /builtinB/)
    })

    it('chains through the prior installer when filtering happens', () => {
      const stackFilter = loadStackFilter()
      let receivedCallsites
      Error.prepareStackTrace = (_error, callsites) => {
        receivedCallsites = callsites
        return 'PRIOR'
      }
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const callsites = [userFrame('main'), ddFrame('wrap'), nodeInternalFrame('open')]
      const result = Error.prepareStackTrace(new Error('x'), callsites)
      assert.strictEqual(result, 'PRIOR')
      assert.strictEqual(receivedCallsites.length, 2)
    })
  })

  describe('captureUnfilteredStack / formatUnfiltered', () => {
    it('captures an unfiltered stack and stashes it for later retrieval', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      function caller () {
        const carrier = {}
        stackFilter.captureUnfilteredStack(carrier, caller)
        return carrier
      }
      const carrier = caller()

      assert.ok(typeof carrier.stack === 'string')
      assert.strictEqual(stackFilter.formatUnfiltered(carrier), carrier.stack)
    })

    it('bypasses filtering for the carrier even when prior installer is present', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const carrier = {}
      stackFilter.captureUnfilteredStack(carrier, function origin () {})
      assert.match(carrier.stack, /Error/)
    })

    it('falls back to error.stack for foreign errors when installed', () => {
      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      const foreign = new Error('foreign')
      const result = stackFilter.formatUnfiltered(foreign)
      assert.strictEqual(typeof result, 'string')
    })

    it('returns error.stack directly when the filter was never installed', () => {
      const stackFilter = loadStackFilter()
      const foreign = new Error('foreign')
      assert.strictEqual(stackFilter.formatUnfiltered(foreign), foreign.stack)
    })
  })

  describe('isDdFrame', () => {
    it('identifies frames inside the dd-trace base path', () => {
      const stackFilter = loadStackFilter()
      assert.strictEqual(stackFilter.isDdFrame(ddFrame('x')), true)
      assert.strictEqual(stackFilter.isDdFrame(userFrame('x')), false)
      assert.strictEqual(stackFilter.isDdFrame(nodeInternalFrame('x')), false)
      assert.strictEqual(stackFilter.isDdFrame(nativeFrame('x')), false)
    })
  })

  describe('integration with log.error', () => {
    it('stashes the carrier on the shared stack-filter so formatUnfiltered finds it', () => {
      const dc = require('dc-polyfill')
      const errorChannel = dc.channel('datadog:log:error')
      const captured = []
      const subscriber = (msg) => captured.push(msg)
      errorChannel.subscribe(subscriber)

      const stackFilter = loadStackFilter()
      stackFilter.install({ DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL: true })

      let stashedFromCapture
      const stackFilterStub = {
        ...stackFilter,
        captureUnfilteredStack (target, constructorOpt) {
          stashedFromCapture = stackFilter.captureUnfilteredStack(target, constructorOpt)
          return stashedFromCapture
        },
      }

      try {
        const log = proxyquire.noPreserveCache()('../src/log', {
          '../stack-filter': stackFilterStub,
        })
        log.error('boom')

        const carrier = captured.find(value => value instanceof Error)
        assert.ok(carrier, 'expected an Error carrier on the channel')
        assert.strictEqual(stackFilter.formatUnfiltered(carrier), stashedFromCapture)
      } finally {
        errorChannel.unsubscribe(subscriber)
      }
    })
  })
})
