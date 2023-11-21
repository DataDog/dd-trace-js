const commitSHARegex = /git\.commit\.sha=([a-f\d]{40})/
const repositoryUrlRegex = /git\.repository_url=([\w\d:@/.-]+)/

function removeUserSensitiveInfo (repositoryUrl) {
  try {
    // repository URLs can contain username and password, so we want to filter those out
    const parsedUrl = new URL(repositoryUrl)
    if (parsedUrl.username || parsedUrl.password) {
      return `${parsedUrl.origin}${parsedUrl.pathname}`
    }
    return repositoryUrl
  } catch (e) {
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

module.exports = { getGitMetadataFromGitProperties, removeUserSensitiveInfo }
