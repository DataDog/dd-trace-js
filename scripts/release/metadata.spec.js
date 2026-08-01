'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

/**
 * @param {sinon.SinonStub} capture
 * @returns {import('./metadata')}
 */
function loadMetadata (capture) {
  return proxyquire('./metadata', {
    './helpers/terminal': { capture },
  })
}

/**
 * @param {object} response
 * @param {string} message
 * @param {string} [subject]
 * @returns {void}
 */
function assertMetadataFailure (response, message, subject = 'fix(core): preserve context (#123)') {
  const capture = sinon.stub()
  capture.onFirstCall().returns(FULL_SHA)
  capture.onSecondCall().returns(JSON.stringify(response))
  const { hydrateReleaseEntries } = loadMetadata(capture)

  assert.throws(
    () => hydrateReleaseEntries([{ sha: '0123456789', subject }]),
    { message }
  )
}

describe('release metadata', () => {
  it('skips metadata requests when there are no release entries', () => {
    const capture = sinon.stub()
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.deepStrictEqual(hydrateReleaseEntries([]), [])
    assert.strictEqual(capture.callCount, 0)
  })

  it('resolves abbreviated SHAs and preserves only human authors and co-authors', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: {
              nodes: [
                { name: 'Dependabot', email: 'bot@example.com', user: { login: 'dependabot[bot]' } },
                { name: 'Dependabot', email: 'bot@example.com', user: { login: 'dependabot' } },
                { name: 'Alice', email: 'alice@example.com', user: { login: 'alice' } },
                { name: 'Claude', email: 'claude@example.com', user: { login: 'claude' } },
                { name: 'Claude Opus', email: 'noreply@anthropic.com', user: undefined },
                { name: 'Copilot', email: 'copilot@example.com', user: { login: 'Copilot' } },
                {
                  name: 'Copilot Autofix powered by AI',
                  email: '175728472+Copilot@users.noreply.github.com',
                  user: undefined,
                },
                { name: 'Cursor', email: 'cursor@example.com', user: { login: 'cursoragent' } },
                { name: 'Cursor', email: 'cursoragent@cursor.com', user: undefined },
                { name: 'Claude Shannon', email: 'shannon@example.com', user: { login: 'claude-shannon' } },
                { name: 'Jane Doe', email: 'jane@example.com', user: undefined },
                { name: 'No Email', user: undefined },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
          pullRequest0: {
            number: 123,
            title: 'fix(core): preserve the complete pull request context',
            author: { login: 'alice' },
            labels: {
              nodes: [{ name: 'appsec' }, { name: 'ai-guard' }],
              pageInfo: { hasNextPage: false },
            },
            files: {
              nodes: [{ path: 'packages/dd-trace/src/index.js' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries, [{
      sha: FULL_SHA,
      subject: 'fix(core): preserve the complete pull request context (#123)',
      contributors: [
        { name: '@alice', login: 'alice' },
        { name: '@claude-shannon', login: 'claude-shannon' },
        { name: 'Jane Doe' },
        { name: 'No Email' },
      ],
      labels: ['appsec', 'ai-guard'],
      files: ['packages/dd-trace/src/index.js'],
    }])
    assert.strictEqual(capture.firstCall.args[0], 'git rev-parse 0123456789')
    assert.match(capture.secondCall.args[0], new RegExp(String.raw`object\(oid: "${FULL_SHA}"\)`))
  })

  it('adds a human pull request author when they are not a commit author', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: { nodes: [], pageInfo: { hasNextPage: false } },
          },
          pullRequest0: {
            number: 123,
            title: 'fix(core): preserve context',
            author: { login: 'pull-request-author' },
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            files: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries[0].contributors, [
      { name: '@pull-request-author', login: 'pull-request-author' },
    ])
  })

  it('falls back to commit metadata when no pull request matches the subject', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: {
              nodes: [{ name: 'Alice', email: 'alice@example.com', user: { login: 'alice' } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context' },
    ])

    assert.deepStrictEqual(entries, [{
      sha: FULL_SHA,
      subject: 'fix(core): preserve context',
      contributors: [{ name: '@alice', login: 'alice' }],
    }])
  })

  it('loads every changed file when a pull request exceeds one GraphQL page', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: {
        repository: {
          commit0: {
            authors: { nodes: [], pageInfo: { hasNextPage: false } },
          },
          pullRequest0: {
            number: 123,
            title: 'fix(core): preserve context',
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            files: {
              nodes: [{ path: 'first-page.js' }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      },
    }))
    capture.onThirdCall().returns(JSON.stringify([
      [{ filename: 'first-page.js' }],
      [{ filename: 'second-page.js' }],
    ]))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries[0].files, ['first-page.js', 'second-page.js'])
    assert.strictEqual(
      capture.thirdCall.args[0],
      'gh api "repos/DataDog/dd-trace-js/pulls/123/files?per_page=100" --paginate --slurp'
    )
  })

  it('fails when GitHub does not return metadata for a release commit', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: { repository: { commit0: undefined } },
    }))
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.throws(
      () => hydrateReleaseEntries([{ sha: '0123456789', subject: 'fix(core): preserve context (#123)' }]),
      { message: `GitHub did not return metadata for ${FULL_SHA}.` }
    )
  })

  it('fails when git resolves a different number of release commits', () => {
    const capture = sinon.stub().returns(`${FULL_SHA}\n${FULL_SHA}`)
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.throws(
      () => hydrateReleaseEntries([{ sha: '0123456789', subject: 'fix(core): preserve context (#123)' }]),
      { message: 'Resolved 2 release SHAs for 1 entries.' }
    )
  })

  it('fails closed when GitHub metadata is incomplete', () => {
    assertMetadataFailure(
      { errors: [{ message: 'rate limit exceeded' }] },
      'GitHub metadata query failed: rate limit exceeded'
    )
    assertMetadataFailure({
      data: {
        repository: {
          commit0: {
            authors: { nodes: [], pageInfo: { hasNextPage: true } },
          },
        },
      },
    }, `Commit ${FULL_SHA} has more than 100 authors.`)
    assertMetadataFailure({
      data: {
        repository: {
          commit0: {
            authors: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    }, 'GitHub did not return pull request #123.')
    assertMetadataFailure({
      data: {
        repository: {
          commit0: {
            authors: { nodes: [], pageInfo: { hasNextPage: false } },
          },
          pullRequest0: {
            number: 123,
            title: 'fix(core): preserve context',
            labels: { nodes: [], pageInfo: { hasNextPage: true } },
            files: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    }, 'Pull request #123 has more than 100 labels.')
  })

  it('rejects invalid release commit SHAs before invoking a shell', () => {
    const capture = sinon.stub()
    const { hydrateReleaseEntries } = loadMetadata(capture)

    assert.throws(
      () => hydrateReleaseEntries([{ sha: 'HEAD; touch unexpected', subject: 'fix(core): preserve context' }]),
      { message: 'Invalid release commit SHA: HEAD; touch unexpected' }
    )
    assert.strictEqual(capture.callCount, 0)
  })
})
