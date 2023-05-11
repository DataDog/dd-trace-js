const commitSHARegex = /git\.commit\.sha=([a-f\d]{40})/
const repositoryUrlRegex = /git\.repository_url=([\w\d:@/.-]+)/

function getGitMetadataFromGitProperties (gitPropertiesString) {
  if (!gitPropertiesString) {
    return {}
  }
  const commitSHAMatch = gitPropertiesString.match(commitSHARegex)
  const repositoryUrlMatch = gitPropertiesString.match(repositoryUrlRegex)

  const repositoryUrl = repositoryUrlMatch ? repositoryUrlMatch[1] : undefined
  let parsedUrl = repositoryUrl

  if (repositoryUrl) {
    try {
      // repository URLs can contain username and password, so we want to filter those out
      parsedUrl = new URL(repositoryUrl)
      if (parsedUrl.password) {
        parsedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`
      }
    } catch (e) {
      // if protocol isn't https, no password will be used
    }
  }

  return {
    commitSHA: commitSHAMatch ? commitSHAMatch[1] : undefined,
    repositoryUrl: parsedUrl
  }
}

module.exports = { getGitMetadataFromGitProperties }
