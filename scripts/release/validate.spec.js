'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const EMPTY_SHA = '0123456789abcdef0123456789abcdef01234567'
const VERSION_SHA = '89abcdef0123456789abcdef0123456789abcdef'

describe('release proposal validation', () => {
  it('preserves empty commits while reconstructing the proposal', () => {
    const fail = sinon.stub()
    const run = sinon.stub()

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('log --pretty=format:')) return `${VERSION_SHA}\n${EMPTY_SHA}`
      if (command.includes('--format=sha --reverse v5.x master')) return EMPTY_SHA
      if (command.includes('git --no-pager diff')) return ''
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadValidate = proxyquire.noCallThru().noPreserveCache()
    loadValidate('./validate', {
      '../../version': { DD_MAJOR: 5, DD_MINOR: 126, DD_PATCH: 0, VERSION: '5.126.0' },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        fail,
        fatal: sinon.stub(),
        flags: {},
        log: sinon.stub(),
        params: ['v5.127.0-proposal'],
        pass: sinon.stub(),
        run,
        start: sinon.stub(),
      },
      crypto: { randomUUID: sinon.stub().returns('temporary-branch') },
    })

    assert(run.calledWithExactly(`git cherry-pick --allow-empty ${EMPTY_SHA} ${VERSION_SHA}`))
    assert.strictEqual(fail.callCount, 0)
  })
})
