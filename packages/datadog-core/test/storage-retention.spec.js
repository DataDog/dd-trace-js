'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

// These regressions exercise Node's async_hooks backend and V8 VM collection.
const describeNode = process.versions.bun ? describe.skip : describe

const flags = [[]]
if (process.allowedNodeEnvironmentFlags.has('--no-async-context-frame')) {
  flags.push(['--no-async-context-frame'])
}

for (const args of flags) {
  describeNode(`storage retention (${args.join(' ') || 'default backend'})`, () => {
    for (const mode of ['import', 'namespace']) {
      it(`should release VM contexts after ${mode}`, () => {
        const result = spawnSync(process.execPath, [
          '--expose-gc', ...args, require.resolve('./fixtures/storage-retention'), mode,
        ], {
          encoding: 'utf8',
          // V8 coverage retains VM functions, interfering with the collection assertion.
          env: { ...process.env, NODE_V8_COVERAGE: '' },
        })
        assert.ifError(result.error)
        assert.strictEqual(result.status, 0, result.stderr || result.stdout)
      })
    }
  })
}
