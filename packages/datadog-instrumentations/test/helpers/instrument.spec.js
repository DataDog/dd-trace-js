'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const { addHook, AsyncResource, channel, createErrorPublisher, getHooks } = require('../../src/helpers/instrument')
const instrumentations = require('../../src/helpers/instrumentations')
const rewriterInstrumentations = require('../../src/helpers/rewriter/instrumentations')

describe('helpers/instrument', () => {
  it('marks source-rewrite hooks with their original file path', () => {
    const hooks = getHooks(['ai'])
    const instrumentation = hooks.find(({ file }) => file === 'dist/index.js')
    const original = instrumentations.ai
    const originalLength = original?.length ?? 0

    assert.ok(instrumentation)
    assert.equal(Object.hasOwn(instrumentation, 'sourceRewrite'), false)
    instrumentation.file = null

    try {
      addHook(instrumentation, () => {})
      assert.equal(instrumentations.ai.at(-1).file, null)
      assert.equal(instrumentations.ai.at(-1).sourceRewrite, 'dist/index.js')
    } finally {
      if (original) {
        original.length = originalLength
      } else {
        delete instrumentations.ai
      }
    }
  })

  describe('getHooks', () => {
    it('returns one hook per distinct module, not per rewriter transform', () => {
      // mercurius is instrumented by three transforms that all share one
      // module definition, so only one hook may come back.
      const hooks = getHooks('mercurius')

      assert.deepStrictEqual(hooks, [{ name: 'mercurius', versions: ['>=13'], file: 'index.js' }])
    })

    it('never repeats a hook across the whole rewriter instrumentation list', () => {
      const moduleNames = new Set(rewriterInstrumentations.map(inst => inst.module.name))

      for (const name of moduleNames) {
        const seen = new Set()
        for (const { versions, file } of getHooks(name)) {
          const key = `${file}|${versions.join(',')}`
          assert.ok(!seen.has(key), `duplicate hook for ${name}: ${key}`)
          seen.add(key)
        }
      }
    })

    it('keeps same-file hooks of different packages apart when names are combined', () => {
      // Every @wdio/* module targets '>=9.0.0' with build/index.js, so
      // (versionRange, filePath) collide across packages. They are distinct
      // hooks: deduplication must only collapse same-package transform
      // repeats, never a different package with the same target file.
      const combined = getHooks(['@wdio/cli', '@wdio/local-runner', '@wdio/runner'])

      assert.deepStrictEqual(
        combined.map(({ name }) => name).sort(),
        ['@wdio/cli', '@wdio/local-runner', '@wdio/runner']
      )
      assert.deepStrictEqual(
        combined,
        getHooks('@wdio/cli').concat(getHooks('@wdio/local-runner'), getHooks('@wdio/runner'))
      )
    })

    it('keeps distinct version ranges and files of the same module apart', () => {
      // graphql is targeted through many files; each distinct (version range,
      // file) pair stays a separate hook even after deduplication.
      const pairs = new Set(getHooks('graphql').map(({ versions, file }) => `${versions.join(',')}|${file}`))
      const expectedPairs = new Set(
        rewriterInstrumentations
          .filter(({ module }) => module.name === 'graphql')
          .map(({ module: { versionRange, filePath } }) => `${versionRange}|${filePath}`)
      )

      assert.strictEqual(pairs.size, expectedPairs.size)
      assert.strictEqual(pairs.size, getHooks('graphql').length)
    })

    it('hands out fresh hook objects so caller mutations cannot leak between calls', () => {
      // the ai, claude-agent-sdk and aws-durable-execution-sdk-js plugins set
      // `hook.file = null` before registering; the hooks (and their versions
      // arrays) must not be shared cached objects or such a mutation would
      // corrupt every later getHooks call in the same process.
      const pristine = getHooks('ai')
      const mutated = getHooks('ai')
      for (const hook of mutated) {
        hook.file = null
        hook.versions.push('mutated')
      }

      assert.deepStrictEqual(getHooks('ai'), pristine)
      assert.notStrictEqual(getHooks('ai')[0], mutated[0])
      assert.notStrictEqual(getHooks('ai')[0].versions, mutated[0].versions)
    })

    it('combines names, ignores repeats, and answers unknown names with an empty list', () => {
      const mercurius = getHooks('mercurius')
      const bullmq = getHooks('bullmq')

      // Combined results keep the rewriter list order (as on master) rather
      // than request order, and contain exactly the single-name results.
      const combined = getHooks(['mercurius', 'bullmq'])
      const key = ({ name, versions, file }) => `${name}|${versions.join(',')}|${file}`
      assert.deepStrictEqual(combined, getHooks(['bullmq', 'mercurius']))
      assert.deepStrictEqual(combined.map(key).sort(), [...mercurius, ...bullmq].map(key).sort())
      assert.deepStrictEqual(getHooks(['mercurius', 'mercurius']), mercurius)
      assert.deepStrictEqual(getHooks('nope-not-a-module'), [])
      assert.deepStrictEqual(getHooks([]), [])
    })
  })

  describe('createErrorPublisher', () => {
    it('drops a re-entrant publish through the same publisher', () => {
      const errorChannel = channel('apm:test:publish-error:same')
      const publishError = createErrorPublisher(errorChannel)
      let depth = 0
      const listener = () => {
        depth++
        if (depth > 10) return // a regressed guard fails the assert, not the runner
        publishError({ error: new Error('boom') })
      }

      errorChannel.subscribe(listener)
      try {
        publishError({ error: new Error('boom') })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      assert.strictEqual(depth, 1)
    })

    it('still publishes a nested error through a different publisher', () => {
      const outerChannel = channel('apm:test:publish-error:outer')
      const innerChannel = channel('apm:test:publish-error:inner')
      const publishOuter = createErrorPublisher(outerChannel)
      const publishInner = createErrorPublisher(innerChannel)
      const innerListener = sinon.stub()
      // A subscriber on one framework's error channel synchronously drives a
      // different instrumented framework into its error path. A shared guard
      // would drop the inner publish; a per-publisher flag must not.
      const outerListener = () => {
        publishInner({ error: new Error('inner') })
      }

      outerChannel.subscribe(outerListener)
      innerChannel.subscribe(innerListener)
      try {
        publishOuter({ error: new Error('outer') })
      } finally {
        outerChannel.unsubscribe(outerListener)
        innerChannel.unsubscribe(innerListener)
      }

      sinon.assert.calledOnce(innerListener)
    })

    it('clears the guard so the same publisher publishes again afterwards', () => {
      const errorChannel = channel('apm:test:publish-error:reset')
      const publishError = createErrorPublisher(errorChannel)
      const listener = sinon.stub()

      errorChannel.subscribe(listener)
      try {
        publishError({ error: new Error('first') })
        publishError({ error: new Error('second') })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      sinon.assert.calledTwice(listener)
    })

    it('republishes the same error object on each sequential publish', () => {
      // koa, router, connect and restify republish the one thrown error once per
      // unwound middleware layer so each layer's span gets tagged. The shared
      // publisher must not collapse those repeats by error identity - only the
      // synchronous re-entry above is dropped.
      const errorChannel = channel('apm:test:publish-error:same-object')
      const publishError = createErrorPublisher(errorChannel)
      const listener = sinon.stub()
      const error = new Error('boom')

      errorChannel.subscribe(listener)
      try {
        publishError({ error })
        publishError({ error })
        publishError({ error })
      } finally {
        errorChannel.unsubscribe(listener)
      }

      sinon.assert.calledThrice(listener)
    })
  })

  describe('AsyncResource', () => {
    it('should bind statically', () => {
      storage('legacy').run('test1', () => {
        const tested = AsyncResource.bind(() => {
          assert.strictEqual(storage('legacy').getStore(), 'test1')
        })

        storage('legacy').run('test2', () => {
          tested()
        })
      })
    })

    it('should bind with the right `this` value statically', () => {
      const self = 'test'

      const tested = AsyncResource.bind(function (a, b, c) {
        assert.strictEqual(this, self)
        assert.strictEqual(tested.length, 3)
      }, 'test', self)

      tested()
    })

    it('should bind a specific instance', () => {
      storage('legacy').run('test1', () => {
        const asyncResource = new AsyncResource('test')

        storage('legacy').run('test2', () => {
          const tested = asyncResource.bind((a, b, c) => {
            assert.strictEqual(storage('legacy').getStore(), 'test1')
            assert.strictEqual(tested.length, 3)
          })

          tested()
        })
      })
    })

    it('should bind with the right `this` value with an instance', () => {
      const self = 'test'

      const asyncResource = new AsyncResource('test')
      const tested = asyncResource.bind(function () {
        assert.strictEqual(this, self)
      }, self)

      tested()
    })
  })
})
