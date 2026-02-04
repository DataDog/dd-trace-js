'use strict'

const { readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const Module = require('node:module')
const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const { tracingChannel } = require('dc-polyfill')

// TODO: Test actual functionality and not just the start channel.
describe('check-require-cache', () => {
  let rewriter
  let content
  let ch
  let subs

  function compile (name, format = 'commonjs') {
    const folder = resolve(__dirname, 'node_modules', name)
    const filename = join(folder, 'index.js')
    const mod = new Module(filename, module.parent)

    content = readFileSync(filename, 'utf8')
    content = rewriter.rewrite(content, filename, format)

    mod._compile(content, filename, format)

    return mod.exports
  }

  beforeEach(() => {
    rewriter = proxyquire('../../../src/helpers/rewriter', {
      './instrumentations': [
        {
          module: {
            name: 'test-trace-sync',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-sync-super',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            methodName: 'test',
            kind: 'Sync',
            className: 'B',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-async',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Async',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-async-super',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            methodName: 'test',
            kind: 'Async',
            className: 'B',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-callback',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Callback',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-callback-super',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            methodName: 'test',
            kind: 'Callback',
            className: 'B',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-class-instance-method',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            className: 'Foo',
            methodName: 'test',
            kind: 'Sync',
          },
          channelName: 'test_invoke',
        },
        {
          module: {
            name: 'test-trace-var-class-instance-method',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            className: 'Foo',
            methodName: 'test',
            kind: 'Sync',
          },
          channelName: 'test_invoke',
        },
      ],
    })
  })

  afterEach(() => {
    ch.unsubscribe(subs)
  })

  it('should auto instrument sync functions', done => {
    const { test } = compile('test-trace-sync')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-sync:test_invoke')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument sync functions with super', done => {
    const { test } = compile('test-trace-sync-super')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-sync-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument async functions', done => {
    const { test } = compile('test-trace-async')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-async:test_invoke')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument async functions using super', done => {
    const { test } = compile('test-trace-async-super')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-async-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument callback functions', done => {
    const { test } = compile('test-trace-callback')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-callback:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument callback functions using super', done => {
    const { test } = compile('test-trace-callback-super')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-callback-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument class instance methods', done => {
    const test = compile('test-trace-class-instance-method')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-class-instance-method:test_invoke')
    ch.subscribe(subs)

    test.test()
  })

  it('should auto instrument var class instance methods', done => {
    const test = compile('test-trace-var-class-instance-method')

    subs = {
      start () {
        done()
      },
    }

    ch = tracingChannel('orchestrion:test-trace-var-class-instance-method:test_invoke')
    ch.subscribe(subs)

    test.test()
  })
})
