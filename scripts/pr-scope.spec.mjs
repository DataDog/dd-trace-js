import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const {
  EXCEPTION_LABEL,
  findScopeViolations,
  isWhitespaceOnlyPatch,
  parseConventionalSubject,
  reportScopeViolations,
} = require('./pr-scope.js')

const modified = (filename, patch) => ({ filename, status: 'modified', changes: 2, patch })

const bindings = ({ title, labels = [], commits = [], files = [] }) => {
  const recorded = { errors: [], failures: [], notices: [], infos: [] }
  const listFiles = Symbol('listFiles')
  const listCommits = Symbol('listCommits')

  return {
    recorded,
    context: {
      repo: { owner: 'DataDog', repo: 'dd-trace-js' },
      payload: { pull_request: { number: 1, title, labels } },
    },
    core: {
      info: (message) => recorded.infos.push(message),
      notice: (message) => recorded.notices.push(message),
      error: (message, properties) => recorded.errors.push({ message, ...properties }),
      setFailed: (message) => recorded.failures.push(message),
    },
    github: {
      paginate: (endpoint, options) => {
        assert.deepStrictEqual(options, { owner: 'DataDog', repo: 'dd-trace-js', pull_number: 1, per_page: 100 })
        return Promise.resolve(endpoint === listFiles ? files : commits)
      },
      rest: { pulls: { listFiles, listCommits } },
    },
  }
}

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']

describe('PR scope checks', () => {
  it('is wired into the PR title workflow', () => {
    const step = job.steps.find(({ name }) => name === 'Validate PR scope')

    assert.notStrictEqual(step, undefined)
    assert.strictEqual(
      step.with.script.trim(),
      "await require('./scripts/pr-scope.js').reportScopeViolations({ context, core, github })"
    )
  })

  it('shares the conventional-commit pattern with the PR title workflow', () => {
    const { PR_TITLE_PATTERN } = job.env
    const [accepted, rejected] = [
      ['feat(appsec): add rule', 'revert: feat(appsec): add rule', 'chore!: drop node 18'],
      ['add a rule', 'nope(appsec): add rule', ''],
    ]

    for (const title of accepted) {
      assert.ok(new RegExp(PR_TITLE_PATTERN).test(title), `${title} should match the workflow pattern`)
      assert.notStrictEqual(parseConventionalSubject(title), undefined, `${title} should parse`)
    }
    for (const title of rejected) {
      assert.ok(!new RegExp(PR_TITLE_PATTERN).test(title), `${title} should not match the workflow pattern`)
      assert.strictEqual(parseConventionalSubject(title), undefined, `${title} should not parse`)
    }
  })

  it('parses type, scope, and reverts', () => {
    assert.deepStrictEqual(parseConventionalSubject('fix(pg): stop leaking'), { type: 'fix', scope: 'pg' })
    assert.deepStrictEqual(parseConventionalSubject('perf!: drop the cache'), { type: 'perf', scope: undefined })
    assert.deepStrictEqual(parseConventionalSubject('revert: fix(pg): stop leaking'), { type: 'revert' })
    assert.deepStrictEqual(parseConventionalSubject('revert!: fix(pg): stop leaking'), { type: 'revert' })
  })

  it('ignores non-conventional and revert titles', () => {
    const files = [{ filename: 'notes.html', status: 'added', changes: 1 }]

    for (const title of ['wip', 'revert: fix(pg): stop leaking']) {
      assert.deepStrictEqual(findScopeViolations({ title, commitSubjects: ['refactor(pg): tidy'], files }), [])
    }
  })

  it('accepts a PR whose commits all serve the title', () => {
    const violations = findScopeViolations({
      title: 'feat(pg): report query plans',
      commitSubjects: [
        'feat(pg): report query plans',
        'test(pg): cover query plan reporting',
        'docs: document query plans',
        'wip',
      ],
      files: [
        { filename: 'packages/datadog-plugin-pg/src/index.js', status: 'modified', changes: 20, patch: '@@\n+plan\n' },
        { filename: 'packages/datadog-plugin-pg/test/index.spec.js', status: 'added', changes: 30 },
      ],
    })

    assert.deepStrictEqual(violations, [])
  })

  it('flags a commit whose type is scope of its own, but not supporting types', () => {
    const violations = findScopeViolations({
      title: 'fix(pg): stop leaking connections',
      commitSubjects: [
        'fix(pg): stop leaking connections',
        'refactor(pg): extract a helper',
        'perf(pg): reuse the buffer',
        'chore(pg): bump a comment',
      ],
      files: [],
    })

    assert.deepStrictEqual(violations.map(({ rule }) => rule), ['mixed-commit-type', 'mixed-commit-type'])
    assert.match(violations[0].message, /refactor(.+)but the PR is a fix/)
  })

  it('flags a commit that targets a different scope', () => {
    const violations = findScopeViolations({
      title: 'fix(pg): stop leaking connections',
      commitSubjects: ['fix(pg): stop leaking connections', 'fix(kafkajs): stop leaking connections'],
      files: [],
    })

    assert.deepStrictEqual(violations.map(({ rule }) => rule), ['mixed-commit-scope'])
    assert.match(violations[0].message, /"kafkajs"/)
  })

  it('accepts an unscoped commit under a scoped title', () => {
    const violations = findScopeViolations({
      title: 'fix(pg): stop leaking connections',
      commitSubjects: ['fix: stop leaking connections'],
      files: [],
    })

    assert.deepStrictEqual(violations, [])
  })

  it('flags whitespace-only file changes unless the title is about formatting', () => {
    const patch = '@@ -1,2 +1,2 @@\n-const a = 1\n-  const b = 2\n+const  a  =  1\n+const b = 2\n'
    const files = [modified('packages/dd-trace/src/index.js', patch)]

    assert.deepStrictEqual(
      findScopeViolations({ title: 'fix(core): stop leaking', commitSubjects: [], files })
        .map(({ rule }) => rule),
      ['formatting-only-file']
    )
    for (const title of ['style(core): reformat', 'chore(core): reformat']) {
      assert.deepStrictEqual(findScopeViolations({ title, commitSubjects: [], files }), [])
    }
  })

  it('does not treat semantic changes or additions as whitespace-only', () => {
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-const a = 1\n+const a = 2\n'), false)
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n+const a = 1\n'), false)
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-const a = 1\n'), false)
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n+++ b/a.js\n--- a/a.js\n'), false)
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-const a = 1\n+  const a = 1\n'), true)
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-\n+  \n'), true)
    // A reorder keeps the same lines, but it is a real change rather than a whitespace one.
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-const a = 1\n-const b = 2\n+const b = 2\n+const a = 1\n'), false)
    // Uneven hunks (a reindent that also drops a line) fall out of this rule rather than guessing.
    assert.strictEqual(isWhitespaceOnlyPatch('@@\n-const a = 1\n-const b = 2\n+  const a = 1\n'), false)
  })

  it('flags pure renames only under titles that are not about moving files', () => {
    const files = [{
      filename: 'packages/dd-trace/src/b.js',
      previous_filename: 'packages/dd-trace/src/a.js',
      status: 'renamed',
      changes: 0,
    }]

    for (const title of ['fix(core): stop leaking', 'feat(core): add a thing', 'docs: explain a thing']) {
      assert.deepStrictEqual(
        findScopeViolations({ title, commitSubjects: [], files }).map(({ rule }) => rule),
        ['rename-only-file'],
        title
      )
    }
    for (const title of ['refactor(core): move a.js', 'chore: move a.js', 'test: move a spec']) {
      assert.deepStrictEqual(findScopeViolations({ title, commitSubjects: [], files }), [], title)
    }
  })

  it('accepts a rename that also changes content', () => {
    const violations = findScopeViolations({
      title: 'fix(core): stop leaking',
      commitSubjects: [],
      files: [{
        filename: 'packages/dd-trace/src/b.js',
        previous_filename: 'packages/dd-trace/src/a.js',
        status: 'renamed',
        changes: 4,
        patch: '@@\n-const a = 1\n+const a = 2\n',
      }],
    })

    assert.deepStrictEqual(violations, [])
  })

  it('flags added scratch artifacts', () => {
    const scratch = [
      'report.html',
      'debug.log',
      '.claude/settings.json',
      'packages/dd-trace/.pi-subagents/artifacts/out.md',
      'scratch-notes.md',
      'packages/dd-trace/tmp.out',
      'packages/dd-trace/src/index.js.orig',
      '.DS_Store',
      'npm-debug.log.1',
      'core.12345',
    ]

    for (const filename of scratch) {
      assert.deepStrictEqual(
        findScopeViolations({
          title: 'fix(core): stop leaking',
          commitSubjects: [],
          files: [{ filename, status: 'added', changes: 1 }],
        }).map(({ rule }) => rule),
        ['scratch-artifact'],
        filename
      )
    }
  })

  it('does not flag legitimate files that resemble scratch artifacts', () => {
    const legitimate = [
      'packages/dd-trace/test/fixtures/page.html',
      'docs/index.html',
      'packages/dd-trace/src/templates/log.js',
      'integration-tests/temperature.js',
      'packages/datadog-plugin-http/src/client.js',
    ]

    for (const filename of legitimate) {
      assert.deepStrictEqual(
        findScopeViolations({
          title: 'fix(core): stop leaking',
          commitSubjects: [],
          files: [{ filename, status: 'added', changes: 1 }],
        }),
        [],
        filename
      )
    }
  })

  it('does not flag scratch-looking paths that were only modified or removed', () => {
    for (const status of ['modified', 'removed']) {
      assert.deepStrictEqual(
        findScopeViolations({
          title: 'fix(core): stop leaking',
          commitSubjects: [],
          files: [{ filename: 'report.html', status, changes: 1 }],
        }),
        []
      )
    }
  })
})

describe('PR scope workflow step', () => {
  it('passes a PR whose changes serve its title', async () => {
    const { recorded, ...step } = bindings({
      title: 'fix(pg): stop leaking connections',
      commits: [{ commit: { message: 'fix(pg): stop leaking connections\n\nBody line.' } }],
      files: [modified('packages/datadog-plugin-pg/src/index.js', '@@\n+a\n')],
    })

    await reportScopeViolations(step)

    assert.deepStrictEqual(recorded.failures, [])
    assert.deepStrictEqual(recorded.infos, ['PR scope OK.'])
  })

  it('annotates every violation and fails the step', async () => {
    const { recorded, ...step } = bindings({
      title: 'fix(pg): stop leaking connections',
      commits: [{ commit: { message: 'refactor(pg): extract a helper' } }],
      files: [{ filename: 'report.html', status: 'added', changes: 1 }],
    })

    await reportScopeViolations(step)

    assert.deepStrictEqual(
      recorded.errors.map(({ title }) => title),
      ['PR scope: mixed-commit-type', 'PR scope: scratch-artifact']
    )
    assert.strictEqual(recorded.failures.length, 1)
    assert.match(recorded.failures[0], /^2 change\(s\) in this PR are not covered by its title\./)
    assert.match(recorded.failures[0], new RegExp(EXCEPTION_LABEL))
  })

  it('skips every check when the exception label is applied', async () => {
    const { recorded, ...step } = bindings({
      title: 'fix(pg): stop leaking connections',
      labels: [{ name: 'semver-patch' }, { name: EXCEPTION_LABEL }],
      commits: [{ commit: { message: 'refactor(pg): extract a helper' } }],
      files: [{ filename: 'report.html', status: 'added', changes: 1 }],
    })

    await reportScopeViolations(step)

    assert.deepStrictEqual(recorded.failures, [])
    assert.deepStrictEqual(recorded.errors, [])
    assert.deepStrictEqual(recorded.notices, [`Skipping PR scope checks: the ${EXCEPTION_LABEL} label is applied.`])
  })
})
