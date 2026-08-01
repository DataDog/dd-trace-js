'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

/**
 * @param {object[]} entries
 * @returns {object[]}
 */
function preserveEntries (entries) {
  return entries
}

/**
 * @param {string} version
 * @returns {{ createReleaseChangelog: sinon.SinonStub, fail: sinon.SinonStub, hydrateReleaseEntries: sinon.SinonStub }}
 */
function loadProposal (version) {
  const stopped = new Error('proposal stopped after changelog creation')
  const createReleaseChangelog = sinon.stub().throws(stopped)
  const fail = sinon.stub()
  const hydrateReleaseEntries = sinon.stub().callsFake(preserveEntries)

  /**
   * @param {string} command
   * @returns {string}
   */
  function capture (command) {
    if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
    if (command.includes('--format=sha --reverse v7.x master')) return '0123456789'
    if (command === 'git rev-parse 0123456789') return FULL_SHA
    if (command.includes('--format=sha --reverse v7.x') && command.includes(FULL_SHA)) return '0123456789'
    if (command === 'git show -s --format=%s 0123456789') return 'fix(core): preserve context (#123)'
    if (command === 'git log -1 --format=%cs v6.0.0') return '2025-01-01'
    if (command === `git show -s --format=%cs ${FULL_SHA}`) return '2026-01-01'
    if (command.startsWith('git log --format=%s v6.0.0..')) return 'fix(core): preserve context (#123)'
    if (command.startsWith('gh pr list ')) return '[]'
    throw new Error(`Unexpected command: ${command}`)
  }

  proxyquire.noCallThru().noPreserveCache()('./proposal', {
    '../../version': {
      DD_MAJOR: 7,
      DD_MINOR: 0,
      DD_PATCH: 0,
      VERSION: version,
    },
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
  return { createReleaseChangelog, fail, hydrateReleaseEntries }
}

describe('release proposal', () => {
  it('hydrates regular release entries before rendering the changelog', () => {
    const { createReleaseChangelog, hydrateReleaseEntries } = loadProposal('7.0.0')

    assert.deepStrictEqual(hydrateReleaseEntries.firstCall.args[0], [
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])
    assert.strictEqual(createReleaseChangelog.firstCall.args[0], hydrateReleaseEntries.firstCall.returnValue)
    assert.deepStrictEqual(createReleaseChangelog.firstCall.args[1], [])
  })

  it('hydrates breaking entries before rendering a major release changelog', () => {
    const { createReleaseChangelog, hydrateReleaseEntries } = loadProposal('7.0.0-pre')

    assert.strictEqual(hydrateReleaseEntries.callCount, 2)
    assert.deepStrictEqual(hydrateReleaseEntries.secondCall.args[0], [])
    assert.strictEqual(createReleaseChangelog.firstCall.args[1], hydrateReleaseEntries.secondCall.returnValue)
  })
})
