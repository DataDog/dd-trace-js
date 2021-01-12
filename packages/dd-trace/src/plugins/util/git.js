const { sanitizedExec } = require('./exec')

const GIT_COMMIT_SHA = 'git.commit.sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'
const GIT_TAG = 'git.tag'

// If there is ciMetadata, it takes precedence.
function getGitMetadata (ciMetadata) {
  const { commitSHA, branch, repositoryUrl } = ciMetadata
  // With stdio: 'pipe', errors in this command will not be output to the parent process,
  // so if `git` is not present in the env, we'll just fallback to the default
  // and not show a warning to the user.
  const execOptions = { stdio: 'pipe' }
  return {
    [GIT_REPOSITORY_URL]: repositoryUrl || sanitizedExec('git ls-remote --get-url', execOptions),
    [GIT_BRANCH]: branch || sanitizedExec('git rev-parse --abbrev-ref HEAD', execOptions),
    [GIT_COMMIT_SHA]: commitSHA || sanitizedExec('git rev-parse HEAD', execOptions)
  }
}

module.exports = { getGitMetadata, GIT_COMMIT_SHA, GIT_BRANCH, GIT_REPOSITORY_URL, GIT_TAG }
