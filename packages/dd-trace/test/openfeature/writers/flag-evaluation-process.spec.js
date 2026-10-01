'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const exec = promisify(execFile)
const fixture = join(__dirname, 'fixtures/worker-app.js')
const preload = join(__dirname, 'fixtures/worker-preload.js')

describe('flag evaluation flush retention', () => {
  it('releases lookup keys and encoded entries while a multi-payload flush is paused', async function () {
    this.timeout(10000)
    const fixture = join(__dirname, 'fixtures/payload-retention.js')
    const { stdout, stderr } = await exec(process.execPath, ['--expose-gc', fixture], { timeout: 7000 })
    assert.strictEqual(stdout, '')
    assert.strictEqual(stderr, '')
  })
})

describe('flag evaluation real worker processes', () => {
  for (const mode of ['progress', 'fallback', 'unix', 'nested']) {
    it(`delivers protected and full counts (${mode})`, async function () {
      this.timeout(15000)
      const { stdout, stderr } = await exec(process.execPath, [fixture, mode], { timeout: 10000 })
      assert.strictEqual(stderr, '')
      const result = JSON.parse(stdout)
      const expected = mode === 'progress' ? 12000 : 16
      assert.strictEqual(result.accepted, expected)
      assert.strictEqual(result.delivered, expected + 1)
      const rows = result.bodies.flatMap(({ body }) => body.flagEvaluations)
      const protectedRow = rows.find(row => row.flag.key === 'protected')
      assert.strictEqual(protectedRow.evaluation_count, expected / 2)
      assert.match(protectedRow.targeting_key, /^sha256_/)
      assert.strictEqual(protectedRow.context, undefined)
      assert.deepStrictEqual(protectedRow.error, { message: 'GENERAL' })
      const full = rows.find(row => row.flag.key === 'full')
      assert.strictEqual(full.evaluation_count, expected / 2)
      assert.strictEqual(full.targeting_key, 'full-target-canary')
      assert.deepStrictEqual(full.context, { evaluation: { plan: 'context-canary' } })
      const raw = result.bodies.map(body => body.raw).join('')
      assert.strictEqual(raw.includes('protected-target-canary'), false)
      assert.strictEqual(raw.includes('error-canary'), false)
      assert.strictEqual(result.metrics.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
        metric.tags.includes('reason:serialization_error')).points[0][1], 1)
      if (mode === 'fallback') {
        assert.strictEqual(result.fallbackRequests, 1)
        assert.strictEqual(result.fallbackTransitions, 1)
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

  for (const source of ['command line', 'NODE_OPTIONS', 'both']) {
    it(`preserves worker permissions from ${source} while delivering events`, async function () {
      this.timeout(15000)
      const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
        ? '--permission'
        : '--experimental-permission'
      if (!process.allowedNodeEnvironmentFlags.has(permissionFlag)) this.skip()
      const root = realpathSync(join(__dirname, '../../../../..'))
      const permissions = [permissionFlag, '--allow-worker', '--allow-fs-read', root]
      if (process.allowedNodeEnvironmentFlags.has('--allow-net')) permissions.push('--allow-net')
      // A space and an escaped quote exercise NODE_OPTIONS parsing without creating or reading a file.
      const allowed = join(tmpdir(), 'ffe allowed "path"')
      const extraPermission = '--allow-fs-read=' + allowed
      const args = source === 'NODE_OPTIONS' ? [] : [...permissions, extraPermission]
      const options = source === 'command line' ? [] : [...permissions, extraPermission]
      if (source === 'both') {
        // Split grants across sources; the command line must still override an environment grant.
        options.push('--allow-child-process')
        args.splice(0, args.length, '--no-allow-child-process')
      }
      const nodeOptions = [...options, '--require', preload].map(arg => JSON.stringify(arg)).join(' ')
      // CI's node-preload hook re-injects coverage after exec receives its env. Its process.binding
      // call is forbidden in permission mode, so opt out only this subprocess, after that hook runs.
      // eslint-disable-next-line n/no-extraneous-require -- Only use node-preload's already-loaded spawn hook.
      const spawnHooks = require.cache[require.resolve('process-on-spawn')]?.exports
      /** @param {{ args: string[], env: Record<string, string | undefined> }} spawned */
      const withoutCoverage = ({ args, env }) => {
        if (args.includes(fixture) && args.includes('permissions')) {
          env.NODE_OPTIONS = nodeOptions
          env.NODE_V8_COVERAGE = ''
        }
      }
      let output
      spawnHooks?.addListener(withoutCoverage)
      try {
        output = await exec(process.execPath, [
          ...args, '--require', preload, fixture, 'permissions', allowed,
        ], {
          timeout: 10000,
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            NODE_V8_COVERAGE: '',
          },
        })
      } finally {
        spawnHooks?.removeListener(withoutCoverage)
      }
      const result = JSON.parse(output.stdout)
      assert.strictEqual(result.accepted, 16)
      assert.strictEqual(result.delivered, 17)
      assert.ok(result.bodies.flatMap(({ body }) => body.flagEvaluations)
        .some(row => row.flag.key === 'protected' && /^sha256_/.test(row.targeting_key)))
    })
  }

  for (const source of ['command line', 'NODE_OPTIONS', 'both']) {
    it(`preserves worker network options from ${source} without application preloads`, async function () {
      this.timeout(15000)
      const networkArgs = ['--dns-result-order', 'ipv4first']
      const overridden = ['--dns-result-order=verbatim']
      if (process.allowedNodeEnvironmentFlags.has('--network-family-autoselection')) {
        networkArgs.push('--no-network-family-autoselection')
        overridden.push('--network-family-autoselection')
      }
      if (process.allowedNodeEnvironmentFlags.has('--network-family-autoselection-attempt-timeout')) {
        networkArgs.push('--network-family-autoselection-attempt-timeout', '123')
        overridden.push('--network-family-autoselection-attempt-timeout=321')
      }
      const args = source === 'NODE_OPTIONS' ? [] : networkArgs
      const options = source === 'command line' ? [] : source === 'both' ? overridden : networkArgs
      const { stdout, stderr } = await exec(process.execPath, [
        ...args, '--require', preload, fixture, 'network-options',
      ], {
        timeout: 10000,
        env: {
          ...process.env,
          NODE_OPTIONS: [...options, '--require', preload].map(arg => JSON.stringify(arg)).join(' '),
        },
      })
      assert.strictEqual(stderr, '')
      assert.strictEqual(JSON.parse(stdout).delivered, 17)
    })
  }

  for (const version of ['1.2', '1.3']) {
    for (const source of ['command line', 'NODE_OPTIONS', 'both']) {
      it(`preserves TLS ${version} bounds from ${source} without application preloads`, async function () {
        this.timeout(15000)
        const minimum = `--tls-min-v${version}`
        const maximum = `--tls-max-v${version}`
        const args = source === 'NODE_OPTIONS' ? [] : source === 'both' ? [maximum] : [minimum, maximum]
        const options = source === 'command line' ? [] : source === 'both' ? [minimum] : [minimum, maximum]
        const { stdout, stderr } = await exec(process.execPath, [
          ...args, '--require', preload, fixture, 'tls-options', `TLSv${version}`,
        ], {
          timeout: 10000,
          env: {
            ...process.env,
            NODE_OPTIONS: [...options, '--require', preload].map(arg => JSON.stringify(arg)).join(' '),
          },
        })
        assert.strictEqual(stderr, '')
        assert.strictEqual(JSON.parse(stdout).delivered, 17)
      })
    }
  }

  for (const limit of [8192, 32768]) {
    for (const source of ['command line', 'NODE_OPTIONS', 'both']) {
      it(`preserves HTTP header limit ${limit} from ${source} without application preloads`, async function () {
        this.timeout(15000)
        const args = source === 'NODE_OPTIONS' ? [] : ['--max-http-header-size', String(limit)]
        const options = source === 'command line' ? [] : [`--max-http-header-size=${source === 'both' ? 4096 : limit}`]
        const { stdout, stderr } = await exec(process.execPath, [
          ...args, '--require', preload, fixture, 'http-header-limit', String(limit),
        ], {
          timeout: 10000,
          env: {
            ...process.env,
            NODE_OPTIONS: [...options, '--require', preload].map(arg => JSON.stringify(arg)).join(' '),
          },
        })
        assert.strictEqual(stderr, '')
        assert.strictEqual(JSON.parse(stdout).delivered, 17)
      })
    }
  }

  const parserEnabled = '--insecure-http-parser'
  const parserDisabled = '--no-insecure-http-parser'
  for (const [name, args, options, failures] of [
    ['default strict mode', [], [], 1],
    ['command line', [parserEnabled], [], 0],
    ['NODE_OPTIONS', [], [parserEnabled], 0],
    ['command line disables NODE_OPTIONS', [parserDisabled], [parserEnabled], 1],
    ['command line enables over NODE_OPTIONS', [parserEnabled], [parserDisabled], 0],
  ]) {
    it(`preserves HTTP parser mode (${name}) without application preloads`, async function () {
      this.timeout(10000)
      const { stdout } = await exec(process.execPath, [
        ...args, '--require', preload, join(__dirname, 'fixtures/http-parser.js'),
      ], {
        timeout: 7000,
        env: {
          ...process.env,
          NODE_OPTIONS: [...options, '--require', preload].map(arg => JSON.stringify(arg)).join(' '),
        },
      })
      assert.deepStrictEqual(JSON.parse(stdout), { requests: 1, failures })
    })
  }

  it('does not inherit application command-line or NODE_OPTIONS preloads', async function () {
    this.timeout(15000)
    const { stdout, stderr } = await exec(process.execPath, ['--require', preload, fixture, 'preload'], {
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--require ' + preload },
    })
    assert.strictEqual(stderr, '')
    assert.strictEqual(JSON.parse(stdout).delivered, 17)
  })
})
