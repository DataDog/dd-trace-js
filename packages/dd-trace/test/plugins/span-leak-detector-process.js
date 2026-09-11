'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { it } = require('mocha')

const mochaConfig = require('../../../../.mocharc')

const root = path.resolve(__dirname, '../../../..')
const mocha = path.join(root, 'node_modules/mocha/bin/mocha.js')
const mochaRunFile = path.join(root, 'scripts/mocha-run-file.js')
const runners = ['Mocha CLI', 'mocha-run-file']

/**
 * @param {string} runner
 * @param {string} fixture
 * @returns {string[]}
 */
function getRunnerArgs (runner, fixture) {
  if (runner === 'Mocha CLI') return [mocha, fixture, '--reporter', 'dot']
  return [mochaRunFile, fixture]
}

/**
 * @param {boolean} retainSpan
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runFixture (retainSpan, args) {
  const env = { ...process.env }
  env.MOCHA_RUN_FILE_CONFIG = JSON.stringify({ ...mochaConfig, reporter: 'dot' })
  if (retainSpan) {
    env.DD_TEST_RETAIN_FINISHED_SPAN = '1'
  } else {
    delete env.DD_TEST_RETAIN_FINISHED_SPAN
  }

  return spawnSync(process.execPath, ['--expose-gc', ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 10_000,
  })
}

/**
 * @param {string} name
 * @param {string} fixture
 * @param {RegExp} retainedSpanPattern
 */
function testSpanLeakFixture (name, fixture, retainedSpanPattern) {
  for (const runner of runners) {
    const args = getRunnerArgs(runner, fixture)

    it(`allows ${name} to release its finished span with ${runner}`, () => {
      const result = runFixture(false, args)

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.status, 0, result.stdout + result.stderr)
    })

    it(`detects ${name} with ${runner}`, () => {
      const result = runFixture(true, args)
      const output = result.stdout + result.stderr

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.status, 1, output)
      assert.match(output, /1 of 1 finished integration spans were still reachable/)
      assert.match(output, retainedSpanPattern)
    })
  }
}

module.exports = { testSpanLeakFixture }
