'use strict'

const { execFileSync } = require('node:child_process')

const pullRequestFields = [
  'baseRefName',
  'headRefName',
  'headRefOid',
  'isCrossRepository',
  'isDraft',
  'reviewDecision',
  'state',
].join(',')

/**
 * @typedef {object} Proposal
 * @property {string} baseRefName
 * @property {string} headRefName
 * @property {string} headRefOid
 * @property {boolean} isCrossRepository
 * @property {boolean} isDraft
 * @property {string} reviewDecision
 * @property {string} state
 */

/**
 * @param {string} command
 * @param {string[]} args
 */
function capture (command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function run (command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

/**
 * @param {number} pullRequestNumber
 * @returns {Proposal}
 */
function getProposal (pullRequestNumber) {
  return JSON.parse(capture('gh', [
    'pr',
    'view',
    String(pullRequestNumber),
    '--json',
    pullRequestFields,
  ]))
}

/**
 * @param {Proposal} proposal
 */
function validateProposal (proposal) {
  if (proposal.state !== 'OPEN') {
    throw new Error('Release proposal must be open.')
  }
  if (proposal.isDraft) {
    throw new Error('Release proposal must not be a draft.')
  }
  if (proposal.isCrossRepository) {
    throw new Error('Release proposal must come from this repository.')
  }
  if (proposal.reviewDecision !== 'APPROVED') {
    throw new Error('Release proposal must be approved.')
  }
  if (!/^v[0-9]+\.x$/.test(proposal.baseRefName)) {
    throw new Error(`Invalid release branch: ${proposal.baseRefName}`)
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+-proposal$/.test(proposal.headRefName)) {
    throw new Error(`Invalid release proposal branch: ${proposal.headRefName}`)
  }
}

/**
 * @param {number} pullRequestNumber
 */
function mergeProposal (pullRequestNumber) {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('Pull request number must be a positive integer.')
  }

  const proposal = getProposal(pullRequestNumber)
  validateProposal(proposal)

  const { baseRefName, headRefName, headRefOid } = proposal

  run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${headRefName}`])

  const fetchedHead = capture('git', ['rev-parse', 'FETCH_HEAD'])
  if (fetchedHead !== headRefOid) {
    throw new Error(`Fetched ${fetchedHead}, expected proposal head ${headRefOid}.`)
  }

  run('git', ['update-ref', 'refs/heads/release-proposal', headRefOid])
  run('gh', ['pr', 'checks', String(pullRequestNumber), '--required'])

  const currentProposal = getProposal(pullRequestNumber)
  validateProposal(currentProposal)

  if (
    currentProposal.baseRefName !== baseRefName ||
    currentProposal.headRefName !== headRefName ||
    currentProposal.headRefOid !== headRefOid
  ) {
    throw new Error('Release proposal changed while verifying required checks.')
  }

  run('git', [
    'push',
    'origin',
    `refs/heads/release-proposal:refs/heads/${baseRefName}`,
  ])
}

if (require.main === module) {
  const pullRequestNumber = Number(process.argv[2])

  try {
    mergeProposal(pullRequestNumber)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { mergeProposal }
