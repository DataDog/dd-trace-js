'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567'
const HEAD_SHA = '89abcdef0123456789abcdef0123456789abcdef'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
const REPOSITORY = 'DataDog/dd-trace-js'
const BASE_REF = 'refs/heads/v5.x'
const HEAD_REF = `refs/heads/gh-readonly-queue/v5.x/pr-123-${BASE_SHA}`

const openProposal = {
  baseRefName: 'v5.x',
  headRefName: 'v5.128.0-proposal',
  headRefOid: HEAD_SHA,
  isCrossRepository: false,
  mergeCommit: undefined,
  mergeQueueEntry: { id: 'queue-entry' },
  state: 'OPEN',
}

const mergedProposal = {
  ...openProposal,
  mergeCommit: { oid: HEAD_SHA },
  mergeQueueEntry: undefined,
  state: 'MERGED',
}

describe('confirm release proposal fast-forward', () => {
  it('confirms an exact fast-forward after waiting for the pull request to merge', async () => {
    const { confirmProposalFastForward, execFileSync } = loadConfirmation([
      response(BASE_SHA, openProposal),
      response(HEAD_SHA, mergedProposal),
    ])
    const sleep = sinon.stub().resolves()

    await confirmProposalFastForward(REPOSITORY, BASE_REF, HEAD_REF, { attempts: 2, intervalMs: 10, sleep })

    assert.strictEqual(execFileSync.callCount, 2)
    assert.deepStrictEqual(sleep.args, [[10]])
  })

  it('waits for GitHub to remove the merged pull request from the queue', async () => {
    const queuedProposal = { ...mergedProposal, mergeQueueEntry: { id: 'queue-entry' } }
    const { confirmProposalFastForward } = loadConfirmation([
      response(HEAD_SHA, queuedProposal),
      response(HEAD_SHA, mergedProposal),
    ])

    await confirmProposalFastForward(REPOSITORY, BASE_REF, HEAD_REF, {
      attempts: 2,
      intervalMs: 10,
      sleep: async () => {},
    })
  })

  it('fails when GitHub creates a different merge commit', async () => {
    const proposal = { ...mergedProposal, mergeCommit: { oid: OTHER_SHA } }
    const { confirmProposalFastForward } = loadConfirmation([response(OTHER_SHA, proposal)])

    await assert.rejects(
      confirmProposalFastForward(REPOSITORY, BASE_REF, HEAD_REF),
      { message: `Release proposal merged as ${OTHER_SHA}, expected ${HEAD_SHA}.` }
    )
  })

  it('fails when the proposal changes while the fast-forward is pending', async () => {
    const changedProposal = { ...openProposal, headRefOid: OTHER_SHA }
    const { confirmProposalFastForward } = loadConfirmation([
      response(BASE_SHA, openProposal),
      response(BASE_SHA, changedProposal),
    ])

    await assert.rejects(
      confirmProposalFastForward(REPOSITORY, BASE_REF, HEAD_REF, {
        attempts: 2,
        intervalMs: 10,
        sleep: async () => {},
      }),
      { message: `Release proposal changed from ${HEAD_SHA} to ${OTHER_SHA}.` }
    )
  })

  it('fails closed when the fast-forward does not finish in time', async () => {
    const { confirmProposalFastForward } = loadConfirmation([response(BASE_SHA, openProposal)])

    await assert.rejects(
      confirmProposalFastForward(REPOSITORY, BASE_REF, HEAD_REF, { attempts: 1 }),
      { message: 'Timed out waiting for pull request #123 to fast-forward v5.x.' }
    )
  })

  it('rejects a merge group ref that does not identify a pull request', async () => {
    const { confirmProposalFastForward, execFileSync } = loadConfirmation([])

    await assert.rejects(
      confirmProposalFastForward(REPOSITORY, BASE_REF, 'refs/heads/gh-readonly-queue/v5.x/main'),
      { message: 'Invalid merge group ref: refs/heads/gh-readonly-queue/v5.x/main' }
    )
    assert.strictEqual(execFileSync.callCount, 0)
  })
})

/**
 * @param {string} baseOid
 * @param {typeof openProposal} proposal
 */
function response (baseOid, proposal) {
  return JSON.stringify({
    data: {
      repository: {
        base: { target: { oid: baseOid } },
        pullRequest: proposal,
      },
    },
  })
}

/**
 * @param {string[]} responses
 */
function loadConfirmation (responses) {
  const remainingResponses = [...responses]
  const execFileSync = sinon.stub().callsFake(() => remainingResponses.length > 1
    ? remainingResponses.shift()
    : remainingResponses[0])
  const load = proxyquire.noCallThru().noPreserveCache()
  const { confirmProposalFastForward } = load('./confirm-proposal-fast-forward', {
    'node:child_process': { execFileSync },
  })

  return { confirmProposalFastForward, execFileSync }
}
