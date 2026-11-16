'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('Cypress selected checkout context', () => {
  it('preserves an explicit PR-head SHA and commit message in custom checkout requests', () => {
    const head = 'b'.repeat(40)
    const plugin = proxyquire('../../packages/datadog-plugin-cypress/src/cypress-plugin', {
      '../../dd-trace/src/plugins/util/user-provided-git': {
        getUserProviderGitMetadata: () => ({ 'git.commit.head.sha': head }),
      },
      '../../dd-trace/src/plugins/util/test': {
        getTestEnvironmentMetadata: () => ({
          'git.checkout.root': process.cwd(),
          'git.checkout.is_custom': 'true',
          'git.commit.head.sha': head,
          'git.commit.head.message': 'outer PR message',
          'git.commit.message': 'explicit commit message',
        }),
        getCodeOwnersFileEntries: () => [],
      },
    })

    assert.strictEqual(plugin.testConfiguration.commitHeadSha, head)
    assert.strictEqual(plugin.testConfiguration.commitHeadMessage, undefined)
    assert.strictEqual(plugin.testConfiguration.commitMessage, 'explicit commit message')
  })

  for (const hasBaseSha of [false, true]) {
    it(`keeps modified-file Git reads in the selected root (hasBaseSha=${hasBaseSha})`, async () => {
      const root = path.join(process.cwd(), 'tools')
      const stop = new Error('stop after modified-file discovery')
      const getPullRequestBaseBranch = sinon.stub().returns('base-sha')
      const getPullRequestDiff = sinon.stub().returns('selected-diff')
      const plugin = proxyquire('../../packages/datadog-plugin-cypress/src/cypress-plugin', {
        '../../dd-trace/src/plugins/util/test': {
          getTestEnvironmentMetadata: () => ({
            'git.checkout.root': root,
            'ci.workspace_path': process.cwd(),
            'git.pull_request.base_branch': 'main',
            'git.pull_request.base_branch_sha': hasBaseSha ? 'base-sha' : undefined,
            'git.commit.head.sha': 'head-sha',
          }),
          getCodeOwnersFileEntries: () => [],
          getPullRequestBaseBranch,
          getPullRequestDiff,
          getModifiedFilesFromDiff: () => ['cypress/e2e/test.cy.js'],
          getTestParentSpan: () => { throw stop },
        },
      })
      plugin._isInit = true
      plugin.isImpactedTestsEnabled = true

      await assert.rejects(plugin.beforeRun({}), error => error === stop)

      assert.deepStrictEqual(plugin.modifiedFiles, ['cypress/e2e/test.cy.js'])
      sinon.assert.calledOnceWithExactly(getPullRequestDiff, 'base-sha', 'head-sha', root)
      if (hasBaseSha) sinon.assert.notCalled(getPullRequestBaseBranch)
      else sinon.assert.calledOnceWithExactly(getPullRequestBaseBranch, 'main', root)
    })
  }

  for (const custom of [false, true]) {
    it(`uses the selected root and scopes PR-head request overrides (custom=${custom})`, () => {
      const root = path.join(process.cwd(), 'tools')
      const metadata = {
        'git.checkout.root': root,
        'git.checkout.is_custom': custom ? 'true' : undefined,
        'ci.workspace_path': process.cwd(),
        'git.repository_url': 'https://example.com/tools.git',
        'git.commit.sha': 'selected-sha',
        'git.commit.message': 'selected message',
        'git.commit.head.sha': 'outer-pr-head',
        'git.commit.head.message': 'outer PR message',
      }
      const getCodeOwnersFileEntries = sinon.stub().returns([])
      const plugin = proxyquire('../../packages/datadog-plugin-cypress/src/cypress-plugin', {
        '../../dd-trace/src/plugins/util/test': {
          getTestEnvironmentMetadata: () => metadata,
          getCodeOwnersFileEntries,
        },
      })

      assert.strictEqual(plugin.repositoryRoot, root)
      assert.strictEqual(plugin.getCoverageRootDir(), root)
      sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, root)
      assert.strictEqual(plugin.testConfiguration.gitRoot, root)
      assert.strictEqual(plugin.testConfiguration.repositoryUrl, metadata['git.repository_url'])
      assert.strictEqual(plugin.testConfiguration.sha, 'selected-sha')
      assert.strictEqual(plugin.testConfiguration.commitHeadSha, custom ? undefined : 'outer-pr-head')
      assert.strictEqual(plugin.testConfiguration.commitHeadMessage, custom ? undefined : 'outer PR message')
      assert.strictEqual(plugin.testEnvironmentMetadata['ci.workspace_path'], process.cwd())
      assert.strictEqual(plugin.testEnvironmentMetadata['git.commit.head.sha'], 'outer-pr-head')
    })
  }
})
