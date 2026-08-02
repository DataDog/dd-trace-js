'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

describe('release proposal', () => {
  it('hydrates release entries before rendering the changelog', () => {
    const stopped = new Error('proposal stopped after changelog creation')
    const createReleaseChangelog = sinon.stub().throws(stopped)
    const fail = sinon.stub()
    const hydrateReleaseEntries = sinon.stub().returnsArg(0)

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v7.x master')) return '0123456789'
      if (command === 'git rev-parse 0123456789') return FULL_SHA
      if (command.includes('--format=sha --reverse v7.x') && command.includes(FULL_SHA)) return '0123456789'
      if (command === 'git show -s --format=%s 0123456789') return 'fix(core): preserve context (#123)'
      throw new Error(`Unexpected command: ${command}`)
    }

    proxyquire.noCallThru().noPreserveCache()('./proposal', {
      '../../version': { DD_MAJOR: 7, DD_MINOR: 0, DD_PATCH: 0, VERSION: '7.0.0' },
      './changelog': { createReleaseChangelog },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        checkpoint: sinon.stub(),
        fail,
        fatal: sinon.stub(),
        flags: {},
        log: sinon.stub(),
        params: ['7'],
        pass: sinon.stub(),
        run: sinon.stub(),
        start: sinon.stub(),
      },
      './metadata': { hydrateReleaseEntries },
    })

    assert.strictEqual(fail.firstCall.args[0], stopped)
    assert.deepStrictEqual(hydrateReleaseEntries.firstCall.args[0], [
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])
    assert.deepStrictEqual(hydrateReleaseEntries.secondCall.args[0], [])
    assert.strictEqual(createReleaseChangelog.firstCall.args[0], hydrateReleaseEntries.firstCall.returnValue)
    assert.strictEqual(createReleaseChangelog.firstCall.args[1], hydrateReleaseEntries.secondCall.returnValue)
  })
})
