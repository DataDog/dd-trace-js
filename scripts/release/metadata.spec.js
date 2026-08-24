'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_FULL_SHA = '89abcdef0123456789abcdef0123456789abcdef'

/**
 * @param {sinon.SinonStub} capture
 */
function loadMetadata (capture) {
  return proxyquire('./metadata', {
    './helpers/terminal': { capture },
  })
}

describe('release metadata', () => {
  it('hydrates pull request context and keeps only human contributors', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(`${FULL_SHA}\n${OTHER_FULL_SHA}`)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: {
              nodes: [
                { name: 'Alice', email: 'alice@example.com', user: { login: 'alice' } },
                { name: 'Dependabot', email: 'bot@example.com', user: { login: 'dependabot[bot]' } },
                { name: 'Dependabot', email: 'bot@example.com', user: { login: 'dependabot' } },
                { name: 'Claude', email: 'noreply@anthropic.com', user: { login: 'claude' } },
                {
                  name: 'Copilot Autofix powered by AI',
                  email: '175728472+Copilot@users.noreply.github.com',
                },
                { name: 'Cursor', email: 'cursoragent@cursor.com' },
                {},
                {
                  name: 'Carles Capell',
                  email: '107924659+CarlesDD@users.noreply.github.com',
                  user: { login: 'CarlesDD' },
                },
                { name: 'Claude Shannon', email: 'shannon@example.com', user: { login: 'claude-shannon' } },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
          pullRequest0: {
            __typename: 'PullRequest',
            number: 123,
            title: 'fix(core): preserve the complete pull request context',
            author: { __typename: 'User', login: 'pull-request-author' },
            labels: {
              nodes: [{ name: 'appsec' }, { name: 'ai-guard' }],
              pageInfo: { hasNextPage: false },
            },
            files: {
              nodes: [{ path: 'first-page.js', changeType: 'MODIFIED' }],
              pageInfo: { hasNextPage: true },
            },
          },
          commit1: {
            authors: {
              nodes: [
                { name: 'Jane Doe', email: 'jane@example.com' },
                { name: 'No Email' },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    capture.onThirdCall().returns(JSON.stringify([
      [{ filename: 'first-page.js', previous_filename: 'previous-first-page.js' }],
      [{ filename: 'second-page.js' }],
    ]))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.deepStrictEqual(hydrateReleaseEntries([
      { commitRef: '0123456789', pullRequestNumber: 123, subject: 'fix(core): preserve context (#123)' },
      { commitRef: '89abcdef01', subject: 'fix(core): preserve direct commit context' },
    ]), [
      {
        sha: FULL_SHA,
        subject: 'fix(core): preserve the complete pull request context (#123)',
        contributors: [
          { name: '@alice', login: 'alice' },
          { name: '@CarlesDD', login: 'CarlesDD' },
          { name: '@claude-shannon', login: 'claude-shannon' },
          { name: '@pull-request-author', login: 'pull-request-author' },
        ],
        labels: ['appsec', 'ai-guard'],
        files: ['first-page.js', 'previous-first-page.js', 'second-page.js'],
      },
      {
        sha: OTHER_FULL_SHA,
        subject: 'fix(core): preserve direct commit context',
        contributors: [{ name: 'Jane Doe' }, { name: 'No Email' }],
      },
    ])
    assert.strictEqual(capture.firstCall.args[0], 'git rev-parse 0123456789 89abcdef01')
    assert.match(capture.secondCall.args[0], /pullRequest0: issueOrPullRequest\(number: 123\)/)
    assert.strictEqual(
      capture.thirdCall.args[0],
      'gh api "repos/DataDog/dd-trace-js/pulls/123/files?per_page=100" --paginate --slurp'
    )
  })

  it('skips metadata requests when there are no release entries', () => {
    const capture = sinon.stub()
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.deepStrictEqual(hydrateReleaseEntries([]), [])
    assert.strictEqual(capture.callCount, 0)
  })

  it('uses the GraphQL file page when it is complete', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: { authors: { nodes: [], pageInfo: { hasNextPage: false } } },
          pullRequest0: {
            __typename: 'PullRequest',
            number: 123,
            title: 'fix(core): preserve context',
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            files: {
              nodes: [{ path: 'packages/dd-trace/src/index.js', changeType: 'MODIFIED' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { commitRef: '0123456789', pullRequestNumber: 123, subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries[0].files, ['packages/dd-trace/src/index.js'])
    assert.strictEqual(capture.callCount, 2)
  })

  it('uses the REST file pages when a file was renamed', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: { authors: { nodes: [], pageInfo: { hasNextPage: false } } },
          pullRequest0: {
            __typename: 'PullRequest',
            number: 123,
            title: 'fix(core): move context metadata',
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            files: {
              nodes: [{ path: 'scripts/release/metadata.js', changeType: 'RENAMED' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    capture.onThirdCall().returns(JSON.stringify([[
      {
        filename: 'scripts/release/metadata.js',
        previous_filename: 'packages/dd-trace/src/metadata.js',
      },
    ]]))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { commitRef: '0123456789', pullRequestNumber: 123, subject: 'fix(core): move context metadata (#123)' },
    ])

    assert.deepStrictEqual(entries[0].files, [
      'scripts/release/metadata.js',
      'packages/dd-trace/src/metadata.js',
    ])
  })

  it('keeps commit metadata when a reference resolves to an issue', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: {
              nodes: [{ name: 'Jane Doe', email: 'jane@example.com' }],
              pageInfo: { hasNextPage: false },
            },
          },
          pullRequest0: { __typename: 'Issue' },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { commitRef: '0123456789', pullRequestNumber: 9648, subject: 'fix(core): preserve context (#9648)' },
    ])

    assert.deepStrictEqual(entries, [{
      sha: FULL_SHA,
      subject: 'fix(core): preserve context (#9648)',
      contributors: [{ name: 'Jane Doe' }],
    }])
  })

  it('omits bot pull request authors without a merge commit', () => {
    const capture = sinon.stub().returns(JSON.stringify({
      data: {
        repository: {
          pullRequest0: {
            __typename: 'PullRequest',
            number: 123,
            title: 'feat(core)!: remove legacy context',
            author: { __typename: 'Bot', login: 'gh-worker-campaigns-3e9aa4' },
            labels: { nodes: [{ name: 'appsec' }], pageInfo: { hasNextPage: false } },
            files: {
              nodes: [{ path: 'packages/dd-trace/src/index.js', changeType: 'MODIFIED' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { pullRequestNumber: 123, subject: 'feat(core)!: remove legacy context (#123)' },
    ])

    assert.deepStrictEqual(entries, [{
      sha: 'pull-request-123',
      subject: 'feat(core)!: remove legacy context (#123)',
      contributors: [],
      labels: ['appsec'],
      files: ['packages/dd-trace/src/index.js'],
    }])
    assert.doesNotMatch(capture.firstCall.args[0], /commit0:/)
    assert.match(capture.firstCall.args[0], /author \{ __typename login \}/)
  })

  it('rejects truncated contributor and label metadata', () => {
    const truncatedPages = [
      { authors: true, labels: false },
      { authors: false, labels: true },
    ]

    for (const { authors, labels } of truncatedPages) {
      const capture = sinon.stub()
      capture.onFirstCall().returns(FULL_SHA)
      capture.onSecondCall().returns(JSON.stringify({
        data: {
          repository: {
            commit0: { authors: { nodes: [], pageInfo: { hasNextPage: authors } } },
            pullRequest0: {
              __typename: 'PullRequest',
              number: 123,
              title: 'fix(core): preserve context',
              labels: { nodes: [], pageInfo: { hasNextPage: labels } },
              files: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      }))
      const { hydrateReleaseEntries } = loadMetadata(capture)

      assert.throws(
        () => hydrateReleaseEntries([
          { commitRef: '0123456789', pullRequestNumber: 123, subject: 'fix(core): preserve context (#123)' },
        ]),
        { message: `GitHub metadata for ${FULL_SHA} exceeds one page.` }
      )
    }
  })

  it('reports GraphQL errors', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({ errors: [{ message: 'rate limit exceeded' }] }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.throws(
      () => hydrateReleaseEntries([{ commitRef: '0123456789', subject: 'fix(core): preserve context' }]),
      { message: 'GitHub metadata query failed: rate limit exceeded' }
    )
  })
})
