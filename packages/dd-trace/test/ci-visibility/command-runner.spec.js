'use strict'

const assert = require('node:assert/strict')

const {
  getCommandDetails,
  mergeNodeOptions,
  serializeDisplayCommand,
} = require('../../../../ci/test-optimization-validation/command-runner')

describe('test optimization validation command runner', () => {
  it('keeps project and validator NODE_OPTIONS together', () => {
    assert.strictEqual(
      mergeNodeOptions('--import ./src/dev-loader.js', '--import dd-trace/register.js -r dd-trace/ci/init'),
      '--import ./src/dev-loader.js --import dd-trace/register.js -r dd-trace/ci/init'
    )
  })

  it('collapses node and corepack runtime plumbing for display commands', () => {
    const command = {
      argv: [
        '/usr/bin/env',
        'PATH=/Users/example/.nvm/versions/node/v22.22.2/bin:/usr/bin',
        '/Users/example/.nvm/versions/node/v22.22.2/bin/node',
        '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/corepack/dist/corepack.js',
        'pnpm',
        'vitest',
        'run',
        'packages/zod/src/index.test.ts',
      ],
    }

    assert.strictEqual(
      serializeDisplayCommand(command),
      'pnpm vitest run packages/zod/src/index.test.ts'
    )
    assert.deepStrictEqual(getCommandDetails(command), {
      exactCommandCollapsed: true,
      pathAdjusted: true,
      runtimeWrapper: 'node/corepack',
      packageManager: 'pnpm',
    })
  })
})
