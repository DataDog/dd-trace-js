'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { prepareMeta } = require('./squash-affinity')

describe('Sirun metadata preparation', () => {
  it('exposes GC while preserving Node options and runtime overrides', () => {
    const meta = {
      run: 'node index.js',
      run_with_affinity: 'taskset node index.js',
      operations_by_node: { 20: '100' },
      variants: {
        inherited: { env: {} },
        preload: { env: { NODE_OPTIONS: '--import register.js' } },
      },
    }

    prepareMeta(meta, {
      enableAffinity: true,
      nodeMajor: '20',
      nodeOptions: '--require preload.js',
    })
    prepareMeta(meta, { enableAffinity: true, nodeMajor: '20' })

    assert.strictEqual(meta.run, 'taskset node index.js')
    assert.strictEqual(meta.operations_by_node, undefined)
    assert.strictEqual(meta.env.OPERATIONS, '100')
    assert.strictEqual(meta.env.NODE_OPTIONS, '--require preload.js --expose-gc')
    assert.strictEqual(meta.variants.inherited.env.NODE_OPTIONS, undefined)
    assert.strictEqual(meta.variants.preload.env.NODE_OPTIONS, '--import register.js --expose-gc')
  })
})
