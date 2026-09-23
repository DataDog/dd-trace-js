'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const exec = promisify(execFile)
const fixture = join(__dirname, 'fixtures/worker-app.js')
const preload = join(__dirname, 'fixtures/worker-preload.js')

describe('flag evaluation flush retention', () => {
  for (const mode of ['keys', 'entries']) {
    it(`releases unnecessary ${mode} while a multi-payload flush is paused`, async function () {
      this.timeout(10000)
      const fixture = join(__dirname, 'fixtures/payload-retention.js')
      const { stdout, stderr } = await exec(process.execPath, ['--expose-gc', fixture, mode], { timeout: 7000 })
      assert.strictEqual(stdout, '')
      assert.strictEqual(stderr, '')
    })
  }
})

describe('flag evaluation real worker processes', () => {
  for (const mode of ['progress', 'fallback', 'unix', 'nested']) {
    it(`delivers protected and full counts under continuous evaluation (${mode})`, async function () {
      this.timeout(15000)
      const { stdout, stderr } = await exec(process.execPath, [fixture, mode], { timeout: 10000 })
      assert.strictEqual(stderr, '')
      const result = JSON.parse(stdout)
      assert.strictEqual(result.accepted, 12000)
      assert.strictEqual(result.delivered, 12001)
      const rows = result.bodies.flatMap(({ body }) => body.flagEvaluations)
      const protectedRow = rows.find(row => row.flag.key === 'protected')
      assert.strictEqual(protectedRow.evaluation_count, 6000)
      assert.match(protectedRow.targeting_key, /^sha256_/)
      assert.strictEqual(protectedRow.context, undefined)
      assert.deepStrictEqual(protectedRow.error, { message: 'GENERAL' })
      const full = rows.find(row => row.flag.key === 'full')
      assert.strictEqual(full.evaluation_count, 6000)
      assert.strictEqual(full.targeting_key, 'full-target-canary')
      assert.deepStrictEqual(full.context, { evaluation: { plan: 'context-canary' } })
      const raw = result.bodies.map(body => body.raw).join('')
      assert.strictEqual(raw.includes('protected-target-canary'), false)
      assert.strictEqual(raw.includes('error-canary'), false)
      assert.strictEqual(result.metrics.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
        metric.tags.includes('reason:serialization_error')).points[0][1], 1)
      if (mode === 'fallback') {
        assert.strictEqual(result.fallbackRequests, 1)
        assert.ok(result.bodies.every(body => body.headers['dd-api-key'] === 'test-key'))
      }
    })
  }

  it('does not keep an idle application alive', async function () {
    this.timeout(10000)
    const { stdout, stderr } = await exec(process.execPath, [fixture, 'idle'], { timeout: 7000 })
    assert.strictEqual(stderr, '')
    assert.strictEqual(JSON.parse(stdout).accepted, 0)
  })

  it('preserves a maximum-sized captured context across full batch boundaries', async function () {
    this.timeout(10000)
    const { stdout, stderr } = await exec(process.execPath, [fixture, 'max-context'], {
      timeout: 7000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.strictEqual(stderr, '')
    const result = JSON.parse(stdout)
    assert.strictEqual(result.accepted, 16)
    assert.strictEqual(result.delivered, 17)
    const rows = result.bodies.flatMap(({ body }) => body.flagEvaluations)
    const full = rows.find(row => row.flag.key === 'full')
    assert.strictEqual(full.evaluation_count, 8)
    const entries = full.context.evaluation
    assert.strictEqual(entries.length, 256)
    assert.ok(entries.every(([keyLength, valueLength]) => keyLength === 256 && valueLength === 256))
    assert.strictEqual(rows.find(row => row.flag.key === 'protected').context, undefined)
  })

  it('terminates a real blocked delivery after the graceful shutdown deadline', async function () {
    this.timeout(12000)
    const { stdout, stderr } = await exec(process.execPath, [fixture, 'timeout'], { timeout: 9000 })
    assert.strictEqual(stderr, '')
    const result = JSON.parse(stdout)
    assert.strictEqual(result.accepted, 8)
    assert.strictEqual(result.delivered, 1)
    const dropped = result.metrics.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
      metric.tags.includes('reason:shutdown_timeout'))
    assert.strictEqual(dropped.points[0][1], 8)
  })

  /** @type {Array<[string, number]>} */
  const failureCases = [['startup-failure', 1], ['runtime-failure', 8]]
  for (const [mode, expected] of failureCases) {
    it(`contains real worker errors and counts abandoned work (${mode})`, async function () {
      this.timeout(10000)
      const { stdout, stderr } = await exec(process.execPath, [fixture, mode], { timeout: 7000 })
      assert.strictEqual(stderr, '')
      const result = JSON.parse(stdout)
      assert.strictEqual(result.accepted, expected)
      const dropped = result.metrics.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
        metric.tags.includes('reason:worker_failure'))
      assert.strictEqual(dropped.points[0][1], expected)
    })
  }

  it('does not inherit application command-line or NODE_OPTIONS preloads', async function () {
    this.timeout(15000)
    const { stdout, stderr } = await exec(process.execPath, ['--require', preload, fixture, 'progress'], {
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--require ' + preload },
    })
    assert.strictEqual(stderr, '')
    assert.strictEqual(JSON.parse(stdout).delivered, 12001)
  })
})
