'use strict'

/**
 * Scope checks for pull requests: everything in a PR must serve its title.
 *
 * These are deterministic proxies for scope creep, not a semantic judgement. Each one keys off
 * evidence the author already supplied (commit types, file status, whitespace-only hunks) rather
 * than guessing intent from code. See the "Scope discipline" section of AGENTS.md.
 *
 * @typedef {'feat'|'fix'|'docs'|'style'|'refactor'|'perf'|'test'|'bench'|'build'|'ci'|'chore'|'revert'} CommitType
 *
 * @typedef {object} ConventionalSubject
 * @property {CommitType} type
 * @property {string} [scope]
 *
 * @typedef {object} PullRequestFile
 * @property {string} filename
 * @property {'added'|'removed'|'modified'|'renamed'|'copied'|'changed'|'unchanged'} status
 * @property {number} changes
 * @property {string} [patch] Unified diff. Omitted by the GitHub API for very large or binary files.
 * @property {string} [previous_filename]
 *
 * @typedef {object} ScopeViolation
 * @property {string} rule
 * @property {string} message
 *
 * @typedef {object} StepBindings actions/github-script bindings, passed straight through from the workflow.
 * @property {{ repo: { owner: string, repo: string }, payload: { pull_request: object } }} context
 * @property {{ info: (message: string) => void, notice: (message: string) => void,
 *   error: (message: string, properties?: { title?: string }) => void,
 *   setFailed: (message: string) => void }} core
 * @property {{ paginate: Function, rest: { pulls: { listFiles: Function, listCommits: Function } } }} github
 */

// Applied to a PR when a violation is deliberate; see the "Scope discipline" section of AGENTS.md.
const EXCEPTION_LABEL = 'scope-exception'

// Keep in sync with PR_TITLE_PATTERN in .github/workflows/pr-title.yml.
const CONVENTIONAL_SUBJECT = /^(?:revert(!)?: .+|(feat|fix|docs|style|refactor|perf|test|bench|build|ci|chore)(?:\(([^)]+)\))?(!)?: .+)/

// Commit types that support any change rather than adding scope of their own: a feature's tests, its
// docs, the CI wiring it needs. A refactor, perf tweak, or second feature is scope of its own.
const SUPPORTING_TYPES = new Set(['test', 'docs', 'ci', 'bench', 'chore'])

// Title types under which a whitespace-only or pure-rename change is the point of the PR.
const FORMATTING_TITLE_TYPES = new Set(['style', 'chore'])
const RENAME_TITLE_TYPES = new Set(['style', 'chore', 'refactor', 'build', 'ci', 'test'])

// Development leftovers. Anything matching these is a scratch artifact no PR title covers.
const SCRATCH_PATTERNS = [
  /^[^/]+\.(?:html|log)$/, // Reports and logs dropped at the repository root
  /(?:^|\/)\.(?:claude|cursor|aider|pi-subagents|agents-local)\//, // Agent-tool state directories
  /(?:^|\/)(?:scratch|tmp|temp)[-_.][^/]*$/, // scratch-notes.md, tmp.out, temp_script.js
  /\.(?:orig|rej|bak|swp|swo)$/, // Merge and editor leftovers
  /(?:^|\/)\.DS_Store$/,
  /(?:^|\/)(?:npm|yarn)-debug\.log/,
  /(?:^|\/)core\.\d+$/, // Crash dumps
]

/**
 * @param {string} subject
 * @returns {ConventionalSubject | undefined} Undefined when the subject isn't conventional (local WIP
 *   commits are ignored: the squash-merge subject comes from the PR title, not from them).
 */
function parseConventionalSubject (subject) {
  const match = CONVENTIONAL_SUBJECT.exec(subject)
  if (!match) return
  const [, revertBreaking, type, scope] = match
  if (revertBreaking !== undefined || type === undefined) return { type: 'revert' }
  return { type: /** @type {CommitType} */ (type), scope }
}

/**
 * @param {string} patch Unified diff for a single file.
 * @returns {boolean} True when added and removed lines differ only in whitespace.
 */
function isWhitespaceOnlyPatch (patch) {
  const added = []
  const removed = []

  for (const line of patch.split('\n')) {
    const marker = line[0]
    if (marker !== '+' && marker !== '-') continue
    if (line.startsWith('+++') || line.startsWith('---')) continue

    // Comparing the sequences rather than the sets keeps a pure reorder (same lines, different order)
    // out of this rule: it is a real change, just not a whitespace one.
    ;(marker === '+' ? added : removed).push(line.slice(1).replaceAll(/\s+/g, ''))
  }

  if (added.length === 0 || added.length !== removed.length) return false
  return added.every((line, index) => line === removed[index])
}

/**
 * @param {ConventionalSubject} title
 * @param {string[]} commitSubjects
 * @returns {ScopeViolation[]}
 */
function findCommitTypeViolations (title, commitSubjects) {
  const violations = []

  for (const subject of commitSubjects) {
    const commit = parseConventionalSubject(subject)
    if (!commit) continue

    if (commit.type !== title.type) {
      if (SUPPORTING_TYPES.has(commit.type)) continue
      violations.push({
        rule: 'mixed-commit-type',
        message: `Commit "${subject}" is a ${commit.type} change, but the PR is a ${title.type}. ` +
          'Land it as its own PR.',
      })
      continue
    }

    if (title.scope && commit.scope && commit.scope !== title.scope) {
      violations.push({
        rule: 'mixed-commit-scope',
        message: `Commit "${subject}" targets scope "${commit.scope}", but the PR title targets ` +
          `"${title.scope}". Split it out or widen the PR title only if both are one change.`,
      })
    }
  }

  return violations
}

/**
 * @param {ConventionalSubject} title
 * @param {PullRequestFile[]} files
 * @returns {ScopeViolation[]}
 */
function findFileViolations (title, files) {
  const violations = []

  for (const file of files) {
    if (file.status === 'added' && SCRATCH_PATTERNS.some((pattern) => pattern.test(file.filename))) {
      violations.push({
        rule: 'scratch-artifact',
        message: `${file.filename} looks like a development leftover. Remove it from the PR.`,
      })
      continue
    }

    if (file.status === 'renamed' && file.changes === 0 && !RENAME_TITLE_TYPES.has(title.type)) {
      violations.push({
        rule: 'rename-only-file',
        message: `${file.filename} is a pure move from ${file.previous_filename} with no content change, ` +
          `which a ${title.type} PR shouldn't carry. Land the move separately.`,
      })
      continue
    }

    if (file.status === 'modified' && file.patch && !FORMATTING_TITLE_TYPES.has(title.type) &&
        isWhitespaceOnlyPatch(file.patch)) {
      violations.push({
        rule: 'formatting-only-file',
        message: `${file.filename} only changes whitespace, which a ${title.type} PR shouldn't carry. ` +
          'Land formatting separately.',
      })
    }
  }

  return violations
}

/**
 * @param {object} pullRequest
 * @param {string} pullRequest.title
 * @param {string[]} pullRequest.commitSubjects First line of every commit on the branch.
 * @param {PullRequestFile[]} pullRequest.files
 * @returns {ScopeViolation[]} Empty when every change is justifiable by the title.
 */
function findScopeViolations ({ title, commitSubjects, files }) {
  const parsedTitle = parseConventionalSubject(title)
  // A non-conventional or revert title is the conventional-commit check's problem, not this one's.
  if (!parsedTitle || parsedTitle.type === 'revert') return []

  return [
    ...findCommitTypeViolations(parsedTitle, commitSubjects),
    ...findFileViolations(parsedTitle, files),
  ]
}

/**
 * Workflow entry point: reports scope violations on the pull request in context, failing the step when
 * any are found.
 *
 * @param {StepBindings} bindings
 * @returns {Promise<void>}
 */
async function reportScopeViolations ({ context, core, github }) {
  const pullRequest = context.payload.pull_request
  if ((pullRequest.labels || []).some(({ name }) => name === EXCEPTION_LABEL)) {
    core.notice(`Skipping PR scope checks: the ${EXCEPTION_LABEL} label is applied.`)
    return
  }

  const listAll = (endpoint) => github.paginate(endpoint, {
    ...context.repo,
    pull_number: pullRequest.number,
    per_page: 100,
  })
  const [files, commits] = await Promise.all([
    listAll(github.rest.pulls.listFiles),
    listAll(github.rest.pulls.listCommits),
  ])

  const violations = findScopeViolations({
    title: pullRequest.title || '',
    commitSubjects: commits.map(({ commit }) => commit.message.split('\n', 1)[0]),
    files,
  })

  if (violations.length === 0) {
    core.info('PR scope OK.')
    return
  }

  for (const { rule, message } of violations) {
    core.error(message, { title: `PR scope: ${rule}` })
  }
  core.setFailed(`${violations.length} change(s) in this PR are not covered by its title. ` +
    `Split them into follow-up PRs, or apply the ${EXCEPTION_LABEL} label with a justification.`)
}

module.exports = {
  EXCEPTION_LABEL,
  findScopeViolations,
  isWhitespaceOnlyPatch,
  parseConventionalSubject,
  reportScopeViolations,
}
