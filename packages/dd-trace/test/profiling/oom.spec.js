'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')

require('../setup/core')
const {
  oomExportStrategies,
  ensureOOMExportStrategies,
  strategiesToCallbackMode,
  buildExportCommand,
} = require('../../src/profiling/oom')

const exporterCliPath = path.join(__dirname, '../../src/profiling', 'exporter_cli.js')

describe('profiling/oom', () => {
  it('exposes the canonical strategy names', () => {
    assert.deepStrictEqual(oomExportStrategies, { PROCESS: 'process', ASYNC_CALLBACK: 'async', LOGS: 'logs' })
  })

  describe('ensureOOMExportStrategies', () => {
    it('keeps recognized strategies and de-duplicates them', () => {
      assert.deepStrictEqual(ensureOOMExportStrategies(['process', 'async', 'process']), ['process', 'async'])
    })

    it('drops unrecognized strategies', () => {
      assert.deepStrictEqual(ensureOOMExportStrategies(['bogus', 'logs']), ['logs'])
    })

    it('returns an empty list when none are recognized', () => {
      assert.deepStrictEqual(ensureOOMExportStrategies(['nope']), [])
    })
  })

  describe('strategiesToCallbackMode', () => {
    const callbackMode = { Async: 7 }

    it('returns the async callback mode when the async strategy is present', () => {
      assert.strictEqual(strategiesToCallbackMode(['process', 'async'], callbackMode), 7)
    })

    it('returns 0 when the async strategy is absent', () => {
      assert.strictEqual(strategiesToCallbackMode(['process'], callbackMode), 0)
    })
  })

  describe('buildExportCommand', () => {
    it('collects each exporter URL and appends the OOM snapshot tag', () => {
      const exporters = [
        { getExportUrl: () => new URL('http://127.0.0.1:8126/') },
        { getExportUrl: () => new URL('file:///tmp/profile-') },
      ]

      const command = buildExportCommand(exporters, { service: 'svc' })

      assert.deepStrictEqual(command, [
        process.execPath,
        exporterCliPath,
        'http://127.0.0.1:8126/,file:///tmp/profile-',
        'service:svc,snapshot:on_oom',
        'space',
      ])
    })

    it('skips exporters that report no export URL', () => {
      const exporters = [
        { getExportUrl: () => undefined },
        { getExportUrl: () => new URL('http://127.0.0.1:8126/') },
      ]

      const command = buildExportCommand(exporters, {})

      assert.strictEqual(command[2], 'http://127.0.0.1:8126/')
      assert.strictEqual(command[3], 'snapshot:on_oom')
    })
  })
})
