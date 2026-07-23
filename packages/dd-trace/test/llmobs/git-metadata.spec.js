'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./../setup/core')

// Load a fresh resolver (module-level cache reset) with the file/env resolver
// and git-CLI helpers stubbed.
function load ({ fromFile = {}, commitSHA = '', repositoryUrl = '', gitAvailable = true } = {}) {
  const getGitMetadata = sinon.stub().returns({
    commitSHA: fromFile.commitSHA,
    repositoryUrl: fromFile.repositoryUrl,
  })
  const getCommitSHA = sinon.stub().returns(commitSHA)
  const getRepositoryUrl = sinon.stub().returns(repositoryUrl)
  const isGitAvailable = sinon.stub().returns(gitAvailable)

  const resolveLLMObsGitMetadata = proxyquire.noPreserveCache()('../../src/llmobs/git-metadata', {
    '../git_metadata': Object.assign(getGitMetadata, { '@noCallThru': true }),
    '../plugins/util/git': { getCommitSHA, getRepositoryUrl, isGitAvailable, '@noCallThru': true },
  })

  return { resolveLLMObsGitMetadata, getGitMetadata, getCommitSHA, getRepositoryUrl, isGitAvailable }
}

describe('llmobs git metadata resolver', () => {
  let config

  beforeEach(() => {
    // __dirname always exists, so the CLI fallback's git-folder gate passes without
    // depending on the working directory the tests happen to run from.
    config = { DD_TRACE_GIT_METADATA_ENABLED: true, DD_GIT_FOLDER_PATH: __dirname }
  })

  it('returns file/env metadata without consulting the CLI when both are present', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl, isGitAvailable } = load({
      fromFile: { commitSHA: 'envsha', repositoryUrl: 'https://github.com/from-env' },
    })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
      commitSHA: 'envsha',
      repositoryUrl: 'https://github.com/from-env',
    })
    sinon.assert.notCalled(isGitAvailable)
    sinon.assert.notCalled(getCommitSHA)
    sinon.assert.notCalled(getRepositoryUrl)
  })

  it('falls back to the git CLI for both values when file/env yields nothing', () => {
    const { resolveLLMObsGitMetadata } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })
  })

  it('fills only the missing commit sha from the CLI', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl } = load({
      fromFile: { repositoryUrl: 'https://github.com/from-env' },
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-env',
    })
    sinon.assert.calledOnce(getCommitSHA)
    sinon.assert.notCalled(getRepositoryUrl)
  })

  it('fills only the missing repository url from the CLI', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl } = load({
      fromFile: { commitSHA: 'envsha' },
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
      commitSHA: 'envsha',
      repositoryUrl: 'https://github.com/from-shell',
    })
    sinon.assert.notCalled(getCommitSHA)
    sinon.assert.calledOnce(getRepositoryUrl)
  })

  it('leaves values undefined when the CLI resolves to empty strings', () => {
    const { resolveLLMObsGitMetadata } = load({ commitSHA: '', repositoryUrl: '' })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
  })

  it('strips credentials from a CLI-resolved repository url', () => {
    const { resolveLLMObsGitMetadata } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://x-token:secret@github.com/example/repo.git',
    })

    const { repositoryUrl } = resolveLLMObsGitMetadata(config)
    assert.ok(!repositoryUrl.includes('secret'))
    assert.strictEqual(repositoryUrl, 'https://github.com/example/repo.git')
  })

  it('skips the CLI when not inside a git checkout', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl, isGitAvailable } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    const result = resolveLLMObsGitMetadata({
      DD_TRACE_GIT_METADATA_ENABLED: true,
      DD_GIT_FOLDER_PATH: '/nonexistent/.git',
    })
    assert.deepStrictEqual(result, { commitSHA: undefined, repositoryUrl: undefined })
    sinon.assert.notCalled(isGitAvailable)
    sinon.assert.notCalled(getCommitSHA)
    sinon.assert.notCalled(getRepositoryUrl)
  })

  it('returns undefined values and skips the CLI when git is unavailable', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl } = load({ gitAvailable: false })

    // No DD_GIT_FOLDER_PATH here, so the folder gate falls back to `${cwd}/.git`
    // (present when the suite runs from the repo root).
    assert.deepStrictEqual(resolveLLMObsGitMetadata({ DD_TRACE_GIT_METADATA_ENABLED: true }), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
    sinon.assert.notCalled(getCommitSHA)
    sinon.assert.notCalled(getRepositoryUrl)
  })

  it('returns empty metadata and touches nothing when DD_TRACE_GIT_METADATA_ENABLED is false', () => {
    const { resolveLLMObsGitMetadata, getGitMetadata, getCommitSHA, getRepositoryUrl, isGitAvailable } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    assert.deepStrictEqual(resolveLLMObsGitMetadata({ DD_TRACE_GIT_METADATA_ENABLED: false }), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
    sinon.assert.notCalled(getGitMetadata)
    sinon.assert.notCalled(isGitAvailable)
    sinon.assert.notCalled(getCommitSHA)
    sinon.assert.notCalled(getRepositoryUrl)
  })

  it('caches enabled and disabled results independently', () => {
    const { resolveLLMObsGitMetadata, getGitMetadata, getCommitSHA } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    // A disabled call first must not poison a later enabled call.
    const disabled = resolveLLMObsGitMetadata({ DD_TRACE_GIT_METADATA_ENABLED: false })
    assert.deepStrictEqual(disabled, { commitSHA: undefined, repositoryUrl: undefined })

    const enabled = resolveLLMObsGitMetadata(config)
    assert.deepStrictEqual(enabled, {
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    // Both results are memoized: a repeat call returns the same object without re-resolving.
    assert.strictEqual(resolveLLMObsGitMetadata(config), enabled)
    sinon.assert.calledOnce(getGitMetadata)
    sinon.assert.calledOnce(getCommitSHA)
  })
})
