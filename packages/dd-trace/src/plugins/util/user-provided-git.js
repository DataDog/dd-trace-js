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

  let branch = normalizeRef(DD_GIT_BRANCH)
  let tag = normalizeRef(DD_GIT_TAG)

  if (DD_GIT_TAG) {
    branch = undefined
  }

  // if DD_GIT_BRANCH is a tag, we associate its value to TAG instead of BRANCH
  if ((DD_GIT_BRANCH || '').includes('origin/tags') || (DD_GIT_BRANCH || '').includes('refs/heads/tags')) {
    branch = undefined
    tag = normalizeRef(DD_GIT_BRANCH)
  }

  return removeEmptyValues({
    [GIT_COMMIT_SHA]: DD_GIT_COMMIT_SHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: DD_GIT_REPOSITORY_URL,
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

module.exports = { getUserProviderGitMetadata }
