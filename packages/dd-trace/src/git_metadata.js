'use strict'

const fs = require('node:fs')
const path = require('node:path')

const log = require('./log')
const { GIT_COMMIT_SHA, GIT_REPOSITORY_URL } = require('./plugins/util/tags')
const {
  getGitMetadataFromGitProperties,
  getRemoteOriginURL,
  removeUserSensitiveInfo,
  resolveGitHeadSHA,
} = require('./config/git_properties')

/** @type {{ commitSHA: string | undefined, repositoryUrl: string | undefined } | undefined} */
let cached

/**
 * @param {import('./config/config-types').ConfigProperties} config
 */
function getGitMetadata (config) {
  if (cached) return cached

  if (!config.DD_TRACE_GIT_METADATA_ENABLED) {
    cached = { commitSHA: undefined, repositoryUrl: undefined }
    return cached
  }

  let repositoryUrl = removeUserSensitiveInfo(config.DD_GIT_REPOSITORY_URL ?? config.tags[GIT_REPOSITORY_URL])
  let commitSHA = config.DD_GIT_COMMIT_SHA ?? config.tags[GIT_COMMIT_SHA]

  if (!repositoryUrl || !commitSHA) {
    const propertiesFile = config.DD_GIT_PROPERTIES_FILE
    const gitPropertiesFile = propertiesFile ?? `${process.cwd()}/git.properties`
    try {
      const fromProperties = getGitMetadataFromGitProperties(fs.readFileSync(gitPropertiesFile, 'utf8'))
      commitSHA ??= fromProperties.commitSHA
      repositoryUrl ??= fromProperties.repositoryUrl
    } catch (error) {
      if (propertiesFile) {
        // The user pointed us at a specific git.properties path; that file is the declared
        // SCI source. If we can't read it, do not silently fall back to inspecting `.git/`.
        log.error('Error reading DD_GIT_PROPERTIES_FILE: %s', gitPropertiesFile, error)
        cached = { commitSHA, repositoryUrl }
        return cached
      }
    }
  }

  const folderPath = config.DD_GIT_FOLDER_PATH
  const gitFolderPath = folderPath ?? path.join(process.cwd(), '.git')

  if (!repositoryUrl) {
    const gitConfigPath = path.join(gitFolderPath, 'config')
    try {
      repositoryUrl = getRemoteOriginURL(fs.readFileSync(gitConfigPath, 'utf8'))
    } catch (error) {
      if (folderPath) {
        log.error('Error reading git config: %s', gitConfigPath, error)
      }
    }
  }

  commitSHA ??= resolveGitHeadSHA(gitFolderPath)

  cached = { commitSHA, repositoryUrl }
  return cached
}

module.exports = getGitMetadata
