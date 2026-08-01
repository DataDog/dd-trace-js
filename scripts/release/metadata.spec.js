'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

describe('release metadata', () => {
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
              ],
              pageInfo: { hasNextPage: false },
            },
            associatedPullRequests: {
              nodes: [
                { number: 999, author: { login: 'wrong-owner' } },
                { number: 123, author: { login: 'alice' } },
              ],
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = proxyquire('./metadata', {
      './helpers/terminal': { capture },
    })

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries, [{
      sha: FULL_SHA,
      subject: 'fix(core): preserve context (#123)',
      contributors: [
        { name: '@alice', login: 'alice' },
        { name: '@claude-shannon', login: 'claude-shannon' },
        { name: 'Jane Doe' },
      ],
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
            associatedPullRequests: {
              nodes: [{ number: 123, author: { login: 'pull-request-author' } }],
            },
          },
        },
      },
    }))
    const { hydrateReleaseEntries } = proxyquire('./metadata', {
      './helpers/terminal': { capture },
    })

    const entries = hydrateReleaseEntries([
      { sha: '0123456789', subject: 'fix(core): preserve context (#123)' },
    ])

    assert.deepStrictEqual(entries[0].contributors, [
      { name: '@pull-request-author', login: 'pull-request-author' },
    ])
  })

  it('fails when GitHub does not return metadata for a release commit', () => {
    const capture = sinon.stub()
    capture.onFirstCall().returns(FULL_SHA)
    capture.onSecondCall().returns(JSON.stringify({
      data: { repository: { commit0: undefined } },
    }))
    const { hydrateReleaseEntries } = proxyquire('./metadata', {
      './helpers/terminal': { capture },
    })

    assert.throws(
      () => hydrateReleaseEntries([{ sha: '0123456789', subject: 'fix(core): preserve context (#123)' }]),
      { message: `GitHub did not return metadata for ${FULL_SHA}.` }
    )
  })

  it('rejects invalid release commit SHAs before invoking a shell', () => {
    const capture = sinon.stub()
    const { hydrateReleaseEntries } = proxyquire('./metadata', {
      './helpers/terminal': { capture },
    })

    assert.throws(
      () => hydrateReleaseEntries([{ sha: 'HEAD; touch unexpected', subject: 'fix(core): preserve context' }]),
      { message: 'Invalid release commit SHA: HEAD; touch unexpected' }
    )
    assert.strictEqual(capture.callCount, 0)
  })
})
