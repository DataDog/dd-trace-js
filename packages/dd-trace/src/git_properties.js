'use strict'

const fs = require('fs')
const path = require('path')

const gitPropertiesCommitSHARegex = /git\.commit\.sha=([a-f\d]{40})/
const gitPropertiesRepositoryUrlRegex = /git\.repository_url=([\w\d:@/.-]+)/
const repositoryUrlRegex = /^([\w\d:@/.-]+)$/
const remoteOriginRegex = /^\[remote\s+"origin"\]/i
const gitHeadRefRegex = /ref:\s+(refs\/[A-Za-z0-9._/-]+)/
const commitSHARegex = /^[0-9a-f]{40}$/

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
  const commitSHAMatch = gitPropertiesString.match(gitPropertiesCommitSHARegex)
  const repositoryUrlMatch = gitPropertiesString.match(gitPropertiesRepositoryUrlRegex)

  const repositoryUrl = repositoryUrlMatch ? repositoryUrlMatch[1] : undefined

  return {
    commitSHA: commitSHAMatch ? commitSHAMatch[1] : undefined,
    repositoryUrl: removeUserSensitiveInfo(repositoryUrl)
  }
}

function getRemoteOriginURL (gitConfigContent) {
  if (!gitConfigContent) {
    return
  }
  const lines = gitConfigContent.split('\n')
  let index = 0

  // find the remote origin section
  for (; index < lines.length; index++) {
    const line = lines[index]
    if (line[0] !== '[') continue // fast path
    if (remoteOriginRegex.test(line)) break
  }

  // find the url key/value in the [remote "origin"] section
  index++
  for (; index < lines.length; index++) {
    const line = lines[index]
    if (line[0] === '[') return // abort, section didn't contain a url
    const splitAt = line.indexOf('=')
    if (splitAt === -1) continue
    const key = line.slice(0, splitAt).trim().toLowerCase()
    if (key !== 'url') continue
    const repositoryUrlValue = line.slice(splitAt + 1).trim()
    const repositoryUrlMatch = repositoryUrlValue.match(repositoryUrlRegex)
    if (!repositoryUrlMatch) continue
    return removeUserSensitiveInfo(repositoryUrlMatch[0])
  }
}

function getGitHeadRef (gitHeadContent) {
  if (!gitHeadContent) {
    return
  }

  // Extract the ref after 'ref: '
  const gitRefMatch = gitHeadContent.match(gitHeadRefRegex)
  return gitRefMatch?.[1]
}

function resolveGitHeadSHA (DD_GIT_FOLDER_PATH) {
  const gitHeadPath = path.join(DD_GIT_FOLDER_PATH, 'HEAD')

  try {
    const gitHeadContent = fs.readFileSync(gitHeadPath, 'utf8')
    if (!gitHeadContent) {
      return
    }

    const headContent = gitHeadContent.trim()

    // Handle detached head case
    if (commitSHARegex.test(headContent)) {
      return headContent
    }

    // Handle ref case - extract the ref and read the SHA from the ref file
    const gitHeadRef = getGitHeadRef(headContent)
    if (!gitHeadRef) {
      return
    }
    const gitHeadRefPath = path.join(DD_GIT_FOLDER_PATH, gitHeadRef)
    const gitHeadRefContent = fs.readFileSync(gitHeadRefPath, 'utf8')
    if (gitHeadRefContent) {
      const headRefContent = gitHeadRefContent.trim()
      if (commitSHARegex.test(headRefContent)) {
        return headRefContent
      }
    }
  } catch {}
}

module.exports = {
  getGitMetadataFromGitProperties,
  removeUserSensitiveInfo,
  getGitHeadRef,
  getRemoteOriginURL,
  resolveGitHeadSHA,
}
