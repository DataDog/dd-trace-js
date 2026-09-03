'use strict'

const assert = require('node:assert/strict')
const { errorMonitor, EventEmitter, once } = require('node:events')
const os = require('node:os')
const path = require('node:path')
const { describe, it, after, afterEach, before, beforeEach } = require('mocha')

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')

const opErrorCh = dc.channel('apm:fs:operation:error')
const opStartCh = dc.channel('apm:fs:operation:start')

const streamConstructors = [
  { methodName: 'createReadStream', className: 'ReadStream', resource: 'ReadStream' },
  { methodName: 'createWriteStream', className: 'WriteStream', resource: 'WriteStream' },
]
const streamEvents = ['close', 'end', 'finish', errorMonitor]

/**
 * @param {() => unknown} callback
 * @returns {Error & { code?: string }}
 */
function getThrownError (callback) {
  let thrownError

  /**
   * @param {Error & { code?: string }} error
   * @returns {true}
   */
  function capture (error) {
    thrownError = error
    return true
  }

  assert.throws(callback, capture)
  return thrownError
}

describe('fs instrumentation', () => {
  afterEach(() => {
    return agent.close()
  })

  it('require node:fs should work', async () => {
    await agent.load('node:fs', undefined, { flushInterval: 1 })
    const fs = require('node:fs')
    assert.notStrictEqual(fs, undefined)
  })

  it('require fs should work', async () => {
    await agent.load('fs', undefined, { flushInterval: 1 })
    const fs = require('fs')
    assert.notStrictEqual(fs, undefined)
  })

  describe('stream constructors', () => {
    let fs, tracer

    beforeEach(async () => {
      tracer = await agent.load('fs', undefined, { flushInterval: 1 })
      tracer.use('fs', { enabled: true })
      fs = require('node:fs')
    })

    for (const { methodName, className, resource } of streamConstructors) {
      describe(methodName, () => {
        it('preserves invalid path errors', () => {
          const expectedError = getThrownError(() => Reflect.construct(fs[className], [null]))
          const activeSpan = tracer.scope().active()

          assert.throws(() => fs[methodName](null), {
            name: expectedError.name,
            code: expectedError.code,
            message: expectedError.message,
          })

          assert.strictEqual(tracer.scope().active(), activeSpan)
        })

        it('rethrows the original constructor error without retaining tracing state or listeners', async () => {
          const originalConstructor = fs[className]
          const expectedError = getThrownError(() => Reflect.construct(originalConstructor, [null]))
          let failedStream

          fs[className] = class extends EventEmitter {
            constructor () {
              super()
              failedStream = this
              throw expectedError
            }
          }

          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat().filter(span => span.name === 'fs.operation' && span.resource === resource)
            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].error, 0)
          })
          const activeSpan = tracer.scope().active()
          let publishedError

          /**
           * @param {{ operation: string, error?: Error }} ctx
           */
          function onError (ctx) {
            if (ctx.operation === resource) publishedError = ctx.error
          }

          opErrorCh.subscribe(onError)
          try {
            tracer.trace('parent', parentSpan => {
              const actualError = getThrownError(() => fs[methodName](null))

              assert.strictEqual(actualError, expectedError)
              assert.strictEqual(tracer.scope().active(), parentSpan)
            })
          } finally {
            opErrorCh.unsubscribe(onError)
            fs[className] = originalConstructor
          }

          assert.strictEqual(publishedError, expectedError)
          assert.strictEqual(tracer.scope().active(), activeSpan)
          for (const event of streamEvents) {
            assert.strictEqual(failedStream.listenerCount(event), 0)
          }
          await tracePromise
        })

        it('returns a valid stream and removes its tracing listeners after completion', async () => {
          const directory = methodName === 'createWriteStream'
            ? fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fs-stream-'))
            : undefined
          const filename = directory ? path.join(directory, 'output') : __filename
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat().filter(span => span.name === 'fs.operation' && span.resource === resource)
            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].error, 0)
            assert.strictEqual(spans[0].meta['file.path'], filename)
          })
          const activeSpan = tracer.scope().active()

          const streamPromise = tracer.trace('parent', async parentSpan => {
            const stream = fs[methodName](filename)
            const closePromise = once(stream, 'close')

            assert.ok(stream instanceof fs[className])
            if (methodName === 'createReadStream') {
              stream.resume()
            } else {
              stream.end('test')
            }
            await closePromise

            assert.strictEqual(tracer.scope().active(), parentSpan)
            for (const event of streamEvents) {
              assert.strictEqual(stream.listenerCount(event), 0)
            }
          })

          try {
            await Promise.all([streamPromise, tracePromise])
            assert.strictEqual(tracer.scope().active(), activeSpan)
          } finally {
            if (directory) fs.rmSync(directory, { recursive: true })
          }
        })
      })
    }
  })

  // Node 20 defines `fs.opendir` / `fs.opendirSync` as lazy accessor properties.
  // The instrumentation has to wrap the resolved method, not the accessor, so the
  // start channel publishes the method's own operation and path. Activating the
  // hook before the accessor is first read reproduces the order that broke: a
  // wrapped getter leaves the real call uninstrumented.
  describe('lazily defined methods', () => {
    let fs, dirname, lazyAccessorShape

    before(async () => {
      // Capture the pristine descriptor shape before the hook wraps `fs`: on Node
      // versions that define `opendir` as a lazy getter+setter accessor we assert
      // the wrap preserves that shape; on versions where it is already a data
      // property there is no accessor to preserve.
      lazyAccessorShape = typeof Object.getOwnPropertyDescriptor(require('fs'), 'opendir')?.get === 'function'

      await agent.load('fs', undefined, { flushInterval: 1 })
      fs = require('fs')
      dirname = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fs-opendir-'))
    })

    after(() => {
      fs.rmdirSync(dirname)
    })

    it('instruments opendirSync while preserving its descriptor shape', () => {
      // On Node 20 `opendirSync` is a lazy getter+setter accessor; the wrap must
      // keep it an accessor pair (a downstream consumer may inspect the descriptor
      // or assign to it on that version), not flatten it to a data property.
      const descriptor = Object.getOwnPropertyDescriptor(fs, 'opendirSync')
      if (lazyAccessorShape) {
        assert.strictEqual(typeof descriptor.get, 'function', 'opendirSync getter must be preserved')
        assert.strictEqual(typeof descriptor.set, 'function', 'opendirSync setter must be preserved')
      }

      const operations = []
      const onStart = (ctx) => operations.push({ operation: ctx.operation, path: ctx.path })

      opStartCh.subscribe(onStart)
      try {
        fs.opendirSync(dirname).closeSync()
      } finally {
        opStartCh.unsubscribe(onStart)
      }

      assert.ok(
        operations.some(({ operation, path: opPath }) => operation === 'opendirSync' && opPath === dirname),
        `Expected an opendirSync start for ${dirname}, got ${JSON.stringify(operations)}`
      )
    })

    it('instruments opendir while preserving its descriptor shape', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(fs, 'opendir')
      if (lazyAccessorShape) {
        assert.strictEqual(typeof descriptor.get, 'function', 'opendir getter must be preserved')
        assert.strictEqual(typeof descriptor.set, 'function', 'opendir setter must be preserved')
      }

      const operations = []
      const onStart = (ctx) => operations.push({ operation: ctx.operation, path: ctx.path })

      opStartCh.subscribe(onStart)
      try {
        const dir = await new Promise((resolve, reject) => {
          fs.opendir(dirname, (error, openedDir) => error ? reject(error) : resolve(openedDir))
        })
        dir.closeSync()
      } finally {
        opStartCh.unsubscribe(onStart)
      }

      assert.ok(
        operations.some(({ operation, path: opPath }) => operation === 'opendir' && opPath === dirname),
        `Expected an opendir start for ${dirname}, got ${JSON.stringify(operations)}`
      )
    })
  })
})
