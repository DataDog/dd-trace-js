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
    config = { DD_TRACE_GIT_METADATA_ENABLED: true }
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

  it('fills only the missing field from the CLI', () => {
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

  it('strips credentials from a CLI-resolved repository url', () => {
    const { resolveLLMObsGitMetadata } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://x-token:secret@github.com/example/repo.git',
    })

    const { repositoryUrl } = resolveLLMObsGitMetadata(config)
    assert.ok(!repositoryUrl.includes('secret'))
    assert.strictEqual(repositoryUrl, 'https://github.com/example/repo.git')
  })

  it('returns undefined values and skips the CLI when git is unavailable', () => {
    const { resolveLLMObsGitMetadata, getCommitSHA, getRepositoryUrl } = load({ gitAvailable: false })

    assert.deepStrictEqual(resolveLLMObsGitMetadata(config), {
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

  it('resolves once and caches for the process lifetime', () => {
    const { resolveLLMObsGitMetadata, getGitMetadata, getCommitSHA } = load({
      commitSHA: 'shellsha',
      repositoryUrl: 'https://github.com/from-shell',
    })

    const first = resolveLLMObsGitMetadata(config)
    const second = resolveLLMObsGitMetadata(config)

    assert.strictEqual(first, second)
    sinon.assert.calledOnce(getGitMetadata)
    sinon.assert.calledOnce(getCommitSHA)
  })
})
