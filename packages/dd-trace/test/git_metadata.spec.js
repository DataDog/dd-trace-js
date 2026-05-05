'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const DUMMY_COMMIT_SHA = 'b7b5dfa992008c77ab3f8a10eb8711e0092445b0'
const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/dd-trace-js.git'
const DD_GIT_PROPERTIES_FILE = require.resolve('./fixtures/config/git.properties')
const DD_GIT_FOLDER_PATH = path.join(__dirname, 'fixtures', 'config', 'git-folder')

function load () {
  const getConfig = proxyquire.noPreserveCache()('../src/config', {})
  const getGitMetadata = proxyquire.noPreserveCache()('../src/git_metadata', {})
  return { config: getConfig({}), getGitMetadata }
}

describe('git metadata', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reads DD_GIT_* env vars', () => {
    process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
    process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: DUMMY_COMMIT_SHA,
      repositoryUrl: DUMMY_REPOSITORY_URL,
    })
  })

  it('reads DD_GIT_* env vars and filters out user data', () => {
    process.env.DD_GIT_REPOSITORY_URL = 'https://user:password@github.com/DataDog/dd-trace-js.git'

    const { config, getGitMetadata } = load()
    assert.strictEqual(getGitMetadata(config).repositoryUrl, 'https://github.com/DataDog/dd-trace-js.git')
  })

  it('reads DD_TAGS env var', () => {
    process.env.DD_TAGS = `git.commit.sha:${DUMMY_COMMIT_SHA},git.repository_url:${DUMMY_REPOSITORY_URL}`
    process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: DUMMY_COMMIT_SHA,
      repositoryUrl: DUMMY_REPOSITORY_URL,
    })
  })

  it('reads git.properties if it is available', () => {
    process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d',
      repositoryUrl: DUMMY_REPOSITORY_URL,
    })
  })

  it('does not crash if git.properties is not available', () => {
    process.env.DD_GIT_PROPERTIES_FILE = '/does/not/exist'

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
  })

  it('does not read git.properties if env vars are passed', () => {
    process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
    process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
    process.env.DD_GIT_REPOSITORY_URL = 'https://github.com:DataDog/dd-trace-js.git'

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: DUMMY_COMMIT_SHA,
      repositoryUrl: 'https://github.com:DataDog/dd-trace-js.git',
    })
  })

  it('still reads git.properties if one of the env vars is missing', () => {
    process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
    process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: DUMMY_COMMIT_SHA,
      repositoryUrl: DUMMY_REPOSITORY_URL,
    })
  })

  it('reads git.properties and filters out credentials', () => {
    process.env.DD_GIT_PROPERTIES_FILE = require.resolve('./fixtures/config/git.properties.credentials')

    const { config, getGitMetadata } = load()
    assertObjectContains(getGitMetadata(config), {
      commitSHA: '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d',
      repositoryUrl: 'https://github.com/datadog/dd-trace-js',
    })
  })

  it('returns undefined values when DD_TRACE_GIT_METADATA_ENABLED is false', () => {
    process.env.DD_TRACE_GIT_METADATA_ENABLED = 'false'
    process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
    process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
  })

  it('reads .git/ folder if it is available', () => {
    process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH

    const { config, getGitMetadata } = load()
    assertObjectContains(getGitMetadata(config), {
      repositoryUrl: 'git@github.com:DataDog/dd-trace-js.git',
      commitSHA: '964886d9ec0c9fc68778e4abb0aab4d9982ce2b5',
    })
  })

  it('does not crash if .git/ folder is not available', () => {
    process.env.DD_GIT_FOLDER_PATH = '/does/not/exist/'

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: undefined,
      repositoryUrl: undefined,
    })
  })

  it('does not read .git/ folder if env vars are passed', () => {
    process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH
    process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
    process.env.DD_GIT_REPOSITORY_URL = 'https://github.com:DataDog/dd-trace-js.git'

    const { config, getGitMetadata } = load()
    assert.deepStrictEqual(getGitMetadata(config), {
      commitSHA: DUMMY_COMMIT_SHA,
      repositoryUrl: 'https://github.com:DataDog/dd-trace-js.git',
    })
  })

  it('still reads .git/ if one of the env vars is missing', () => {
    process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH
    process.env.DD_GIT_REPOSITORY_URL = 'git@github.com:DataDog/dummy-dd-trace-js.git'

    const { config, getGitMetadata } = load()
    assertObjectContains(getGitMetadata(config), {
      commitSHA: '964886d9ec0c9fc68778e4abb0aab4d9982ce2b5',
      repositoryUrl: 'git@github.com:DataDog/dummy-dd-trace-js.git',
    })
  })
})
