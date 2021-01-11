const { sanitizedExec } = require('./exec')

const GIT_COMMIT_SHA = 'git.commit.sha'
// TODO: remove this once CI App's UI and backend are ready
const DEPRECATED_GIT_COMMIT_SHA = 'git.commit_sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'

function getGitMetadata () {
  const commitSha = sanitizedExec('git rev-parse HEAD')
  return {
    [GIT_REPOSITORY_URL]: sanitizedExec('git ls-remote --get-url'),
    [GIT_BRANCH]: sanitizedExec('git rev-parse --abbrev-ref HEAD'),
    [GIT_COMMIT_SHA]: commitSha,
    [DEPRECATED_GIT_COMMIT_SHA]: commitSha
  }
}

module.exports = { getGitMetadata, GIT_COMMIT_SHA, GIT_BRANCH, GIT_REPOSITORY_URL }
