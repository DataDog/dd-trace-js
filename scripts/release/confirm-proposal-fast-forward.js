'use strict'

const { execFileSync } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')

// Poll immediately and then every 10 seconds for up to 10 minutes.
const ATTEMPTS = 61
const INTERVAL_MS = 10_000
// The merge_group payload has no pull request object. Fail closed if GitHub changes its generated ref format.
const mergeGroupHeadPattern = /^refs\/heads\/gh-readonly-queue\/(v[0-9]+\.x)\/pr-([1-9][0-9]*)-[0-9a-f]{40}$/
const repositoryPattern = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const proposalBranchPattern = /^v[0-9]+\.[0-9]+\.[0-9]+-proposal$/

const query = `
  query($owner: String!, $name: String!, $number: Int!, $base: String!) {
    repository(owner: $owner, name: $name) {
      base: ref(qualifiedName: $base) {
        target {
          ... on Commit {
            oid
          }
        }
      }
      pullRequest(number: $number) {
        baseRefName
        headRefName
        headRefOid
        isCrossRepository
        mergeCommit {
          oid
        }
        mergeQueueEntry {
          id
        }
        state
      }
    }
  }
`

/**
 * @typedef {object} Proposal
 * @property {string} baseRefName
 * @property {string} headRefName
 * @property {string} headRefOid
 * @property {boolean} isCrossRepository
 * @property {{oid: string} | undefined} mergeCommit
 * @property {{id: string} | undefined} mergeQueueEntry
 * @property {string} state
 */

/**
 * @typedef {object} ProposalState
 * @property {string} baseOid
 * @property {Proposal} proposal
 */

/**
 * @param {string} command
 * @param {string[]} args
 */
function capture (command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

/**
 * @param {string} repository
 * @param {number} pullRequestNumber
 * @param {string} baseRef
 */
function getProposalState (repository, pullRequestNumber, baseRef) {
  const [, owner, name] = repository.match(repositoryPattern)
  const result = JSON.parse(capture('gh', [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pullRequestNumber}`,
    '-f',
    `base=${baseRef}`,
  ]))
  const { base, pullRequest: proposal } = result.data.repository

  if (!base?.target?.oid) throw new Error(`Release branch not found: ${baseRef}`)
  if (!proposal) throw new Error(`Pull request not found: ${pullRequestNumber}`)

  return { baseOid: base.target.oid, proposal }
}

/**
 * @param {Proposal} proposal
 * @param {string} baseRefName
 * @param {string} [expectedHead]
 */
function validateProposal (proposal, baseRefName, expectedHead) {
  if (proposal.baseRefName !== baseRefName) {
    throw new Error(`Pull request targets ${proposal.baseRefName}, expected ${baseRefName}.`)
  }
  if (!proposalBranchPattern.test(proposal.headRefName)) {
    throw new Error(`Invalid release proposal branch: ${proposal.headRefName}`)
  }
  if (proposal.isCrossRepository) {
    throw new Error('Release proposal must come from this repository.')
  }
  if (expectedHead && proposal.headRefOid !== expectedHead) {
    throw new Error(`Release proposal changed from ${expectedHead} to ${proposal.headRefOid}.`)
  }
  if (proposal.state !== 'OPEN' && proposal.state !== 'MERGED') {
    throw new Error(`Release proposal entered unexpected state: ${proposal.state}`)
  }
}

/**
 * @param {ProposalState} state
 * @param {string} expectedHead
 */
function isConfirmedFastForward ({ baseOid, proposal }, expectedHead) {
  if (proposal.state !== 'MERGED') return false

  if (proposal.mergeCommit && proposal.mergeCommit.oid !== expectedHead) {
    throw new Error(`Release proposal merged as ${proposal.mergeCommit.oid}, expected ${expectedHead}.`)
  }

  return proposal.mergeCommit?.oid === expectedHead && baseOid === expectedHead && !proposal.mergeQueueEntry
}

/**
 * @param {string} repository
 * @param {string} baseRef
 * @param {string} mergeGroupHeadRef
 * @param {{attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>}} [options]
 */
async function confirmProposalFastForward (
  repository,
  baseRef,
  mergeGroupHeadRef,
  { attempts = ATTEMPTS, intervalMs = INTERVAL_MS, sleep: wait = sleep } = {}
) {
  if (!repositoryPattern.test(repository)) throw new Error(`Invalid repository: ${repository}`)

  const headMatch = mergeGroupHeadRef.match(mergeGroupHeadPattern)
  if (!headMatch) throw new Error(`Invalid merge group ref: ${mergeGroupHeadRef}`)

  const [, baseRefName, pullRequest] = headMatch
  if (baseRef !== `refs/heads/${baseRefName}`) {
    throw new Error(`Merge group targets ${baseRef}, expected refs/heads/${baseRefName}.`)
  }

  const pullRequestNumber = Number(pullRequest)
  let expectedHead

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = getProposalState(repository, pullRequestNumber, baseRef)
    expectedHead ??= state.proposal.headRefOid
    validateProposal(state.proposal, baseRefName, expectedHead)

    if (isConfirmedFastForward(state, expectedHead)) {
      process.stdout.write(
        `Confirmed pull request #${pullRequestNumber} fast-forwarded ${baseRefName} to ${expectedHead}.\n`
      )
      return
    }

    if (attempt < attempts) {
      process.stdout.write(`Waiting for pull request #${pullRequestNumber} to fast-forward ${baseRefName}.\n`)
      // eslint-disable-next-line no-await-in-loop -- Each poll must observe the result of the previous wait.
      await wait(intervalMs)
    }
  }

  throw new Error(`Timed out waiting for pull request #${pullRequestNumber} to fast-forward ${baseRefName}.`)
}

if (require.main === module) {
  const [repository, baseRef, mergeGroupHeadRef] = process.argv.slice(2)

  confirmProposalFastForward(repository, baseRef, mergeGroupHeadRef).catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { confirmProposalFastForward }
