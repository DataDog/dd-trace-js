'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

const fixture = require.resolve('./fixtures/dc-polyfill-coexistence')
const vendored = require.resolve('../../../../vendor/dist/dc-polyfill')
const userCopies = {
  direct: require.resolve('dc-polyfill'),
  transitive: require.resolve('../../../../vendor/node_modules/dc-polyfill'),
}

describe('vendored dc-polyfill', () => {
  for (const [dependencyType, userCopy] of Object.entries(userCopies)) {
    for (const [first, second] of [[vendored, userCopy], [userCopy, vendored]]) {
      const order = first === vendored ? 'before' : 'after'

      it(`coexists when loaded ${order} a user ${dependencyType} dependency`, () => {
        const result = spawnSync(process.execPath, [fixture, first, second], { encoding: 'utf8' })

        assert.equal(result.status, 0, result.stderr)
      })
    }
  }
})
