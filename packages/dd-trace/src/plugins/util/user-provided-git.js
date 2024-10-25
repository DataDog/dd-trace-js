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
  GIT_COMMIT_AUTHOR_NAME
} = require('./tags')

const { normalizeRef } = require('./ci')
const { filterSensitiveInfoFromRepository } = require('./url')

function removeEmptyValues (tags) {
  return Object.keys(tags).reduce((filteredTags, tag) => {
    if (!tags[tag]) {
      return filteredTags
    }
    return {
      ...filteredTags,
      [tag]: tags[tag]
    }
  }, {})
}

// The regex is inspired by
// https://github.com/jonschlinkert/is-git-url/blob/396965ffabf2f46656c8af4c47bef1d69f09292e/index.js#L9C15-L9C87
// The `.git` suffix is optional in this version
function validateGitRepositoryUrl (repoUrl) {
  return /(?:git|ssh|https?|git@[-\w.]+):(\/\/)?(.*?)(\/?|#[-\d\w._]+?)$/.test(repoUrl)
}

function validateGitCommitSha (gitCommitSha) {
  const isValidSha1 = /^[0-9a-f]{40}$/.test(gitCommitSha)
  const isValidSha256 = /^[0-9a-f]{64}$/.test(gitCommitSha)
  return isValidSha1 || isValidSha256
}

function getUserProviderGitMetadata () {
  const {
    DD_GIT_COMMIT_SHA,
    DD_GIT_BRANCH,
    DD_GIT_REPOSITORY_URL,
    DD_GIT_TAG,
    DD_GIT_COMMIT_MESSAGE,
    DD_GIT_COMMIT_COMMITTER_NAME,
    DD_GIT_COMMIT_COMMITTER_EMAIL,
    DD_GIT_COMMIT_COMMITTER_DATE,
    DD_GIT_COMMIT_AUTHOR_NAME,
    DD_GIT_COMMIT_AUTHOR_EMAIL,
    DD_GIT_COMMIT_AUTHOR_DATE
  } = process.env

  const branch = normalizeRef(DD_GIT_BRANCH)
  let tag = normalizeRef(DD_GIT_TAG)

  // if DD_GIT_BRANCH is a tag, we associate its value to TAG too
  if ((DD_GIT_BRANCH || '').includes('origin/tags') || (DD_GIT_BRANCH || '').includes('refs/heads/tags')) {
    tag = normalizeRef(DD_GIT_BRANCH)
  }

  return removeEmptyValues({
    [GIT_COMMIT_SHA]: DD_GIT_COMMIT_SHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(DD_GIT_REPOSITORY_URL),
    [GIT_TAG]: tag,
    [GIT_COMMIT_MESSAGE]: DD_GIT_COMMIT_MESSAGE,
    [GIT_COMMIT_COMMITTER_NAME]: DD_GIT_COMMIT_COMMITTER_NAME,
    [GIT_COMMIT_COMMITTER_DATE]: DD_GIT_COMMIT_COMMITTER_DATE,
    [GIT_COMMIT_COMMITTER_EMAIL]: DD_GIT_COMMIT_COMMITTER_EMAIL,
    [GIT_COMMIT_AUTHOR_NAME]: DD_GIT_COMMIT_AUTHOR_NAME,
    [GIT_COMMIT_AUTHOR_EMAIL]: DD_GIT_COMMIT_AUTHOR_EMAIL,
    [GIT_COMMIT_AUTHOR_DATE]: DD_GIT_COMMIT_AUTHOR_DATE
  })
}

module.exports = { getUserProviderGitMetadata, validateGitRepositoryUrl, validateGitCommitSha }
