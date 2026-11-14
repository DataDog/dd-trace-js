'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const tracing = require('../../src/config/remote_config')
const profiling = require('../../src/profiling/remote-config')

describe('Remote config product composition', () => {
  let config
  let handlers
  let updateConfig

  beforeEach(() => {
    updateConfig = sinon.spy()
    const getConfig = proxyquire('../../src/config', {
      '../telemetry': { updateConfig },
    })
    config = getConfig({ profiling: false, sampleRate: 0.25 })
    handlers = new Map()
    const rc = {
      updateCapabilities () {},
      subscribeProducts () {},
      /**
       * @param {string[]} products
       * @param {Parameters<import('../../src/remote_config')['setBatchHandler']>[1]} handler
       */
      setBatchHandler (products, handler) {
        handlers.set(products[0], handler)
      },
    }
    tracing.enable(rc, config, () => {})
    profiling.enable(rc, config, () => ['wall', 'cpu', 'space'])
  })

  /**
   * @param {'APM_TRACING' | 'APM_PROFILING'} product
   * @param {object | null} file
   */
  function update (product, file) {
    const item = { id: product, product, path: `datadog/2/${product}/config`, file }
    const handler = handlers.get(product)
    handler({
      toApply: file === null ? [] : [item],
      toModify: [],
      toUnapply: file === null ? [item] : [],
      ack () {},
      /**
       * @param {string} path
       * @param {string} reason
       */
      error (path, reason) {
        assert.fail(`${path}: ${reason}`)
      },
    })
  }

  for (const product of ['APM_TRACING', 'APM_PROFILING']) {
    it(`keeps local settings when removing ${product} before any product arrives`, () => {
      update(product, null)

      assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'false')
      assert.strictEqual(config.getOrigin('profiling.DD_PROFILING_ENABLED'), 'code')
      assert.strictEqual(config.sampleRate, 0.25)
    })

    it(`replaces and removes ${product} as the only product`, () => {
      const files = {
        APM_TRACING: [
          { sdk_config: { config: { DD_PROFILING_ENABLED: 'true', DD_PROFILING_HEAP_ENABLED: 'true' } } },
          { sdk_config: { config: { DD_EXPERIMENTAL_PROFILING_ENABLED: 'true' } } },
        ],
        APM_PROFILING: [
          { profilers: { heapSize: true } },
          { profilers: { wallTime: true } },
        ],
      }

      update(product, files[product][0])
      assert.strictEqual(config.DD_PROFILING_HEAP_ENABLED, true)
      assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

      update(product, files[product][1])
      assert.strictEqual(config.DD_PROFILING_HEAP_ENABLED, undefined)
      assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

      update(product, null)
      assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'false')
      assert.strictEqual(config.getOrigin('profiling.DD_PROFILING_ENABLED'), 'code')
    })
  }

  for (const first of ['APM_TRACING', 'APM_PROFILING']) {
    for (const removed of ['APM_TRACING', 'APM_PROFILING']) {
      it(`preserves the remaining product when removing ${removed} after ${first} arrives first`, () => {
        const files = {
          APM_TRACING: { sdk_config: { config: { DD_PROFILING_ENABLED: 'false', DD_TRACE_SAMPLE_RATE: '0.5' } } },
          APM_PROFILING: { profilers: { wallTime: true } },
        }
        const second = first === 'APM_TRACING' ? 'APM_PROFILING' : 'APM_TRACING'
        update(first, files[first])
        update(second, files[second])
        assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, second === 'APM_PROFILING' ? 'true' : 'false')

        update(removed, null)

        const remaining = removed === 'APM_TRACING' ? 'APM_PROFILING' : 'APM_TRACING'
        assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, remaining === 'APM_PROFILING' ? 'true' : 'false')
        assert.strictEqual(config.getOrigin('profiling.DD_PROFILING_ENABLED'), 'remote_config')
        assert.strictEqual(config.sampleRate, remaining === 'APM_TRACING' ? 0.5 : 0.25)

        update(remaining, null)

        assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'false')
        assert.strictEqual(config.getOrigin('profiling.DD_PROFILING_ENABLED'), 'code')
        assert.strictEqual(config.sampleRate, 0.25)
      })
    }
  }

  it('restores only omitted fields when replacing a product', () => {
    update('APM_TRACING', {
      sdk_config: { config: { DD_TRACE_SAMPLE_RATE: '0.5', DD_PROFILING_HEAP_ENABLED: 'true' } },
    })
    update('APM_PROFILING', { profilers: { wallTime: true } })

    update('APM_TRACING', { sdk_config: { config: { DD_TRACE_SAMPLE_RATE: '0.75' } } })

    assert.strictEqual(config.DD_PROFILING_HEAP_ENABLED, undefined)
    assert.strictEqual(config.DD_PROFILING_WALLTIME_ENABLED, true)
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')
    assert.strictEqual(config.sampleRate, 0.75)
  })

  it('resolves aliases before merging products and restores the surviving alias', () => {
    update('APM_TRACING', { sdk_config: { config: { DD_EXPERIMENTAL_PROFILING_ENABLED: 'false' } } })
    update('APM_PROFILING', { profilers: { wallTime: true } })
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

    update('APM_TRACING', { sdk_config: { config: { DD_EXPERIMENTAL_PROFILING_ENABLED: 'false' } } })
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'false')

    update('APM_TRACING', null)
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

    const entries = updateConfig.lastCall.args[0]
    const latest = entries.filter(entry => entry.name === 'DD_PROFILING_ENABLED')
      .reduce((previous, entry) => previous.seq_id > entry.seq_id ? previous : entry)
    assert.strictEqual(latest.origin, 'remote_config')
    assert.strictEqual(latest.value, 'true')
  })

  it('restores a tracing setting omitted by the replacement profiling payload', () => {
    update('APM_TRACING', { sdk_config: { config: { DD_PROFILING_WALLTIME_ENABLED: 'false' } } })
    update('APM_PROFILING', { profilers: { wallTime: true } })
    assert.strictEqual(config.DD_PROFILING_WALLTIME_ENABLED, true)

    update('APM_PROFILING', { profilers: { heapSize: true } })

    assert.strictEqual(config.DD_PROFILING_WALLTIME_ENABLED, false)
    assert.strictEqual(config.getOrigin('DD_PROFILING_WALLTIME_ENABLED'), 'remote_config')
    assert.strictEqual(config.DD_PROFILING_HEAP_ENABLED, true)
  })

  it('resolves aliases when products overlap again after a single-product update', () => {
    update('APM_TRACING', { sdk_config: { config: { DD_EXPERIMENTAL_PROFILING_ENABLED: 'false' } } })
    update('APM_PROFILING', { profilers: { wallTime: true } })
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

    update('APM_PROFILING', null)
    update('APM_TRACING', { sdk_config: { config: { DD_EXPERIMENTAL_PROFILING_ENABLED: 'true' } } })
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')

    update('APM_PROFILING', {
      profilers: { wallTime: false, cpuTime: false, heapSize: false, heapObjects: false, allocations: false },
    })
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'false')

    update('APM_PROFILING', null)
    assert.strictEqual(config.profiling.DD_PROFILING_ENABLED, 'true')
  })
})
