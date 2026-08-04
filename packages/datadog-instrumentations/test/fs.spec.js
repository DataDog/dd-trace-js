'use strict'

const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const { describe, it, after, afterEach, before } = require('mocha')

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')

const opStartCh = dc.channel('apm:fs:operation:start')

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
