'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const { sandboxCwd, useSandbox } = require('../helpers')

describe('OpenFeature worker with Yarn Plug\'n\'Play', () => {
  useSandbox([], false, ['./integration-tests/openfeature/app'],
    'yarn set version 4.9.2 --yarn-path && yarn install --mode=skip-build --no-immutable')

  it('delivers events without inheriting application preloads', async function () {
    this.timeout(15000)
    const cwd = sandboxCwd()
    // Ensure missing worker dependencies cannot fall back to a conventional installation.
    assert.strictEqual(existsSync(join(cwd, 'node_modules')), false)
    const resolver = join(cwd, '.pnp.cjs')
    assert.strictEqual(existsSync(resolver), true)
    const preload = join(cwd, 'app/worker-preload.js')
    // The coverage harness wraps execFile without preserving its custom promisify result shape.
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile(process.execPath, [
        '--require', preload, join(cwd, 'app/worker-pnp.js'),
      ], {
        cwd,
        timeout: 10000,
        // NODE_OPTIONS also parses backslashes as escapes, including Windows path separators.
        env: {
          ...process.env,
          NODE_OPTIONS: `--require ${JSON.stringify(resolver)} --require ${JSON.stringify(preload)}`,
        },
      }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      })
    })
    assert.strictEqual(stderr, '')
    const result = JSON.parse(stdout)
    assert.strictEqual(result.pnp, true)
    assert.strictEqual(result.event.evaluation_count, 1)
    assert.match(result.event.targeting_key, /^sha256_[a-f0-9]{64}$/)
    assert.strictEqual(result.event.context, undefined)
  })
})
