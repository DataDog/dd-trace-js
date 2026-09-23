'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = '89abcdef0123456789abcdef0123456789abcdef'

const approvedProposal = {
  baseRefName: 'v5.x',
  headRefName: 'v5.128.0-proposal',
  headRefOid: HEAD_SHA,
  isCrossRepository: false,
  isDraft: false,
  isInMergeQueue: true,
  reviewDecision: 'APPROVED',
  state: 'OPEN',
}

/**
 * @typedef {typeof approvedProposal} Proposal
 */

describe('merge release proposal', () => {
  it('pushes the exact approved proposal head to the release branch', () => {
    const { execFileSync, mergeProposal } = loadMergeProposal()

    mergeProposal(123, 'DataDog/dd-trace-js')

    assert.deepStrictEqual(commands(execFileSync), [
      'gh api graphql',
      'git fetch --no-tags origin refs/heads/v5.128.0-proposal',
      'git rev-parse FETCH_HEAD',
      `git update-ref refs/heads/release-proposal ${HEAD_SHA}`,
      'gh pr checks 123 --required',
      'gh api graphql',
      'git push origin refs/heads/release-proposal:refs/heads/v5.x',
    ])
    const query = execFileSync.firstCall.args[1].find(arg => arg.startsWith('query='))
    assert.match(query, /isInMergeQueue/)
  })

  it('rejects a proposal that is not approved before fetching it', () => {
    const proposal = { ...approvedProposal, reviewDecision: 'REVIEW_REQUIRED' }
    const { execFileSync, mergeProposal } = loadMergeProposal([proposal])

    assert.throws(() => mergeProposal(123, 'DataDog/dd-trace-js'), {
      message: 'Release proposal must be approved.',
    })
    assert.strictEqual(execFileSync.callCount, 1)
  })

  it('rejects a fetched commit that does not match the proposal head', () => {
    const { execFileSync, mergeProposal } = loadMergeProposal([approvedProposal], OTHER_SHA)

    assert.throws(() => mergeProposal(123, 'DataDog/dd-trace-js'), {
      message: `Fetched ${OTHER_SHA}, expected proposal head ${HEAD_SHA}.`,
    })
    assert(!commands(execFileSync).some(command => command.startsWith('git push ')))
  })

  it('rejects a proposal that changes while required checks are verified', () => {
    const changedProposal = { ...approvedProposal, headRefOid: OTHER_SHA }
    const { execFileSync, mergeProposal } = loadMergeProposal([approvedProposal, changedProposal])

    assert.throws(() => mergeProposal(123, 'DataDog/dd-trace-js'), {
      message: 'Release proposal changed while verifying required checks.',
    })
    assert(!commands(execFileSync).some(command => command.startsWith('git push ')))
  })

  it('rejects a proposal that is dequeued while required checks are verified', () => {
    const dequeuedProposal = { ...approvedProposal, isInMergeQueue: false }
    const { execFileSync, mergeProposal } = loadMergeProposal([approvedProposal, dequeuedProposal])

    assert.throws(() => mergeProposal(123, 'DataDog/dd-trace-js'), {
      message: 'Release proposal must still be in the merge queue.',
    })
    assert(!commands(execFileSync).some(command => command.startsWith('git push ')))
  })
})

/**
 * @param {Proposal[]} [proposals]
 * @param {string} [fetchedHead]
 */
function loadMergeProposal (proposals = [approvedProposal, approvedProposal], fetchedHead = HEAD_SHA) {
  const remainingProposals = [...proposals]
  const execFileSync = sinon.stub().callsFake((command, args) => {
    if (command === 'gh' && args[0] === 'api') {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: remainingProposals.shift(),
          },
        },
      })
    }
    if (command === 'git' && args[0] === 'rev-parse') return fetchedHead
    return ''
  })
  const load = proxyquire.noCallThru().noPreserveCache()
  const { mergeProposal } = load('./merge-proposal', {
    'node:child_process': { execFileSync },
  })

  return { execFileSync, mergeProposal }
}

/**
 * @param {sinon.SinonStub} execFileSync
 */
function commands (execFileSync) {
  return execFileSync.args.map(([command, args]) => {
    if (command === 'gh' && args[0] === 'api') return 'gh api graphql'
    return [command, ...args].join(' ')
  })
}
