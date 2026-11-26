'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const Module = require('node:module')

const { describe, it, before, beforeEach, afterEach } = require('mocha')
const satisfies = require('semifies')

const { sandboxCwd, useSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { TEST_NAME, TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')
const { getLatestMochaSpecifier, oldest: oldestMochaVersion } = require('./versions')

const requestedMochaVersion = process.env.MOCHA_VERSION || 'latest'
const MOCHA_VERSION = requestedMochaVersion === 'oldest' ? oldestMochaVersion : requestedMochaVersion
const mochaDependencyVersion = MOCHA_VERSION === 'latest' ? getLatestMochaSpecifier() : MOCHA_VERSION

const SUMMARY_TIMEOUT_MS = 30_000

// Mocha loads test files as ECMAScript modules from 9. Node.js runs module hooks in the thread that loads
// modules from 22.15 and 23.5, and loads ECMAScript modules as they are before, and where those hooks reject the
// null source of CommonJS modules (before 22.22.3, 24.11.1 and 25.1.0).
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const hasModuleHooks = typeof Module.registerHooks === 'function' &&
  require('import-in-the-middle/supports-sync-hooks.mjs').supportsSyncHooks()
const esModuleIt = hasModuleHooks && (MOCHA_VERSION === 'latest' || satisfies(MOCHA_VERSION, '>=9.0.0'))
  ? it
  : it.skip

/**
 * @param {{ filename: string, bitmap?: Uint8Array }[]} files
 * @param {string} filename
 * @returns {Set<number>}
 */
function getLines (files, filename) {
  const lines = new Set()
  const bitmap = files.find(file => file.filename === filename)?.bitmap
  for (const [index, byte] of (bitmap ?? []).entries()) {
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) lines.add(index * 8 + bit)
    }
  }
  return lines
}

describe(`mocha@${MOCHA_VERSION} per-test line coverage`, () => {
  let receiver
  let childProcess
  let cwd

  useSandbox([`mocha@${mochaDependencyVersion}`], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  esModuleIt('reports the lines each test ran in ECMAScript modules', async () => {
    const coverageRecords = []
    const testsByName = new Map()
    const coveragePromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcov',
      (payloads) => {
        coverageRecords.length = 0
        coverageRecords.push(...payloads
          .flatMap(({ payload }) => payload)
          .flatMap(({ content: { coverages } }) => coverages))
        assert.strictEqual(coverageRecords.filter(({ span_id: spanId }) => spanId !== undefined).length, 2)
      },
      SUMMARY_TIMEOUT_MS
    )
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        testsByName.clear()
        for (const { payload } of payloads) {
          for (const { type, content } of payload.events) {
            if (type === 'test') testsByName.set(content.meta[TEST_NAME], content)
          }
        }
        assert.strictEqual(testsByName.size, 2)
      },
      SUMMARY_TIMEOUT_MS
    )

    childProcess = exec('node node_modules/mocha/bin/mocha ci-visibility/line-coverage-esm/arithmetic.test.mjs', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_TEST_LINE_COVERAGE_ENABLED: '1',
      },
    })
    let testOutput = ''
    childProcess.stdout.on('data', chunk => { testOutput += chunk })
    childProcess.stderr.on('data', chunk => { testOutput += chunk })
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), coveragePromise, eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)

    const coverageOf = (name) => {
      const test = testsByName.get(`es module arithmetic ${name}`)
      assert.ok(test, `no test named ${name}`)
      assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      // The coverage payload is decoded without 64-bit integers, so ids lose their low digits there.
      const record = coverageRecords.find(({ span_id: spanId }) => String(spanId) === String(Number(test.span_id)))
      assert.ok(record, `no record for ${name}`)
      return record.files
    }
    const adds = coverageOf('adds')
    const multiplies = coverageOf('multiplies')
    const ARITHMETIC = 'ci-visibility/line-coverage-esm/arithmetic.mjs'
    const TESTS = 'ci-visibility/line-coverage-esm/arithmetic.test.mjs'
    // Each test ran its own body and the body of the function it calls, and not the other's.
    assert.ok(getLines(adds, TESTS).has(7))
    assert.ok(getLines(adds, ARITHMETIC).has(2))
    assert.ok(!getLines(adds, ARITHMETIC).has(6))
    assert.ok(getLines(multiplies, TESTS).has(11))
    assert.ok(getLines(multiplies, ARITHMETIC).has(6))
    assert.ok(!getLines(multiplies, ARITHMETIC).has(2))
  })
})
