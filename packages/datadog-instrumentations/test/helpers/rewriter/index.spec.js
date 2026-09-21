'use strict'

const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
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
const { parse, query } = require('../../../src/helpers/rewriter/compiler')

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
    content = rewriter.rewrite(content, filename, format, {
      moduleName: name,
      filePath: 'index.js',
    })

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
    content = rewriter.rewrite(content, filename, format, {
      moduleName: 'test',
      filePath: `${name}.js`,
    })

    mod.filename = filename
    mod.paths = Module._nodeModulePaths(dirname(filename))
    mod._compile(content, filename, format)

    return mod.exports
  }

  /** @param {string} source */
  function assertInactiveFastPath (source) {
    const guardIndex = source.indexOf('if (!tr_ch_apm_hasSubscribers')
    const argumentsIndex = source.indexOf('const __apm$arguments =')

    assert.notStrictEqual(guardIndex, -1)
    assert.ok(argumentsIndex > guardIndex)
    assert.doesNotMatch(source, /const __apm\$traced =/)
  }

  beforeEach(() => {
    ch = undefined
    subs = undefined

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
            name: 'test-trace-sync',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            functionName: 'test',
          },
          transform: 'configureGraphqlFastPath',
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
            name: 'test-trace-async',
            versionRange: '>=0.1',
            filePath: 'index.js',
          },
          functionQuery: {
            functionName: 'test',
          },
          transform: 'configureGraphqlFastPath',
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
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            functionName: 'runWithRetry',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runWithRetry"] CatchClause ' +
            'IfStatement[test.operator=">"][test.left.object.name="state"]' +
            '[test.left.property.name="remaining"]',
          channelName: 'trace_await_context_callback',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackArgumentNames: ['error'],
            callbackName: 'beforeContinue',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            className: 'ContextRunner',
            methodName: 'run',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_this',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'ClassDeclaration[id.name="ContextRunner"] ' +
            'MethodDefinition[key.name="run"] IfStatement',
          channelName: 'trace_await_context_callback_this',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeContinue',
            callbackThis: true,
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            functionName: 'runAfterSetup',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_at_try_start',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runAfterSetup"] TryStatement > BlockStatement',
          channelName: 'trace_await_context_callback_at_try_start',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeStart',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            functionName: 'runFromStart',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_at_function_start',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runFromStart"]',
          channelName: 'trace_await_context_callback_at_function_start',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeStart',
          },
        },
        // Matching the same function twice verifies that the transform checks its resolved insertion target.
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runFromStart"]',
          channelName: 'trace_await_context_callback_at_function_start',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeStart',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback-outer-try.js',
          },
          functionQuery: {
            functionName: 'tracedNested',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_outer_try',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback-outer-try.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runNestedWithoutTry"] > BlockStatement > ' +
            'TryStatement > BlockStatement',
          channelName: 'trace_await_context_callback_outer_try',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeStart',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            functionName: 'consumeFirst',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_side_effect',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="consumeFirst"] ' +
            'IfStatement[test.callee.object.name="queue"][test.callee.property.name="shift"]',
          channelName: 'trace_await_context_callback_side_effect',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeContinue',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          functionQuery: {
            functionName: 'chooseBranch',
            kind: 'Async',
          },
          channelName: 'trace_await_context_callback_alternate',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback.js',
          },
          astQuery: 'FunctionDeclaration[id.name="chooseBranch"] ' +
            'IfStatement[test.object.name="state"][test.property.name="usePrimary"]',
          channelName: 'trace_await_context_callback_alternate',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeContinue',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback-sync.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runSynchronously"] IfStatement',
          channelName: 'trace_await_context_callback_sync',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeContinue',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'trace-await-context-callback-unwrapped.js',
          },
          astQuery: 'FunctionDeclaration[id.name="runUnwrapped"] IfStatement',
          channelName: 'trace_await_context_callback_unwrapped',
          transform: 'awaitContextCallback',
          transformOptions: {
            callbackName: 'beforeContinue',
          },
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'durable-orchestration-executor.js',
          },
          functionQuery: {
            className: 'TaskOrchestrationExecutor',
            methodName: 'execute',
          },
          channelName: 'TaskOrchestrationExecutor_failure',
          transform: 'publishDurableOrchestrationFailure',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'postgres-query-alias.js',
          },
          astQuery: 'Program',
          transform: 'postgresQueryHandlers',
          channelName: 'query',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'postgres-query-async-handler.js',
          },
          astQuery: 'Program',
          transform: 'postgresQueryHandlers',
          channelName: 'query',
        },
        {
          module: {
            name: 'test',
            versionRange: '>=0.1',
            filePath: 'postgres-query-generator-handler.js',
          },
          astQuery: 'Program',
          transform: 'postgresQueryHandlers',
          channelName: 'query',
        },
        {
          module: {
            name: 'test-esm',
            versionRange: '>=0.1',
            filePath: 'postgres-query-alias.js',
          },
          astQuery: 'Program',
          transform: 'postgresQueryHandlers',
          channelName: 'query',
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
        {
          module: {
            name: 'test-esm',
            versionRange: '>=0.1',
            filePath: 'exported-function.mjs',
          },
          functionQuery: {
            functionName: 'execute',
            kind: 'Sync',
          },
          channelName: 'execute',
        },
        {
          module: {
            name: 'test-esm',
            versionRange: '>=0.1',
            filePath: 'exported-function.mjs',
          },
          functionQuery: {
            functionName: 'execute',
          },
          transform: 'configureGraphqlFastPath',
          channelName: 'execute',
        },
      ],
    })
  })

  afterEach(() => {
    if (ch && subs) ch.unsubscribe(subs)
  })

  it('should auto instrument sync functions', done => {
    const { test } = compile('test-trace-sync')
    assertInactiveFastPath(content)

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
    assertInactiveFastPath(content)

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

  it('should wait for the resolve callback only before resolving', async () => {
    const { test } = compileFile('trace-promise-async-end')
    const steps = []

    subs = {
      asyncEnd (ctx) {
        steps.push('asyncEnd')
        ctx.resolveCallback = onDone => {
          setImmediate(() => {
            steps.push('resolveCallback')
            onDone()
          })
        }
        ctx.rejectCallback = () => {
          assert.fail('reject callback called for a fulfilled promise')
        }
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
    assert.deepStrictEqual(steps, ['asyncEnd', 'resolveCallback', 'resolved'])
  })

  it('should wait for the reject callback only before preserving a rejection', async () => {
    const { test } = compileFile('trace-promise-async-end')
    const error = new Error('test rejection')
    const steps = []

    subs = {
      asyncEnd (ctx) {
        steps.push('asyncEnd')
        ctx.resolveCallback = () => {
          assert.fail('resolve callback called for a rejected promise')
        }
        ctx.rejectCallback = onDone => {
          setImmediate(() => {
            steps.push('rejectCallback')
            onDone()
          })
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_promise_async_end')
    ch.subscribe(subs)

    const resultPromise = test(error)

    await Promise.resolve()

    assert.deepStrictEqual(steps, ['asyncEnd'])
    await assert.rejects(resultPromise, actualError => {
      steps.push('rejected')
      return actualError === error
    })
    assert.deepStrictEqual(steps, ['asyncEnd', 'rejectCallback', 'rejected'])
  })

  it('should preserve promise settlement when its callback throws', async () => {
    const { test } = compileFile('trace-promise-async-end')
    const error = new Error('test rejection')

    subs = {
      asyncEnd (ctx) {
        ctx.resolveCallback = () => {
          throw new Error('resolve callback error')
        }
        ctx.rejectCallback = () => {
          throw new Error('reject callback error')
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_promise_async_end')
    ch.subscribe(subs)

    const [result] = await Promise.all([
      test(),
      assert.rejects(test(error), actualError => actualError === error),
    ])

    assert.equal(result, 'result')
  })

  it('should await a context callback before continuing through a conditional branch', async () => {
    const { runWithRetry } = compileFile('trace-await-context-callback')
    const callbackError = new Error('first attempt failed')
    const steps = []
    let finishCallback
    let startCallback
    const callbackStarted = new Promise(resolve => {
      startCallback = resolve
    })
    const callbackFinished = new Promise(resolve => {
      finishCallback = resolve
    })
    let attempts = 0

    subs = {
      start (ctx) {
        ctx.beforeContinue = error => {
          steps.push(error)
          startCallback()
          return callbackFinished
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback')
    ch.subscribe(subs)

    const resultPromise = runWithRetry(() => {
      attempts++
      if (attempts === 1) throw callbackError
      return 'passed'
    }, { remaining: 1 })

    await callbackStarted

    assert.equal(attempts, 1)
    assert.deepStrictEqual(steps, [callbackError])

    finishCallback()

    assert.equal(await resultPromise, 'passed')
    assert.equal(attempts, 2)
  })

  it('should await a context callback before entering a try block', async () => {
    const { runAfterSetup } = compileFile('trace-await-context-callback')
    const steps = []
    let finishSetup
    let startSetup
    const setupStarted = new Promise(resolve => {
      startSetup = resolve
    })
    const setupFinished = new Promise(resolve => {
      finishSetup = resolve
    })

    subs = {
      start (ctx) {
        ctx.beforeStart = async function () {
          steps.push('setup')
          startSetup()
          await setupFinished
          steps.push('setup done')
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback_at_try_start')
    ch.subscribe(subs)

    const resultPromise = runAfterSetup(() => {
      steps.push('task')
      return 'passed'
    })

    await setupStarted
    assert.deepStrictEqual(steps, ['setup'])

    finishSetup()

    assert.equal(await resultPromise, 'passed')
    assert.deepStrictEqual(steps, ['setup', 'setup done', 'task'])
  })

  it('should await a context callback before starting an async function body', async () => {
    const { runFromStart } = compileFile('trace-await-context-callback')
    const steps = []

    const rewrittenFunction = query(parse(content),
      ':matches(FunctionDeclaration, FunctionExpression)[async=true]')
      .find(node => node.body.body[0]?.directive === 'use strict')
    assert(rewrittenFunction)
    assert.equal(rewrittenFunction.body.body[0].directive, 'use strict')
    assert.equal(query(rewrittenFunction, 'VariableDeclarator[id.name="__apm$beforeStart"]').length, 1)

    subs = {
      start (ctx) {
        ctx.beforeStart = async function () {
          steps.push('callback')
          await new Promise(resolve => setImmediate(resolve))
          steps.push('callback done')
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback_at_function_start')
    ch.subscribe(subs)

    assert.equal(await runFromStart((value) => {
      steps.push('task')
      return value
    }), 'passed')
    assert.deepStrictEqual(steps, ['callback', 'callback done', 'task'])
  })

  it('should preserve a try block when context callback lookup throws', async () => {
    const { runAfterSetup } = compileFile('trace-await-context-callback')

    subs = {
      start (ctx) {
        Object.defineProperty(ctx, 'beforeStart', {
          get () {
            throw new Error('observability callback lookup failed')
          },
        })
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback_at_try_start')
    ch.subscribe(subs)

    assert.equal(await runAfterSetup(() => 'passed'), 'passed')
  })

  it('should leave a matched block outside the traced function untouched', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test', 'trace-await-context-callback-outer-try.js')
    const source = readFileSync(filename, 'utf8')
    const { runNestedWithoutTry } = compileFile('trace-await-context-callback-outer-try')

    assert.strictEqual(content, source)
    assert.equal(await runNestedWithoutTry(() => 'passed'), 'passed')
  })

  it('should call a context callback with the instrumented receiver', async () => {
    const { ContextRunner } = compileFile('trace-await-context-callback')
    const runner = new ContextRunner()

    subs = {
      start (ctx) {
        ctx.beforeContinue = async function () {
          assert.strictEqual(this, runner)
          await new Promise(resolve => setImmediate(resolve))
        }
      },
    }
    ch = tracingChannel('orchestrion:test:trace_await_context_callback_this')
    ch.subscribe(subs)

    assert.equal(await runner.run({ shouldContinue: true }), 'continued')
  })

  it('should recheck the condition after the context callback settles', async () => {
    const { runWithRetry } = compileFile('trace-await-context-callback')
    const callbackError = new Error('do not retry')
    const state = { remaining: 1 }
    let attempts = 0

    subs = {
      start (ctx) {
        ctx.beforeContinue = () => {
          state.remaining = 0
        }
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback')
    ch.subscribe(subs)

    await assert.rejects(runWithRetry(() => {
      attempts++
      throw callbackError
    }, state), error => error === callbackError)

    assert.equal(attempts, 1)
    assert.equal(state.remaining, 0)
  })

  it('should preserve the conditional branch when the context callback rejects', async () => {
    const { runWithRetry } = compileFile('trace-await-context-callback')
    let attempts = 0

    subs = {
      start (ctx) {
        ctx.beforeContinue = () => Promise.reject(new Error('observability callback failed'))
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback')
    ch.subscribe(subs)

    const result = await runWithRetry(() => {
      attempts++
      if (attempts === 1) throw new Error('first attempt failed')
      return 'passed'
    }, { remaining: 1 })

    assert.equal(result, 'passed')
    assert.equal(attempts, 2)
  })

  it('should preserve the conditional branch when context callback lookup throws', async () => {
    const { runWithRetry } = compileFile('trace-await-context-callback')
    let attempts = 0

    subs = {
      start (ctx) {
        Object.defineProperty(ctx, 'beforeContinue', {
          get () {
            throw new Error('observability callback lookup failed')
          },
        })
      },
    }

    ch = tracingChannel('orchestrion:test:trace_await_context_callback')
    ch.subscribe(subs)

    const result = await runWithRetry(() => {
      attempts++
      if (attempts === 1) throw new Error('first attempt failed')
      return 'passed'
    }, { remaining: 1 })

    assert.equal(result, 'passed')
    assert.equal(attempts, 2)
  })

  it('should not recheck a side-effectful condition when no context callback exists', async () => {
    const { consumeFirst } = compileFile('trace-await-context-callback')
    const queue = [true, 'remaining']

    subs = { start: sinon.spy() }
    ch = tracingChannel('orchestrion:test:trace_await_context_callback_side_effect')
    ch.subscribe(subs)

    assert.equal(await consumeFirst(queue), 1)
    assert.deepStrictEqual(queue, ['remaining'])
  })

  it('should use the alternate branch when the rechecked condition changes', async () => {
    const { chooseBranch } = compileFile('trace-await-context-callback')
    const state = { usePrimary: true }

    subs = {
      start (ctx) {
        ctx.beforeContinue = () => {
          state.usePrimary = false
        }
      },
    }
    ch = tracingChannel('orchestrion:test:trace_await_context_callback_alternate')
    ch.subscribe(subs)

    assert.equal(await chooseBranch(state), 'fallback')
  })

  it('should leave synchronous callback targets untouched', () => {
    const filename = resolve(__dirname, 'node_modules', 'test', 'trace-await-context-callback-sync.js')
    const source = readFileSync(filename, 'utf8')

    subs = { start: sinon.spy() }
    ch = tracingChannel('orchestrion:test:trace_await_context_callback_sync')
    ch.subscribe(subs)

    const { runSynchronously } = compileFile('trace-await-context-callback-sync')

    assert.strictEqual(content, source)
    assert.equal(runSynchronously({ shouldContinue: true }), 'continued')
    assert.equal(subs.start.callCount, 0)
  })

  it('should leave targets without a trace wrapper untouched', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test', 'trace-await-context-callback-unwrapped.js')
    const source = readFileSync(filename, 'utf8')

    subs = { start: sinon.spy() }
    ch = tracingChannel('orchestrion:test:trace_await_context_callback_unwrapped')
    ch.subscribe(subs)

    const { runUnwrapped } = compileFile('trace-await-context-callback-unwrapped')

    assert.strictEqual(content, source)
    assert.equal(await runUnwrapped({ shouldContinue: true }), 'continued')
    assert.equal(subs.start.callCount, 0)
  })

  it('should publish durable orchestration failures without wrapping the result', () => {
    ch = tracingChannel('orchestrion:test:TaskOrchestrationExecutor_failure')
    subs = { end: sinon.spy() }
    ch.subscribe(subs)

    const TaskOrchestrationExecutor = compileFile('durable-orchestration-executor')
    const executor = new TaskOrchestrationExecutor()
    const context = {}
    const history = []

    const result = executor.execute(context, history)
    assert.deepStrictEqual(result, { context, history })
    sinon.assert.notCalled(subs.end)

    const error = new Error('orchestration failed')
    executor.exception = error

    assert.throws(() => executor.execute(context, history), candidate => candidate === error)
    sinon.assert.calledOnce(subs.end)

    const failure = subs.end.firstCall.args[0]
    assert.strictEqual(failure.arguments[0], context)
    assert.strictEqual(failure.arguments[1], history)
    assert.strictEqual(failure.error, error)
  })

  it('should leave dependencies without a rewrite target untouched', () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'pregel-class.js')
    const source = readFileSync(filename, 'utf8')

    assert.strictEqual(rewriter.rewrite(source, filename, 'module'), source)
  })

  it('should use import when rewriting esm modules', () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'pregel-class.js')

    content = readFileSync(filename, 'utf8')
    content = rewriter.rewrite(content, filename, 'module', {
      moduleName: 'test-esm',
      filePath: 'pregel-class.js',
    })

    // eslint-disable-next-line regexp/no-super-linear-backtracking -- Generated fixture content is bounded.
    assert.match(content, /\bimport\s+.+\s+from\s+"file:\/\//)
    assert.match(content, /tr_ch_apm_tracingChannel/)
    assert.doesNotMatch(content, /require\("/)
  })

  it('should apply the inactive fast path to exported ESM functions', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'exported-function.mjs')
    const source = 'export function execute (value) { return value }\n'
    const rewritten = rewriter.rewrite(source, filename, 'module', {
      moduleName: 'test-esm',
      filePath: 'exported-function.mjs',
    })

    assertInactiveFastPath(rewritten)
    const originalIndex = rewritten.indexOf('const __apm$original_execute =')
    const exportIndex = rewritten.indexOf('export function execute')
    assert.notStrictEqual(originalIndex, -1)
    assert.ok(exportIndex > originalIndex)

    const dir = mkdtempSync(join(tmpdir(), 'dd-rewriter-esm-fast-path-'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    const outFile = join(dir, 'pregel-class.mjs')
    writeFileSync(outFile, rewritten)

    const mod = await import(pathToFileURL(outFile).href)
    assert.equal(mod.execute('result'), 'result')
  })

  it('should rewrite ESM modules with returnKind: AsyncIterator without injecting require()', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test-esm', 'pregel-class.js')
    const source = readFileSync(filename, 'utf8')

    const rewritten = rewriter.rewrite(source, filename, 'module', {
      moduleName: 'test-esm',
      filePath: 'pregel-class.js',
    })

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

  it('should ignore unrelated destructured requires and use an aliased Postgres Query binding', () => {
    ch = tracingChannel('orchestrion:test:query')
    subs = { start: sinon.spy() }
    ch.subscribe(subs)

    const Postgres = compileFile('postgres-query-alias')
    const queries = Postgres()

    assert.strictEqual(queries.length, 2)
    assert.strictEqual(subs.start.callCount, 2)
  })

  it('should use an aliased Postgres Query import binding', async () => {
    const fixtureDirectory = resolve(__dirname, 'node_modules', 'test-esm')
    const filename = join(fixtureDirectory, 'postgres-query-alias.js')
    const source = readFileSync(filename, 'utf8')
    const rewritten = rewriter.rewrite(source, filename, 'module', {
      moduleName: 'test-esm',
      filePath: 'postgres-query-alias.js',
    })
    const directory = mkdtempSync(join(tmpdir(), 'dd-rewriter-postgres-esm-'))
    const outputFile = join(directory, 'postgres-query-alias.js')

    writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
    writeFileSync(join(directory, 'query.js'), readFileSync(join(fixtureDirectory, 'query.js')))
    writeFileSync(outputFile, rewritten)

    ch = tracingChannel('orchestrion:test-esm:query')
    subs = { start: sinon.spy() }
    ch.subscribe(subs)

    const { default: Postgres } = await import(pathToFileURL(outputFile).href)
    const queries = Postgres()

    assert.strictEqual(queries.length, 2)
    assert.strictEqual(subs.start.callCount, 2)
  })

  it('should leave async Postgres handlers untouched', async () => {
    const filename = resolve(__dirname, 'node_modules', 'test', 'postgres-query-async-handler.js')
    const source = readFileSync(filename, 'utf8')

    ch = tracingChannel('orchestrion:test:query')
    subs = { start: sinon.spy() }
    ch.subscribe(subs)

    const Postgres = compileFile('postgres-query-async-handler')
    const queries = await Promise.all(Postgres())

    assert.strictEqual(content, source)
    assert.strictEqual(queries.length, 2)
    assert.strictEqual(subs.start.callCount, 0)
  })

  it('should leave generator Postgres handlers untouched', () => {
    const filename = resolve(__dirname, 'node_modules', 'test', 'postgres-query-generator-handler.js')
    const source = readFileSync(filename, 'utf8')

    ch = tracingChannel('orchestrion:test:query')
    subs = { start: sinon.spy() }
    ch.subscribe(subs)

    const Postgres = compileFile('postgres-query-generator-handler')
    const queries = Postgres()

    assert.strictEqual(content, source)
    assert.strictEqual(queries[0].next().value.constructor.name, 'Query')
    assert.strictEqual(queries[1].next().value.constructor.name, 'Query')
    assert.strictEqual(subs.start.callCount, 0)
  })
})

describe('rewriter loader correctness', () => {
  const target = { moduleName: 'test', filePath: 'index.js' }

  function createFixture () {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter fixture-'))
    const packageDirectory = join(root, 'node_modules', 'test')
    const filename = join(packageDirectory, target.filePath)
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    return { filename, root }
  }

  function loadRewriter ({ disabled = new Set(), transform = source => ({ code: source }) } = {}) {
    const matcher = {
      addTransform: sinon.stub(),
      getTransformer: sinon.stub().returns({ transform }),
    }
    const create = sinon.stub().returns(matcher)
    const rewriter = proxyquire('../../../src/helpers/rewriter', {
      '../../../../dd-trace/src/log': { '@noCallThru': true, error: sinon.stub() },
      '../../../../../vendor/dist/@apm-js-collab/code-transformer': { '@noCallThru': true, create },
      '../instrumentation-utils': { '@noCallThru': true, getDisabledInstrumentations: () => disabled },
      './instrumentations': { '@noCallThru': true },
      './transforms': { '@noCallThru': true },
      './transforms/postgres': { '@noCallThru': true },
    })
    return { create, matcher, rewriter }
  }

  it('resolves versions from encoded file URLs for loader and bundler rewrites', () => {
    const { filename, root } = createFixture()
    const { matcher, rewriter } = loadRewriter()
    const rewriteBundled = rewriter.createBundlerRewriter('/dc')
    const source = 'module.exports = true\n'

    try {
      assert.strictEqual(rewriter.rewrite(source, pathToFileURL(filename).href, 'commonjs', target), source)
      assert.deepStrictEqual(
        rewriteBundled(source, pathToFileURL(filename).href, 'commonjs', target),
        { code: source }
      )
      sinon.assert.calledTwice(matcher.getTransformer)
      sinon.assert.alwaysCalledWithExactly(matcher.getTransformer, 'test', '1.2.3', 'index.js')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('resolves versions from Windows-style loader paths', () => {
    const { filename, root } = createFixture()
    const { matcher, rewriter } = loadRewriter()
    const source = 'module.exports = true\n'

    try {
      assert.strictEqual(rewriter.rewrite(source, filename.replaceAll('/', '\\'), 'commonjs', target), source)
      sinon.assert.calledOnceWithExactly(matcher.getTransformer, 'test', '1.2.3', 'index.js')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('honors disabled instrumentations in an isolated loader module graph', () => {
    const { filename, root } = createFixture()
    const { create, rewriter } = loadRewriter({ disabled: new Set(['test']) })
    const source = 'module.exports = true\n'

    try {
      assert.strictEqual(rewriter.rewrite(source, filename, 'commonjs', target), source)
      sinon.assert.notCalled(create)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns the original source when the package version cannot be resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-missing-version-'))
    const filename = join(root, 'node_modules', 'test', target.filePath)
    const { create, rewriter } = loadRewriter()
    const source = 'module.exports = true\n'

    try {
      assert.strictEqual(rewriter.rewrite(source, filename, 'commonjs', target), source)
      sinon.assert.notCalled(create)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('restores stripped shebangs and shifts object source maps', () => {
    const { filename, root } = createFixture()
    const sourceMap = { mappings: 'AAAA', names: [], sources: ['index.js'], version: 3 }
    const { rewriter } = loadRewriter({
      transform: () => ({ code: 'module.exports = true', map: sourceMap }),
    })
    const source = '#!/usr/bin/env node\nmodule.exports = true\n'

    try {
      const rewritten = rewriter.rewrite(source, filename, 'commonjs', target)
      const marker = '//# sourceMappingURL=data:application/json;base64,'
      const markerIndex = rewritten.indexOf(marker)

      assert.notStrictEqual(markerIndex, -1)
      const parsedMap = JSON.parse(Buffer.from(rewritten.slice(markerIndex + marker.length), 'base64').toString())

      assert.match(rewritten, /^#!\/usr\/bin\/env node\nmodule\.exports = true/)
      assert.strictEqual(parsedMap.mappings, ';AAAA')
      assert.strictEqual(sourceMap.mappings, 'AAAA')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('restores a stripped shebang without a trailing newline', () => {
    const { filename, root } = createFixture()
    const { rewriter } = loadRewriter({ transform: () => ({ code: 'module.exports = true' }) })
    const source = '#!/usr/bin/env node'

    try {
      assert.strictEqual(
        rewriter.rewrite(source, filename, 'commonjs', target),
        `${source}\nmodule.exports = true`
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
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

describe('rewriter initialization', () => {
  const repositoryRoot = resolve(__dirname, '../../../../..')
  const transformerPath = join(repositoryRoot, 'vendor', 'dist', '@apm-js-collab', 'code-transformer')
  const loaderPath = resolve(__dirname, '../../../src/helpers/rewriter/loader')

  it('loads the code transformer on the first rewrite instead of at startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-defer-'))
    const targetDirectory = join(root, 'node_modules', 'ai')
    const untargetedDirectory = join(root, 'node_modules', 'untargeted')

    mkdirSync(join(targetDirectory, 'dist'), { recursive: true })
    writeFileSync(join(targetDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(targetDirectory, 'dist', 'index.js'), `
      function getTracer () { return 'tracer' }
      module.exports = { getTracer }
    `)

    mkdirSync(untargetedDirectory, { recursive: true })
    writeFileSync(join(untargetedDirectory, 'package.json'), '{"version":"1.0.0"}')
    writeFileSync(join(untargetedDirectory, 'index.js'), 'module.exports = {}\n')

    writeFileSync(join(root, 'main.js'), `
      const transformerPath = require.resolve(${JSON.stringify(transformerPath)})

      require(${JSON.stringify(loaderPath)})

      const loadedAfterHook = require.cache[transformerPath] !== undefined

      require('untargeted')

      const loadedAfterUntargetedModule = require.cache[transformerPath] !== undefined

      const { tracingChannel } = require(${JSON.stringify(require.resolve('dc-polyfill'))})
      let starts = 0

      tracingChannel('orchestrion:ai:getTracer').subscribe({ start () { starts++ } })
      require('ai').getTracer()

      console.log(JSON.stringify({
        loadedAfterHook,
        loadedAfterUntargetedModule,
        loadedAfterTargetModule: require.cache[transformerPath] !== undefined,
        starts,
      }))
    `)

    const result = spawnSync(process.execPath, [join(root, 'main.js')], { cwd: root, encoding: 'utf8' })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      loadedAfterHook: false,
      loadedAfterUntargetedModule: false,
      loadedAfterTargetModule: true,
      starts: 1,
    })
  })
})
