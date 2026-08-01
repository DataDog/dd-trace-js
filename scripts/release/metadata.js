'use strict'

const { capture } = require('./helpers/terminal')

const SHA_PATTERN = /^[a-f0-9]{7,40}$/i
const PULL_REQUEST_PATTERN = /\(#([0-9]+)\)$/
const QUERY_CHUNK_SIZE = 50
const NON_HUMAN_LOGINS = new Set(['claude', 'copilot', 'cursoragent', 'dependabot', 'github-actions'])
const NON_HUMAN_EMAILS = new Set([
  '175728472+copilot@users.noreply.github.com',
  'cursoragent@cursor.com',
  'noreply@anthropic.com',
])

/**
 * @typedef {object} Contributor
 * @property {string} name
 * @property {string} [login]
 */

/**
 * @typedef {object} ReleaseEntry
 * @property {string} sha
 * @property {string} subject
 * @property {Contributor[]} [contributors]
 * @property {string[]} [labels]
 * @property {string[]} [files]
 */

/**
 * @typedef {object} GitHubContributor
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [login]
 * @property {{ login?: string }} [user]
 */

/**
 * @typedef {object} GitHubPullRequest
 * @property {number} number
 * @property {string} title
 * @property {GitHubContributor} [author]
 * @property {{ nodes: Array<{ name: string }>, pageInfo: { hasNextPage: boolean } }} labels
 * @property {{ nodes: Array<{ path: string }>, pageInfo: { hasNextPage: boolean } }} files
 */

/**
 * @typedef {object} GitHubCommit
 * @property {{ nodes: GitHubContributor[], pageInfo: { hasNextPage: boolean } }} authors
 */

/**
 * @typedef {object} GitHubMetadata
 * @property {GitHubCommit} commit
 * @property {GitHubPullRequest} [pullRequest]
 */

/**
 * @param {ReleaseEntry[]} entries
 * @returns {ReleaseEntry[]}
 */
function hydrateReleaseEntries (entries) {
  if (entries.length === 0) return []

  const shas = []
  for (const entry of entries) {
    if (!SHA_PATTERN.test(entry.sha)) throw new Error(`Invalid release commit SHA: ${entry.sha}`)
    shas.push(entry.sha)
  }

  const fullShas = capture(`git rev-parse ${shas.join(' ')}`).split('\n')
  if (fullShas.length !== entries.length) {
    throw new Error(`Resolved ${fullShas.length} release SHAs for ${entries.length} entries.`)
  }

  const pullRequestNumbers = []
  for (const entry of entries) {
    pullRequestNumbers.push(readPullRequestNumber(entry.subject))
  }

  const metadataBySha = readGitHubMetadata(fullShas, pullRequestNumbers)
  const hydrated = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const sha = fullShas[i]
    const metadata = metadataBySha.get(sha)
    if (!metadata) throw new Error(`GitHub did not return metadata for ${sha}.`)

    const { commit, pullRequest } = metadata
    const contributors = readContributors(commit, pullRequest)
    if (pullRequest) {
      if (pullRequest.labels.pageInfo.hasNextPage) {
        throw new Error(`Pull request #${pullRequest.number} has more than 100 labels.`)
      }
      const labels = []
      for (const label of pullRequest.labels.nodes) {
        labels.push(label.name)
      }
      hydrated.push({
        ...entry,
        sha,
        subject: `${pullRequest.title} (#${pullRequest.number})`,
        contributors,
        labels,
        files: readFiles(pullRequest),
      })
    } else {
      hydrated.push({
        ...entry,
        sha,
        contributors,
      })
    }
  }

  return hydrated
}

/**
 * @param {string[]} shas
 * @param {Array<number|undefined>} pullRequestNumbers
 * @returns {Map<string, GitHubMetadata>}
 */
function readGitHubMetadata (shas, pullRequestNumbers) {
  const metadataBySha = new Map()

  for (let start = 0; start < shas.length; start += QUERY_CHUNK_SIZE) {
    const end = Math.min(start + QUERY_CHUNK_SIZE, shas.length)
    let fields = ''
    for (let i = start; i < end; i++) {
      fields += `commit${i}: object(oid: "${shas[i]}") { ... on Commit { ` +
        'authors(first: 100) { nodes { name email user { login } } pageInfo { hasNextPage } } ' +
        '} } '
      const pullRequestNumber = pullRequestNumbers[i]
      if (pullRequestNumber !== undefined) {
        fields += `pullRequest${i}: pullRequest(number: ${pullRequestNumber}) { number title author { login } ` +
          'labels(first: 100) { nodes { name } pageInfo { hasNextPage } } ' +
          'files(first: 100) { nodes { path } pageInfo { hasNextPage } } } '
      }
    }

    const query = `query { repository(owner: "DataDog", name: "dd-trace-js") { ${fields}} }`
    const response = JSON.parse(capture(`gh api graphql -f query='${query}'`))
    if (response.errors?.length) {
      throw new Error(`GitHub metadata query failed: ${response.errors[0].message}`)
    }

    for (let i = start; i < end; i++) {
      const repository = response.data?.repository
      const commit = repository?.[`commit${i}`]
      if (!commit) continue
      if (commit.authors.pageInfo.hasNextPage) {
        throw new Error(`Commit ${shas[i]} has more than 100 authors.`)
      }
      const pullRequestNumber = pullRequestNumbers[i]
      const pullRequest = pullRequestNumber === undefined ? undefined : repository[`pullRequest${i}`]
      if (pullRequestNumber !== undefined && !pullRequest) {
        throw new Error(`GitHub did not return pull request #${pullRequestNumber}.`)
      }
      metadataBySha.set(shas[i], { commit, pullRequest })
    }
  }

  return metadataBySha
}

/**
 * @param {string} subject
 * @returns {number|undefined}
 */
function readPullRequestNumber (subject) {
  const pullRequestMatch = subject.match(PULL_REQUEST_PATTERN)
  if (!pullRequestMatch) return

  return Number.parseInt(pullRequestMatch[1], 10)
}

/**
 * @param {GitHubCommit} commit
 * @param {GitHubPullRequest|undefined} pullRequest
 * @returns {Contributor[]}
 */
function readContributors (commit, pullRequest) {
  const contributors = new Map()

  for (const author of commit.authors.nodes) {
    addContributor(contributors, author)
  }
  if (pullRequest?.author) addContributor(contributors, pullRequest.author)

  return [...contributors.values()]
}

/**
 * @param {GitHubPullRequest} pullRequest
 * @returns {string[]}
 */
function readFiles (pullRequest) {
  if (!pullRequest.files.pageInfo.hasNextPage) {
    const files = []
    for (const file of pullRequest.files.nodes) {
      files.push(file.path)
    }
    return files
  }

  const pages = JSON.parse(capture(
    `gh api "repos/DataDog/dd-trace-js/pulls/${pullRequest.number}/files?per_page=100" --paginate --slurp`
  ))
  const files = []
  for (const page of pages) {
    for (const file of page) {
      files.push(file.filename)
    }
  }
  return files
}

/**
 * @param {Map<string, Contributor>} contributors
 * @param {GitHubContributor} contributor
 * @returns {void}
 */
function addContributor (contributors, contributor) {
  const login = contributor.user?.login ?? contributor.login
  const name = login ? `@${login}` : contributor.name
  if (!name || isNonHuman(login, contributor.name, contributor.email)) return

  const identity = login
    ? `login:${login.toLowerCase()}`
    : `email:${contributor.email?.toLowerCase() ?? name.toLowerCase()}`
  if (contributors.has(identity)) return

  contributors.set(identity, login ? { name, login } : { name })
}

/**
 * @param {string|undefined} login
 * @param {string|undefined} name
 * @param {string|undefined} email
 * @returns {boolean}
 */
function isNonHuman (login, name, email) {
  const normalizedLogin = login?.toLowerCase()
  return (normalizedLogin !== undefined &&
    (normalizedLogin.endsWith('[bot]') || NON_HUMAN_LOGINS.has(normalizedLogin))) ||
    name?.toLowerCase().endsWith('[bot]') === true ||
    NON_HUMAN_EMAILS.has(email?.toLowerCase())
}

module.exports = {
  hydrateReleaseEntries,
}
