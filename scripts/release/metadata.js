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
 */

/**
 * @typedef {object} GitHubContributor
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [login]
 * @property {{ login?: string }} [user]
 */

/**
 * @typedef {object} GitHubCommit
 * @property {{ nodes: GitHubContributor[], pageInfo: { hasNextPage: boolean } }} authors
 * @property {{ nodes: Array<{ number: number, author?: GitHubContributor }> }} associatedPullRequests
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

  const commits = readGitHubCommits(fullShas)
  const hydrated = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const sha = fullShas[i]
    const commit = commits.get(sha)
    if (!commit) throw new Error(`GitHub did not return metadata for ${sha}.`)

    hydrated.push({
      ...entry,
      sha,
      contributors: readContributors(commit, entry.subject),
    })
  }

  return hydrated
}

/**
 * @param {string[]} shas
 * @returns {Map<string, GitHubCommit>}
 */
function readGitHubCommits (shas) {
  const commits = new Map()

  for (let start = 0; start < shas.length; start += QUERY_CHUNK_SIZE) {
    const end = Math.min(start + QUERY_CHUNK_SIZE, shas.length)
    let fields = ''
    for (let i = start; i < end; i++) {
      fields += `commit${i}: object(oid: "${shas[i]}") { ... on Commit { ` +
        'authors(first: 100) { nodes { name email user { login } } pageInfo { hasNextPage } } ' +
        'associatedPullRequests(first: 10) { nodes { number author { login } } } ' +
        '} } '
    }

    const query = `query { repository(owner: "DataDog", name: "dd-trace-js") { ${fields}} }`
    const response = JSON.parse(capture(`gh api graphql -f query='${query}'`))
    if (response.errors?.length) {
      throw new Error(`GitHub metadata query failed: ${response.errors[0].message}`)
    }

    for (let i = start; i < end; i++) {
      const commit = response.data?.repository?.[`commit${i}`]
      if (!commit) continue
      if (commit.authors.pageInfo.hasNextPage) {
        throw new Error(`Commit ${shas[i]} has more than 100 authors.`)
      }
      commits.set(shas[i], commit)
    }
  }

  return commits
}

/**
 * @param {GitHubCommit} commit
 * @param {string} subject
 * @returns {Contributor[]}
 */
function readContributors (commit, subject) {
  const contributors = new Map()

  for (const author of commit.authors.nodes) {
    addContributor(contributors, author)
  }

  const pullRequestMatch = subject.match(PULL_REQUEST_PATTERN)
  if (pullRequestMatch) {
    const pullRequestNumber = Number.parseInt(pullRequestMatch[1], 10)
    for (const pullRequest of commit.associatedPullRequests.nodes) {
      if (pullRequest.number === pullRequestNumber && pullRequest.author) {
        addContributor(contributors, pullRequest.author)
        break
      }
    }
  }

  return [...contributors.values()]
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
