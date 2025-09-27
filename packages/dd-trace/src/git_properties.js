'use strict'

const commitSHARegex = /git\.commit\.sha=([a-f\d]{40})/
const repositoryUrlRegex = /git\.repository_url=([\w\d:@/.-]+)/
const gitRemoteOriginRegex = /\[remote\s+"origin"\]\s*\n\s*url\s*=\s*([\w\d:@/.-]+)/
const gitHeadRefRegex = /ref:\s+(refs\/[A-Za-z0-9._/-]+)/

function removeUserSensitiveInfo (repositoryUrl) {
  try {
    // repository URLs can contain username and password, so we want to filter those out
    const parsedUrl = new URL(repositoryUrl)
    if (parsedUrl.username || parsedUrl.password) {
      return `${parsedUrl.origin}${parsedUrl.pathname}`
    }
    return repositoryUrl
  } catch {
    // if protocol isn't https, no password will be used
    return repositoryUrl
  }
}

function getGitMetadataFromGitProperties (gitPropertiesString) {
  if (!gitPropertiesString) {
    return {}
  }
  const commitSHAMatch = gitPropertiesString.match(commitSHARegex)
  const repositoryUrlMatch = gitPropertiesString.match(repositoryUrlRegex)

  const repositoryUrl = repositoryUrlMatch ? repositoryUrlMatch[1] : undefined

  return {
    commitSHA: commitSHAMatch ? commitSHAMatch[1] : undefined,
    repositoryUrl: removeUserSensitiveInfo(repositoryUrl)
  }
}

function getGitRepoUrlFromGitConfig (gitConfigContent) {
  if (!gitConfigContent) {
    return
  }

  // Look for [remote "origin"] section and extract the URL
  const repositoryUrlMatch = gitConfigContent.match(gitRemoteOriginRegex)

  if (repositoryUrlMatch && repositoryUrlMatch.length > 1) {
    return removeUserSensitiveInfo(repositoryUrlMatch[1])
  }
}

function getGitHeadRef (gitHeadContent) {
  if (!gitHeadContent) {
    return
  }

  // Extract the ref after 'ref: '
  const gitRefMatch = gitHeadContent.match(gitHeadRefRegex)

  if (gitRefMatch && gitRefMatch.length > 1) {
    return gitRefMatch[1]
  }
}

module.exports = { getGitMetadataFromGitProperties, removeUserSensitiveInfo, getGitRepoUrlFromGitConfig, getGitHeadRef }
