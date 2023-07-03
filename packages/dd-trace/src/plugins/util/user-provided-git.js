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
const log = require('../../log')
const { URL } = require('url')

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

function filterSensitiveInfoFromRepository (repositoryUrl) {
  try {
    if (repositoryUrl.startsWith('git@')) {
      return repositoryUrl
    }
    const { protocol, hostname, pathname } = new URL(repositoryUrl)

    return `${protocol}//${hostname}${pathname}`
  } catch (e) {
    return repositoryUrl
  }
}

function validateGitRepositoryUrl (repoUrl) {
  return /((http|git|ssh|http(s)|file|\/?)|(git@[\w.]+))(:(\/\/)?)([\w.@:/\-~]+)(\.git)(\/)?/.test(repoUrl)
}

function validateGitCommitSha (gitCommitSha) {
  const isValidSha1 = /^[0-9a-f]{40}$/.test(gitCommitSha)
  const isValidSha256 = /^[0-9a-f]{64}$/.test(gitCommitSha)
  return isValidSha1 || isValidSha256
}

function removeInvalidGitMetadata (metadata) {
  return Object.keys(metadata).reduce((filteredTags, tag) => {
    if (tag === GIT_REPOSITORY_URL) {
      if (!validateGitRepositoryUrl(metadata[GIT_REPOSITORY_URL])) {
        log.error('DD_GIT_COMMIT_SHA must be a full-length git SHA')
        return filteredTags
      }
    }
    if (tag === GIT_COMMIT_SHA) {
      if (!validateGitCommitSha(metadata[GIT_COMMIT_SHA])) {
        log.error('DD_GIT_REPOSITORY_URL must be a valid URL')
        return filteredTags
      }
    }
    filteredTags[tag] = metadata[tag]
    return filteredTags
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

  const branch = normalizeRef(DD_GIT_BRANCH)
  let tag = normalizeRef(DD_GIT_TAG)

  // if DD_GIT_BRANCH is a tag, we associate its value to TAG too
  if ((DD_GIT_BRANCH || '').includes('origin/tags') || (DD_GIT_BRANCH || '').includes('refs/heads/tags')) {
    tag = normalizeRef(DD_GIT_BRANCH)
  }

  const metadata = removeEmptyValues({
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
  validateGitMetadata(metadata)
  return metadata
}

module.exports = { getUserProviderGitMetadata, validateGitRepositoryUrl, validateGitCommitSha }
