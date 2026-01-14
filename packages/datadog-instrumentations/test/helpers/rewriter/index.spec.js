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
            filePath: 'index.js'
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync'
          },
          channelName: 'test_invoke'
        },
        {
          module: {
            name: 'test-trace-async',
            versionRange: '>=0.1',
            filePath: 'index.js'
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Async'
          },
          channelName: 'test_invoke'
        },
        {
          module: {
            name: 'test-trace-callback',
            versionRange: '>=0.1',
            filePath: 'index.js'
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Callback'
          },
          channelName: 'test_invoke'
        }
      ]
    })
  })

  afterEach(() => {
    ch.unsubscribe(subs)
  })

  it('should auto instrument sync functions', done => {
    const test = compile('test-trace-sync')

    subs = {
      start () {
        done()
      }
    }

    ch = tracingChannel('orchestrion:test-trace-sync:test_invoke')
    ch.subscribe(subs)

    test.test()
  })

  it('should auto instrument async functions', done => {
    const test = compile('test-trace-async')

    subs = {
      start () {
        done()
      }
    }

    ch = tracingChannel('orchestrion:test-trace-async:test_invoke')
    ch.subscribe(subs)

    test.test()
  })

  it('should auto instrument callback functions', done => {
    const test = compile('test-trace-callback')

    subs = {
      start () {
        done()
      }
    }

    ch = tracingChannel('orchestrion:test-trace-callback:test_invoke')
    ch.subscribe(subs)

    test.test(() => {})
  })
})
