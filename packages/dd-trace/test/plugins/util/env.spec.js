'use strict'

const assert = require('node:assert/strict')
const os = require('os')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const log = require('../../../src/log')
const {
  getRuntimeAndOSMetadata,
  OS_ARCHITECTURE,
  OS_PLATFORM,
  OS_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  DD_HOST_CPU_COUNT,
} = require('../../../src/plugins/util/env')

const detectedMetadata = {
  [RUNTIME_VERSION]: process.version,
  [OS_ARCHITECTURE]: process.arch,
  [OS_PLATFORM]: process.platform,
  [RUNTIME_NAME]: 'node',
  [OS_VERSION]: os.release(),
  [DD_HOST_CPU_COUNT]: os.cpus().length,
}

describe('env', () => {
  let originalRuntimeTags

  beforeEach(() => {
    originalRuntimeTags = process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS
    delete process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS
  })

  afterEach(() => {
    if (originalRuntimeTags === undefined) {
      delete process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS
    } else {
      process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS = originalRuntimeTags
    }
  })

  it('reads runtime and OS metadata', () => {
    assert.deepStrictEqual(getRuntimeAndOSMetadata(), detectedMetadata)
  })

  describe('DD_TEST_OPTIMIZATION_RUNTIME_TAGS', () => {
    beforeEach(() => {
      sinon.stub(log, 'warn')
    })

    afterEach(() => {
      sinon.restore()
    })

    it('overrides every supported tag', () => {
      const overrides = {
        [OS_PLATFORM]: 'linux',
        [OS_ARCHITECTURE]: 'x64',
        [OS_VERSION]: '6.12.0',
        [RUNTIME_NAME]: 'bun',
        [RUNTIME_VERSION]: 'v22.0.0',
      }
      process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS = JSON.stringify(overrides)

      assert.deepStrictEqual(getRuntimeAndOSMetadata(), { ...detectedMetadata, ...overrides })
    })

    it('trims values, keeps detected tags that are not overridden and ignores other keys and values', () => {
      process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS = JSON.stringify({
        [OS_VERSION]: ' 6.12.0 ',
        [RUNTIME_VERSION]: '  ',
        [OS_PLATFORM]: null,
        [OS_ARCHITECTURE]: 64,
        [DD_HOST_CPU_COUNT]: '1',
        'runtime.vendor': 'ignored',
      })

      assert.deepStrictEqual(getRuntimeAndOSMetadata(), { ...detectedMetadata, [OS_VERSION]: '6.12.0' })
      sinon.assert.notCalled(log.warn)
    })

    it('sets no override for an empty value', () => {
      process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS = '  '

      assert.deepStrictEqual(getRuntimeAndOSMetadata(), detectedMetadata)
      sinon.assert.notCalled(log.warn)
    })

    for (const value of ['{invalid json}', '["os.version"]', '"6.12.0"', 'null']) {
      it(`logs a warning and reports detected tags for ${value}`, () => {
        process.env.DD_TEST_OPTIMIZATION_RUNTIME_TAGS = value

        assert.deepStrictEqual(getRuntimeAndOSMetadata(), detectedMetadata)
        sinon.assert.calledOnceWithMatch(log.warn, sinon.match('DD_TEST_OPTIMIZATION_RUNTIME_TAGS'), value)
      })
    }
  })
})
