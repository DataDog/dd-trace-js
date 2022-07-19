const { sanitizedExec } = require('./exec')

const {
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_REPOSITORY_URL,
  GIT_TAG,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  CI_WORKSPACE_PATH
} = require('./tags')

const cache = new Map()

// If there is ciMetadata, it takes precedence.
function getGitMetadata (ciMetadata) {
  const cacheKey = JSON.stringify(ciMetadata)
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  const {
    commitSHA,
    branch,
    repositoryUrl,
    tag,
    commitMessage,
    authorName: ciAuthorName,
    authorEmail: ciAuthorEmail,
    ciWorkspacePath
  } = ciMetadata

  // With stdio: 'pipe', errors in this command will not be output to the parent process,
  // so if `git` is not present in the env, we won't show a warning to the user.
  const [
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate
  ] = sanitizedExec('git show -s --format=%an,%ae,%aI,%cn,%ce,%cI', { stdio: 'pipe' }).split(',')

  const result = {
    [GIT_REPOSITORY_URL]:
      repositoryUrl || sanitizedExec('git ls-remote --get-url', { stdio: 'pipe' }),
    [GIT_COMMIT_MESSAGE]:
      commitMessage || sanitizedExec('git show -s --format=%s', { stdio: 'pipe' }),
    [GIT_COMMIT_AUTHOR_DATE]: authorDate,
    [GIT_COMMIT_AUTHOR_NAME]: ciAuthorName || authorName,
    [GIT_COMMIT_AUTHOR_EMAIL]: ciAuthorEmail || authorEmail,
    [GIT_COMMIT_COMMITTER_DATE]: committerDate,
    [GIT_COMMIT_COMMITTER_NAME]: committerName,
    [GIT_COMMIT_COMMITTER_EMAIL]: committerEmail,
    [GIT_BRANCH]: branch || sanitizedExec('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }),
    [GIT_COMMIT_SHA]: commitSHA || sanitizedExec('git rev-parse HEAD', { stdio: 'pipe' }),
    [GIT_TAG]: tag,
    [CI_WORKSPACE_PATH]: ciWorkspacePath || sanitizedExec('git rev-parse --show-toplevel', { stdio: 'pipe' })
  }

  cache.set(cacheKey, result)

  return result
}

module.exports = { getGitMetadata }
