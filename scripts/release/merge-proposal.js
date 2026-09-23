'use strict'

const { execFileSync } = require('node:child_process')

const pullRequestQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        baseRefName
        headRefName
        headRefOid
        isCrossRepository
        isDraft
        isInMergeQueue
        reviewDecision
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
 * @property {boolean} isDraft
 * @property {boolean} isInMergeQueue
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
 * @param {string} remoteUrl
 */
function getRepositoryFromRemote (remoteUrl) {
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) throw new Error('Unable to determine the GitHub repository from origin.')

  return `${match[1]}/${match[2]}`
}

/**
 * @param {number} pullRequestNumber
 * @param {string} repository
 * @returns {Proposal}
 */
function getProposal (pullRequestNumber, repository) {
  const [owner, name, unexpected] = repository.split('/')
  if (!owner || !name || unexpected) throw new Error(`Invalid GitHub repository: ${repository}`)

  const response = JSON.parse(capture('gh', [
    'api',
    'graphql',
    '-f',
    `query=${pullRequestQuery}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pullRequestNumber}`,
  ]))
  const proposal = response.data?.repository?.pullRequest
  if (!proposal) throw new Error(`Pull request not found: ${repository}#${pullRequestNumber}`)

  return proposal
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
  if (!proposal.isInMergeQueue) {
    throw new Error('Release proposal must still be in the merge queue.')
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
 * @param {string} [repository]
 */
function mergeProposal (pullRequestNumber, repository) {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('Pull request number must be a positive integer.')
  }

  repository ||= process.env.GITHUB_REPOSITORY || getRepositoryFromRemote(
    capture('git', ['remote', 'get-url', 'origin'])
  )

  const proposal = getProposal(pullRequestNumber, repository)
  validateProposal(proposal)

  const { baseRefName, headRefName, headRefOid } = proposal

  run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${headRefName}`])

  const fetchedHead = capture('git', ['rev-parse', 'FETCH_HEAD'])
  if (fetchedHead !== headRefOid) {
    throw new Error(`Fetched ${fetchedHead}, expected proposal head ${headRefOid}.`)
  }

  run('git', ['update-ref', 'refs/heads/release-proposal', headRefOid])
  run('gh', ['pr', 'checks', String(pullRequestNumber), '--required'])

  const currentProposal = getProposal(pullRequestNumber, repository)
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
