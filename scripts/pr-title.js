'use strict'

// Steps of .github/workflows/pr-title.yml, called through actions/github-script.

const childProcess = require('node:child_process')

const { isInternalOnly } = require('./release/changelog')

/**
 * Renames a GitHub-generated `Revert "..."` title to a Conventional Commits title.
 *
 * @param {{ context: object, core: object, github: object }} args
 */
async function renameRevert ({ context, core, github }) {
  const title = context.payload.pull_request.title
  const m = title.match(/^Revert "(.+)"$/)
  if (!m) return
  const newTitle = `revert: ${m[1]}`
  core.notice(`Auto-renaming PR title to: ${newTitle}`)
  await github.rest.pulls.update({
    ...context.repo,
    pull_number: context.payload.pull_request.number,
    title: newTitle,
  })
  core.setOutput('renamed', 'true')
}

/**
 * Fails when the title is not a Conventional Commit, or when it uses a public release-note type for a change that
 * only touches internal files. This reads the fetched PR head with git and never calls the GitHub API.
 *
 * @param {{ context: object, core: object }} args
 */
function validateTitle ({ context, core }) {
  const pullRequest = context.payload.pull_request
  const title = pullRequest.title || ''
  const match = title.match(new RegExp(process.env.PR_TITLE_PATTERN))
  if (!match) {
    core.setFailed('PR title does not follow Conventional Commits format.')
    return
  }
  core.info(`PR title OK: ${title}`)

  const type = match[3]
  if (!/^(?:feat|fix|perf|docs)$/.test(type)) return

  // Treat renames as delete/add pairs so both paths affect classification.
  const output = childProcess.execFileSync('git', [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    `${pullRequest.base.sha}...refs/remotes/pull-request/head`,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const files = output.split('\0').filter(Boolean)

  if (isInternalOnly(files)) {
    core.setFailed(`PR title type "${type}" is public, but every changed file is internal. ` +
      'Use test, bench, ci, or chore.')
  }
}

/**
 * @param {string | undefined} title
 * @param {RegExp} pattern
 * @returns {{ type?: string, scope?: string, breaking?: boolean }}
 */
function parseTitle (title, pattern) {
  const m = (title || '').match(pattern)
  if (!m) return {}
  const isRevert = !m[3]
  return {
    type: isRevert ? 'revert' : m[3],
    scope: isRevert ? undefined : m[5],
    breaking: isRevert ? m[2] === '!' : m[6] === '!',
  }
}

/**
 * Reverts are always semver-patch regardless of the original change's type.
 *
 * @param {{ type?: string, breaking?: boolean }} parsed
 */
function semverFor ({ type, breaking }) {
  if (!type) return
  if (breaking) return 'semver-major'
  if (type === 'feat') return 'semver-minor'
  return 'semver-patch'
}

/**
 * Adds the type, scope and semver labels derived from the title, and removes the ones a title edit made stale.
 *
 * @param {{ context: object, github: object }} args
 */
async function syncLabels ({ context, github }) {
  const pattern = new RegExp(process.env.PR_TITLE_PATTERN)
  const parse = (title) => parseTitle(title, pattern)

  const pr = context.payload.pull_request
  const next = parse(pr.title)

  // Prefetch all existing repo labels once to avoid per-label API calls.
  const repoLabels = new Set()
  const pages = github.paginate.iterator(github.rest.issues.listLabelsForRepo, { ...context.repo, per_page: 100 })
  for await (const page of pages) {
    for (const label of page.data) repoLabels.add(label.name)
  }

  // Returns the set of labels derived from a parsed title.
  // Type and scope are only added if they exist in the repo.
  const titledLabels = (parsed) => {
    const labels = new Set()
    if (!parsed.type) return labels
    if (repoLabels.has(parsed.type)) labels.add(parsed.type)
    if (parsed.scope) {
      for (const scope of parsed.scope.split(',')) {
        const name = scope.trim()
        if (name && repoLabels.has(name)) labels.add(name)
      }
    }
    const semver = semverFor(parsed)
    if (semver) labels.add(semver)
    return labels
  }

  const nextLabels = titledLabels(next)
  const current = new Set((pr.labels || []).map(l => l.name))

  // When the title changes, remove labels from the old title that no
  // longer apply so stale type/scope/semver labels don't linger.
  const titleChanged = context.payload.action === 'edited' &&
    context.payload.changes?.title?.from != null
  const toRemove = new Set()
  if (titleChanged) {
    const prev = parse(context.payload.changes.title.from)
    for (const label of titledLabels(prev)) {
      if (!nextLabels.has(label)) toRemove.add(label)
    }
  }

  const desired = new Set([...current].filter(l => !toRemove.has(l)))
  for (const label of nextLabels) desired.add(label)

  const unchanged = current.size === desired.size && [...current].every(l => desired.has(l))
  if (!unchanged) {
    await github.rest.issues.setLabels({
      ...context.repo,
      issue_number: pr.number,
      labels: [...desired],
    })
  }
}

module.exports = { renameRevert, syncLabels, validateTitle }
