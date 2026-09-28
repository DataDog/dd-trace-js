'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

describe('RITM during loader registration', () => {
  const fixture = path.join(__dirname, 'ritm-tests/loader-registration.js')
  const variants = [[]]
  if (process.allowedNodeEnvironmentFlags.has('--no-experimental-require-module')) {
    variants.push(['--no-experimental-require-module'])
  }

  for (const flags of variants) {
    it(`keeps module-load events balanced with ${flags.join(' ') || 'default Node flags'}`, () => {
      const result = spawnSync(process.execPath, [...flags, fixture], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: '' },
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
    })
  }
})
