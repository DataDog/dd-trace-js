const commitSHARegex = /git\.commit\.sha=([a-f\d]{40})/
const repositoryUrlRegex = /git\.repository_url=([\w\d:@/.-]+)/

function getGitMetadataFromGitProperties (gitPropertiesString) {
  const commitSHAMatch = gitPropertiesString.match(commitSHARegex)
  const repositoryUrlMatch = gitPropertiesString.match(repositoryUrlRegex)

  return {
    commitSHA: commitSHAMatch ? commitSHAMatch[1] : null,
    repositoryUrl: repositoryUrlMatch ? repositoryUrlMatch[1] : null
  }
}

module.exports = { getGitMetadataFromGitProperties }
