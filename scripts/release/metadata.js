'use strict'

const { capture } = require('./helpers/terminal')

const PULL_REQUEST_PATTERN = /\(#([0-9]+)\)$/
const QUERY_CHUNK_SIZE = 50
const NON_HUMAN_LOGINS = new Set(['claude', 'copilot', 'cursoragent', 'dependabot', 'github-actions'])
const NON_HUMAN_EMAILS = new Set([
  '175728472+copilot@users.noreply.github.com',
  'cursoragent@cursor.com',
  'noreply@anthropic.com',
  'codex@openai.com',
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
 * @param {ReleaseEntry[]} entries
 */
function hydrateReleaseEntries (entries) {
  if (entries.length === 0) return entries

  const shas = []
  const pullRequestNumbers = []
  for (const entry of entries) {
    shas.push(entry.sha)
    const match = entry.subject.match(PULL_REQUEST_PATTERN)
    pullRequestNumbers.push(match ? Number.parseInt(match[1], 10) : undefined)
  }

  const fullShas = capture(`git rev-parse ${shas.join(' ')}`).split('\n')
  const metadata = readGitHubMetadata(fullShas, pullRequestNumbers)
  const hydrated = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const { commit, pullRequest } = metadata[i]
    if (commit.authors.pageInfo.hasNextPage || pullRequest?.labels.pageInfo.hasNextPage) {
      throw new Error(`GitHub metadata for ${fullShas[i]} exceeds one page.`)
    }
    const contributors = readContributors(commit, pullRequest)
    if (pullRequestNumbers[i] === undefined) {
      hydrated.push({ ...entry, sha: fullShas[i], contributors })
      continue
    }

    const labels = []
    for (const label of pullRequest.labels.nodes) labels.push(label.name)
    hydrated.push({
      ...entry,
      sha: fullShas[i],
      subject: `${pullRequest.title} (#${pullRequest.number})`,
      contributors,
      labels,
      files: readFiles(pullRequest),
    })
  }

  return hydrated
}

/**
 * @param {string[]} shas
 * @param {Array<number|undefined>} pullRequestNumbers
 */
function readGitHubMetadata (shas, pullRequestNumbers) {
  const metadata = []
  for (let start = 0; start < shas.length; start += QUERY_CHUNK_SIZE) {
    const end = Math.min(start + QUERY_CHUNK_SIZE, shas.length)
    let fields = ''
    for (let i = start; i < end; i++) {
      fields += `commit${i}: object(oid: "${shas[i]}") { ... on Commit { ` +
        'authors(first: 100) { nodes { name email user { login } } pageInfo { hasNextPage } } } } '
      const pullRequestNumber = pullRequestNumbers[i]
      if (pullRequestNumber !== undefined) {
        fields += `pullRequest${i}: pullRequest(number: ${pullRequestNumber}) { number title author { login } ` +
          'labels(first: 100) { nodes { name } pageInfo { hasNextPage } } ' +
          'files(first: 100) { nodes { path } pageInfo { hasNextPage } } } '
      }
    }

    const response = JSON.parse(capture(
      `gh api graphql -f query='query { repository(owner: "DataDog", name: "dd-trace-js") { ${fields}} }'`
    ))
    if (response.errors?.[0]) throw new Error(`GitHub metadata query failed: ${response.errors[0].message}`)

    const repository = response.data.repository
    for (let i = start; i < end; i++) {
      const pullRequestNumber = pullRequestNumbers[i]
      metadata[i] = {
        commit: repository[`commit${i}`],
        pullRequest: pullRequestNumber === undefined ? undefined : repository[`pullRequest${i}`],
      }
    }
  }
  return metadata
}

/**
 * @param {GitHubCommit} commit
 * @param {GitHubPullRequest|undefined} pullRequest
 */
function readContributors (commit, pullRequest) {
  const contributors = new Map()
  for (const author of commit.authors.nodes) addContributor(contributors, author)
  if (pullRequest?.author) addContributor(contributors, pullRequest.author)
  return [...contributors.values()]
}

/**
 * @param {GitHubPullRequest} pullRequest
 */
function readFiles (pullRequest) {
  if (!pullRequest.files.pageInfo.hasNextPage) {
    const files = []
    for (const file of pullRequest.files.nodes) files.push(file.path)
    return files
  }

  const pages = JSON.parse(capture(
    `gh api "repos/DataDog/dd-trace-js/pulls/${pullRequest.number}/files?per_page=100" --paginate --slurp`
  ))
  const files = []
  for (const page of pages) {
    for (const file of page) files.push(file.filename)
  }
  return files
}

/**
 * @param {Map<string, Contributor>} contributors
 * @param {GitHubContributor} contributor
 */
function addContributor (contributors, contributor) {
  const login = contributor.user?.login ?? contributor.login
  const normalizedLogin = login?.toLowerCase()
  if ((normalizedLogin && (normalizedLogin.endsWith('[bot]') || NON_HUMAN_LOGINS.has(normalizedLogin))) ||
    contributor.name?.toLowerCase().endsWith('[bot]') ||
    NON_HUMAN_EMAILS.has(contributor.email?.toLowerCase())) return

  const name = login ? `@${login}` : contributor.name
  if (!name) return

  const identity = normalizedLogin ?? contributor.email?.toLowerCase() ?? name.toLowerCase()
  if (!contributors.has(identity)) contributors.set(identity, login ? { name, login } : { name })
}

module.exports = {
  hydrateReleaseEntries,
}
