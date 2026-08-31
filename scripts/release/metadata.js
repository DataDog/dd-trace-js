'use strict'

const { capture } = require('./helpers/terminal')
const { appendChangedPaths } = require('./changelog')

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
 * @typedef {object} CommitMetadataEntry
 * @property {string} subject
 * @property {string} commitRef
 * @property {number} [pullRequestNumber]
 */

/**
 * @typedef {object} PullRequestMetadataEntry
 * @property {string} subject
 * @property {string} [commitRef]
 * @property {number} pullRequestNumber
 */

/**
 * @typedef {CommitMetadataEntry|PullRequestMetadataEntry} MetadataEntry
 */

/**
 * @typedef {object} GitHubContributor
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [__typename]
 * @property {string} [login]
 * @property {{ login?: string }} [user]
 */

/**
 * @typedef {object} GitHubPullRequest
 * @property {'PullRequest'} __typename
 * @property {number} number
 * @property {string} title
 * @property {GitHubContributor} [author]
 * @property {{ nodes: Array<{ name: string }>, pageInfo: { hasNextPage: boolean } }} labels
 * @property {{ nodes: Array<{ path: string, changeType: string }>, pageInfo: { hasNextPage: boolean } }} files
 */

/**
 * @typedef {object} GitHubCommit
 * @property {{ nodes: GitHubContributor[], pageInfo: { hasNextPage: boolean } }} authors
 */

/**
 * @param {MetadataEntry[]} entries
 */
function hydrateReleaseEntries (entries) {
  if (entries.length === 0) return entries

  const commitRefs = []
  for (const entry of entries) {
    if (entry.commitRef !== undefined) commitRefs.push(entry.commitRef)
  }
  const resolvedShas = commitRefs.length === 0
    ? []
    : capture(`git rev-parse ${commitRefs.join(' ')}`).split('\n')
  const fullShas = []
  const pullRequestNumbers = []
  let commitIndex = 0
  for (const entry of entries) {
    fullShas.push(entry.commitRef === undefined ? undefined : resolvedShas[commitIndex++])
    pullRequestNumbers.push(entry.pullRequestNumber)
  }

  const metadata = readGitHubMetadata(fullShas, pullRequestNumbers)
  const hydrated = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const { commit, pullRequest } = metadata[i]
    const sha = fullShas[i] ?? `pull-request-${entry.pullRequestNumber}`
    if (commit?.authors.pageInfo.hasNextPage || pullRequest?.labels.pageInfo.hasNextPage) {
      throw new Error(`GitHub metadata for ${sha} exceeds one page.`)
    }
    const contributors = readContributors(commit, pullRequest)
    if (!pullRequest) {
      hydrated.push({ sha, subject: entry.subject, contributors })
      continue
    }

    const labels = []
    for (const label of pullRequest.labels.nodes) labels.push(label.name)
    hydrated.push({
      sha,
      subject: `${pullRequest.title} (#${pullRequest.number})`,
      contributors,
      labels,
      files: readFiles(pullRequest),
    })
  }

  return hydrated
}

/**
 * @param {Array<string|undefined>} shas
 * @param {Array<number|undefined>} pullRequestNumbers
 */
function readGitHubMetadata (shas, pullRequestNumbers) {
  const metadata = []
  for (let start = 0; start < shas.length; start += QUERY_CHUNK_SIZE) {
    const end = Math.min(start + QUERY_CHUNK_SIZE, shas.length)
    let fields = ''
    for (let i = start; i < end; i++) {
      const sha = shas[i]
      if (sha !== undefined) {
        fields += `commit${i}: object(oid: "${sha}") { ... on Commit { ` +
          'authors(first: 100) { nodes { name email user { login } } pageInfo { hasNextPage } } } } '
      }
      const pullRequestNumber = pullRequestNumbers[i]
      if (pullRequestNumber !== undefined) {
        fields += `pullRequest${i}: issueOrPullRequest(number: ${pullRequestNumber}) { __typename ` +
          '... on PullRequest { number title author { __typename login } ' +
          'labels(first: 100) { nodes { name } pageInfo { hasNextPage } } ' +
          'files(first: 100) { nodes { path changeType } pageInfo { hasNextPage } } } } '
      }
    }

    const response = JSON.parse(capture(
      `gh api graphql -f query='query { repository(owner: "DataDog", name: "dd-trace-js") { ${fields}} }'`
    ))
    if (response.errors?.[0]) throw new Error(`GitHub metadata query failed: ${response.errors[0].message}`)

    const repository = response.data.repository
    for (let i = start; i < end; i++) {
      const pullRequestNumber = pullRequestNumbers[i]
      const pullRequest = pullRequestNumber === undefined ? undefined : repository[`pullRequest${i}`]
      metadata[i] = {
        commit: shas[i] === undefined ? undefined : repository[`commit${i}`],
        pullRequest: pullRequest?.__typename === 'PullRequest' ? pullRequest : undefined,
      }
    }
  }
  return metadata
}

/**
 * @param {GitHubCommit|undefined} commit
 * @param {GitHubPullRequest|undefined} pullRequest
 */
function readContributors (commit, pullRequest) {
  const contributors = new Map()
  if (commit) {
    for (const author of commit.authors.nodes) addContributor(contributors, author)
  }
  if (pullRequest?.author) addContributor(contributors, pullRequest.author)
  return [...contributors.values()]
}

/**
 * @param {GitHubPullRequest} pullRequest
 */
function readFiles (pullRequest) {
  let renamed = false
  for (const file of pullRequest.files.nodes) {
    if (file.changeType === 'RENAMED') {
      renamed = true
      break
    }
  }

  if (!renamed && !pullRequest.files.pageInfo.hasNextPage) {
    const files = []
    for (const file of pullRequest.files.nodes) files.push(file.path)
    return files
  }

  const pages = JSON.parse(capture(
    `gh api "repos/DataDog/dd-trace-js/pulls/${pullRequest.number}/files?per_page=100" --paginate --slurp`
  ))
  const files = []
  for (const page of pages) {
    appendChangedPaths(files, page)
  }
  return files
}

/**
 * @param {Map<string, Contributor>} contributors
 * @param {GitHubContributor} contributor
 */
function addContributor (contributors, contributor) {
  if (contributor.__typename === 'Bot') return

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
