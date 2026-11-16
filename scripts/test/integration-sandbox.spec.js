'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

describe('integration sandbox self-link', function () {
  this.timeout(30_000)

  for (const flag of ['1', 'true']) {
    it(`runs without Yarn when TESTING_NO_INTEGRATION_SANDBOX=${flag}`, () => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-self-link-'))
      fs.symlinkSync(process.execPath, path.join(directory, 'node'))
      const selfLink = path.join(repoRoot, 'node_modules', 'dd-trace')
      const hadSelfLink = fs.existsSync(selfLink)
      const manifest = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
      const lock = fs.readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8')
      const spec = path.join(directory, 'self-link.spec.js')
      fs.writeFileSync(spec, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { useSandbox, sandboxCwd } = require(${JSON.stringify(path.join(repoRoot, 'integration-tests/helpers'))})
describe('self-link', function () {
  useSandbox()
  it('resolves the local tracer from the integration directory', function () {
    assert.strictEqual(sandboxCwd(), ${JSON.stringify(path.join(repoRoot, 'integration-tests'))})
    const fromIntegration = createRequire(sandboxCwd() + '/self-link.js')
    const resolved = fs.realpathSync(fromIntegration.resolve('dd-trace'))
    assert.strictEqual(resolved, ${JSON.stringify(path.join(repoRoot, 'index.js'))})
  })
})
`)

      try {
        const result = spawnSync(process.execPath, [
          path.join(repoRoot, 'node_modules/mocha/bin/mocha.js'), '--no-config', spec,
        ], {
          cwd: repoRoot,
          env: { ...process.env, PATH: directory, TESTING_NO_INTEGRATION_SANDBOX: flag },
          encoding: 'utf8',
        })
        assert.doesNotMatch(result.stdout + result.stderr, /yarn link/)
        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        assert.match(result.stdout, /1 passing/)
        assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'), manifest)
        assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8'), lock)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
        if (!hadSelfLink) fs.rmSync(selfLink, { force: true })
      }
    })
  }
})
