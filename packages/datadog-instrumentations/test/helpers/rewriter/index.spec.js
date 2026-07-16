'use strict'

const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join, dirname } = require('node:path')
const Module = require('node:module')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { tracingChannel } = require('dc-polyfill')

// TODO: Test actual functionality and not just the start channel.
describe('check-require-cache', () => {
  let rewriter
  let content
  let ch
  let subs

  function compile (name, format = 'commonjs') {
    const folder = resolve(__dirname, 'node_modules', ...name.split('/'))
    const filename = name.includes('/') ? folder : join(folder, 'index.js')
    const mod = new Module(filename, module.parent)

    content = readFileSync(filename, 'utf8')
    content = rewriter.rewrite(content, filename, format)

    mod.filename = filename
    mod.paths = Module._nodeModulePaths(dirname(filename))
    mod._compile(content, filename, format)

    return mod.exports
  }

  // TODO: Move all test files to same folder and replace `compile` with this.
  function compileFile (name, format = 'commonjs') {
    const filename = resolve(__dirname, 'node_modules', 'test', `${name}.js`)
    const mod = new Module(filename, module.parent)

    content = readFileSync(filename, 'utf8')
    content = rewriter.rewrite(content, filename, format)

    mod.filename = filename
    mod.paths = Module._nodeModulePaths(dirname(filename))
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
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-iterator-async.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Async',
            returnKind: 'Iterator',
          },
          channelName: 'trace_iterator_async',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-iterator-async-super.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Async',
            returnKind: 'Iterator',
          },
          channelName: 'trace_iterator_async_super',
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
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-generator.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync',
            returnKind: 'Iterator',
          },
          channelName: 'trace_generator',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-generator-super.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync',
            returnKind: 'Iterator',
          },
          channelName: 'trace_generator_super',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-generator-super-bound.js',
          },
          functionQuery: {
            methodName: 'test',
            kind: 'Sync',
            returnKind: 'Iterator',
            className: 'B',
          },
          channelName: 'trace_generator_super_bound',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-generator-async.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync',
            returnKind: 'AsyncIterator',
          },
          channelName: 'trace_generator_async',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-generator-async-super.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Sync',
            returnKind: 'AsyncIterator',
          },
          channelName: 'trace_generator_async_super',
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
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-function-index.js',
          },
          functionQuery: {
            functionName: 'dupe',
            kind: 'Sync',
            index: 1,
          },
          channelName: 'trace_function_index',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-class-private-method.js',
          },
          functionQuery: {
            className: 'Foo',
            privateMethodName: 'internal',
            kind: 'Sync',
          },
          channelName: 'trace_class_private_method',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-promise-async-end.js',
          },
          functionQuery: {
            functionName: 'test',
            kind: 'Async',
          },
          channelName: 'trace_promise_async_end',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-promise-async-end.js',
          },
          astQuery: 'ReturnStatement > CallExpression[callee.object.name="promise"][callee.property.name="then"]',
          channelName: 'trace_promise_async_end',
          transform: 'waitForAsyncEnd',
        },
        {
          module: {
            name: 'test-esm',
            versionRange: '>=0.1',
            filePath: 'pregel-class.js',
          },
          functionQuery: {
            methodName: 'stream',
            className: 'Pregel',
            kind: 'Sync',
            returnKind: 'AsyncIterator',
          },
          channelName: 'pregel_stream',
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
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-sync:test_invoke')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument sync functions with super', done => {
    const { test } = compile('test-trace-sync-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-sync-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument async functions', done => {
    const { test } = compile('test-trace-async')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-async:test_invoke')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument async functions using super', done => {
    const { test } = compile('test-trace-async-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-async-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument iterator returning async functions', done => {
    const { test } = compileFile('trace-iterator-async')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_iterator_async')
    ch.subscribe(subs)

    test()
  })

  it('should preserve return value of iterator returning async functions', () => {
    const { test } = compileFile('trace-iterator-async')

    return test().then(result => {
      assert.equal(result.next().value, 1)
    })
  })

  it('should auto instrument iterator returning async functions using super', done => {
    const { test } = compileFile('trace-iterator-async-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_iterator_async_super')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument callback functions', done => {
    const { test } = compile('test-trace-callback')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-callback:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument callback functions using super', done => {
    const { test } = compile('test-trace-callback-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-callback-super:test_invoke')
    ch.subscribe(subs)

    test(() => {})
  })

  it('should auto instrument generator functions', done => {
    const { test } = compileFile('trace-generator')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_generator')
    ch.subscribe(subs)

    const gen = test()

    assert.equal(gen.next().value, 'foo')
  })

  it('should auto instrument generator functions using super', done => {
    const { test } = compileFile('trace-generator-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_generator_super')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument generator functions using super in bound method call', done => {
    const { test } = compileFile('trace-generator-super-bound')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_generator_super_bound')
    ch.subscribe(subs)

    test().next()
  })

  it('should auto instrument async generator functions', done => {
    const { test } = compileFile('trace-generator-async')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_generator_async')
    ch.subscribe(subs)

    test()
  })

  it('should preserve return value of async generator functions', () => {
    const { test } = compileFile('trace-generator-async')

    const it = test()

    return it.next().then(result => {
      assert.equal(result.value, 'foo')
    })
  })

  it('should auto instrument async generator functions using super', done => {
    const { test } = compileFile('trace-generator-async-super')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test:trace_generator_async_super')
    ch.subscribe(subs)

    test()
  })

  it('should auto instrument class instance methods', done => {
    const test = compile('test-trace-class-instance-method')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-class-instance-method:test_invoke')
    ch.subscribe(subs)

    test.test()
  })

  it('should auto instrument var class instance methods', done => {
    const test = compile('test-trace-var-class-instance-method')

    subs = {
      start: () => setImmediate(done),
    }

    ch = tracingChannel('orchestrion:test-trace-var-class-instance-method:test_invoke')
    ch.subscribe(subs)

    test.test()
  })

  it('should auto instrument using a function index', () => {
    const test = compileFile('trace-function-index')

    subs = {
      start: sinon.spy(),
    }

    ch = tracingChannel('orchestrion:test:trace_function_index')
    ch.subscribe(subs)

    test.test()

    assert.ok(subs.start.called)
    assert.ok(subs.start.calledOnce)
    assert.equal(subs.start.firstCall.args[0].result, 'b')
  })

  it('should auto instrument using a class private method', () => {
    const test = compileFile('trace-class-private-method')

    subs = {
      start: sinon.spy(),
    }

    ch = tracingChannel('orchestrion:test:trace_class_private_method')
    ch.subscribe(subs)

    test.test()

    assert.ok(subs.start.called)
  })

  it('should wait for an asyncEnd promise when configured', async () => {
    const { test } = compileFile('trace-promise-async-end')
    const steps = []

    subs = {
      asyncEnd (ctx) {
        steps.push('asyncEnd')
        ctx.asyncEndPromise = new Promise(resolve => {
          setImmediate(() => {
            steps.push('asyncEndPromise')
            resolve()
          })
        })
      },
    }

    ch = tracingChannel('orchestrion:test:trace_promise_async_end')
    ch.subscribe(subs)

    const resultPromise = test().then(result => {
      steps.push('resolved')
      return result
    })

    await Promise.resolve()

    assert.deepStrictEqual(steps, ['asyncEnd'])

    const result = await resultPromise

    assert.equal(result, 'result')
    assert.deepStrictEqual(steps, ['asyncEnd', 'asyncEndPromise', 'resolved'])
  })

  it('should use import when rewriting esm modules', () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'pregel-class.js')

    content = readFileSync(filename, 'utf8')
    content = rewriter.rewrite(content, filename, 'module')

    assert.match(content, /\bimport\s+.+\s+from\s+"file:\/\//)
    assert.match(content, /tr_ch_apm_tracingChannel/)
    assert.doesNotMatch(content, /require\("/)
  })

  it('should rewrite ESM modules with returnKind: AsyncIterator without injecting require()', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'pregel-class.js')
    const source = readFileSync(filename, 'utf8')

    const rewritten = rewriter.rewrite(source, filename, 'module')

    assert.match(rewritten, /^import\s/m, 'expected an ESM import in the rewritten output')
    assert.doesNotMatch(rewritten, /\brequire\s*\(/, 'CJS require() must not appear in ESM output')
    assert.match(rewritten, /from\s+"file:\/\/[^"]+"/, 'dc-polyfill specifier must be a file:// URL for ESM')

    // End-to-end: write the rewritten module to disk and dynamic-import it.
    // This is what fails at runtime today when the local transform emits
    // `require()` (no `require` in ESM scope) or a bare absolute path (Node
    // rejects with ERR_INVALID_MODULE_SPECIFIER).
    const dir = mkdtempSync(join(tmpdir(), 'dd-rewriter-esm-'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    const outFile = join(dir, 'pregel-class.mjs')
    writeFileSync(outFile, rewritten)

    ch = tracingChannel('orchestrion:test-esm:pregel_stream')
    subs = { start: sinon.spy() }
    ch.subscribe(subs)

    const mod = await import(pathToFileURL(outFile).href)
    const iter = new mod.Pregel().stream()
    await iter.next()

    assert.ok(subs.start.calledOnce, 'instrumented start channel should fire once')
  })
})

describe('rewriter source-map trailer', () => {
  const rewriterPath = require.resolve('../../../src/helpers/rewriter')

  it('does not embed a sourceMappingURL comment token in its own source', () => {
    const source = readFileSync(rewriterPath, 'utf8')

    assert.doesNotMatch(source, /\/\/[#@]\s*sourceMappingURL=/)
  })

  it('does not crash source-map-support when formatting a frame in its own file', () => {
    const sourceMapSupport = require('source-map-support')
    const originalPrepareStackTrace = Error.prepareStackTrace
    sourceMapSupport.install({ environment: 'node', handleUncaughtExceptions: false })

    try {
      const boom = vm.runInThisContext(
        '(function boom () { return new Error("boom") })',
        { filename: rewriterPath }
      )

      const { stack } = boom()

      assert.match(stack, /rewriter[/\\]index\.js/)
    } finally {
      Error.prepareStackTrace = originalPrepareStackTrace
      sourceMapSupport.resetRetrieveHandlers()
      delete require.cache[require.resolve('source-map-support')]
    }
  })
})
