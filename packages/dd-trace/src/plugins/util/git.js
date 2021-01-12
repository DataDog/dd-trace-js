const { sanitizedExec } = require('./exec')

const GIT_COMMIT_SHA = 'git.commit.sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'
const GIT_TAG = 'git.tag'

function getGitMetadata () {
  return {
    [GIT_REPOSITORY_URL]: sanitizedExec('git ls-remote --get-url'),
    [GIT_BRANCH]: sanitizedExec('git rev-parse --abbrev-ref HEAD'),
    [GIT_COMMIT_SHA]: sanitizedExec('git rev-parse HEAD')
  }
}

module.exports = { getGitMetadata, GIT_COMMIT_SHA, GIT_BRANCH, GIT_REPOSITORY_URL, GIT_TAG }
