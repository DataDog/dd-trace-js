'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_FULL_SHA = '89abcdef0123456789abcdef0123456789abcdef'

describe('release proposal', () => {
  it('describes commit and pull request metadata sources before rendering the changelog', () => {
    const stopped = new Error('proposal stopped after changelog creation')
    const createReleaseChangelog = sinon.stub().throws(stopped)
    const fail = sinon.stub()
    const hydrateReleaseEntries = sinon.stub().returnsArg(0)

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v7.x master')) return '0123456789\n89abcdef01'
      if (command === 'git rev-parse 89abcdef01') return OTHER_FULL_SHA
      if (command.includes('--format=sha --reverse v7.x') && command.includes(OTHER_FULL_SHA)) {
        return '0123456789\n89abcdef01'
      }
      if (command === 'git show -s --format=%s 0123456789') return 'fix(core): preserve context (#123)'
      if (command === 'git show -s --format=%s 89abcdef01') return 'docs: update release notes'
      if (command === 'git log -1 --format=%cs v6.0.0') return '2026-01-01'
      if (command === `git show -s --format=%cs ${OTHER_FULL_SHA}`) return '2026-08-01'
      if (command.startsWith('git log --format=%s v6.0.0..')) {
        return 'feat(core)!: remove legacy context (#456)\nfix(core)!: replace context storage (#457)'
      }
      if (command.includes('--label=semver-major')) {
        return JSON.stringify([
          {
            number: 456,
            title: 'feat(core)!: remove legacy context',
            mergeCommit: undefined,
          },
          {
            number: 457,
            title: 'fix(core)!: replace context storage',
            mergeCommit: { oid: FULL_SHA },
          },
        ])
      }
      if (command.includes('--label=only-land-on-next')) return '[]'
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadProposal = proxyquire.noCallThru().noPreserveCache()
    loadProposal('./proposal', {
      '../../version': { DD_MAJOR: 7, DD_MINOR: 0, DD_PATCH: 0, VERSION: '7.0.0-beta.1' },
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
      {
        commitRef: '0123456789',
        pullRequestNumber: 123,
        subject: 'fix(core): preserve context (#123)',
      },
      {
        commitRef: '89abcdef01',
        pullRequestNumber: undefined,
        subject: 'docs: update release notes',
      },
    ])
    assert.deepStrictEqual(hydrateReleaseEntries.secondCall.args[0], [
      {
        commitRef: undefined,
        pullRequestNumber: 456,
        subject: 'feat(core)!: remove legacy context (#456)',
      },
      {
        commitRef: FULL_SHA,
        pullRequestNumber: 457,
        subject: 'fix(core)!: replace context storage (#457)',
      },
    ])
    assert.strictEqual(createReleaseChangelog.firstCall.args[0], hydrateReleaseEntries.firstCall.returnValue)
    assert.strictEqual(createReleaseChangelog.firstCall.args[1], hydrateReleaseEntries.secondCall.returnValue)
  })
})
