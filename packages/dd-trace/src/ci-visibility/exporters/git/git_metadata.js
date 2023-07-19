
const fs = require('fs')
const path = require('path')

const FormData = require('../../../exporters/common/form-data')
const request = require('../../../exporters/common/request')

const log = require('../../../log')
const {
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsToUpload,
  isShallowRepository,
  unshallowRepository
} = require('../../../plugins/util/git')

const isValidSha1 = (sha) => /^[0-9a-f]{40}$/.test(sha)
const isValidSha256 = (sha) => /^[0-9a-f]{64}$/.test(sha)

function validateCommits (commits) {
  return commits.map(({ id: commitSha, type }) => {
    if (type !== 'commit') {
      throw new Error('Invalid commit type response')
    }
    if (isValidSha1(commitSha) || isValidSha256(commitSha)) {
      return commitSha.replace(/[^0-9a-f]+/g, '')
    }
    throw new Error('Invalid commit format')
  })
}

function getCommonRequestOptions (url) {
  return {
    method: 'POST',
    headers: {
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    },
    timeout: 15000,
    url
  }
}

/**
 * This function posts the SHAs of the commits of the last month
 * The response are the commits for which the backend already has information
 * This response is used to know which commits can be ignored from there on
 */
function getCommitsToExclude ({ url, isEvpProxy, repositoryUrl }, callback) {
  const latestCommits = getLatestCommits()

  log.debug(`There were ${latestCommits.length} commits since last month.`)

  const commonOptions = getCommonRequestOptions(url)

  const options = {
    ...commonOptions,
    headers: {
      ...commonOptions.headers,
      'Content-Type': 'application/json'
    },
    path: '/api/v2/git/repository/search_commits'
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/git/repository/search_commits'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
    delete options.headers['dd-api-key']
  }

  const localCommitData = JSON.stringify({
    meta: {
      repository_url: repositoryUrl
    },
    data: latestCommits.map(commit => ({
      id: commit,
      type: 'commit'
    }))
  })

  request(localCommitData, options, (err, response) => {
    if (err) {
      const error = new Error(`Error fetching commits to exclude: ${err.message}`)
      return callback(error)
    }
    let commitsToExclude
    try {
      commitsToExclude = validateCommits(JSON.parse(response).data)
    } catch (e) {
      return callback(new Error(`Can't parse commits to exclude response: ${e.message}`))
    }
    callback(null, commitsToExclude, latestCommits)
  })
}

/**
 * This function uploads a git packfile
 */
function uploadPackFile ({ url, isEvpProxy, packFileToUpload, repositoryUrl, headCommit }, callback) {
  const form = new FormData()

  const pushedSha = JSON.stringify({
    data: {
      id: headCommit,
      type: 'commit'
    },
    meta: {
      repository_url: repositoryUrl
    }
  })

  form.append('pushedSha', pushedSha, { contentType: 'application/json' })

  try {
    const packFileContent = fs.readFileSync(packFileToUpload)
    // The original filename includes a random prefix, so we remove it here
    const [, filename] = path.basename(packFileToUpload).split('-')
    form.append('packfile', packFileContent, {
      filename,
      contentType: 'application/octet-stream'
    })
  } catch (e) {
    callback(new Error(`Could not read "${packFileToUpload}"`))
    return
  }

  const commonOptions = getCommonRequestOptions(url)

  const options = {
    ...commonOptions,
    path: '/api/v2/git/repository/packfile',
    headers: {
      ...commonOptions.headers,
      ...form.getHeaders()
    }
  }

  if (isEvpProxy) {
    options.path = '/evp_proxy/v2/api/v2/git/repository/packfile'
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
    delete options.headers['dd-api-key']
  }

  request(form, options, (err, _, statusCode) => {
    if (err) {
      const error = new Error(`Could not upload packfiles: status code ${statusCode}: ${err.message}`)
      return callback(error)
    }
    callback(null)
  })
}

/**
 * This function uploads git metadata to CI Visibility's backend.
*/
function sendGitMetadata (url, isEvpProxy, configRepositoryUrl, callback) {
  let repositoryUrl = configRepositoryUrl
  if (!repositoryUrl) {
    repositoryUrl = getRepositoryUrl()
  }

  log.debug(`Uploading git history for repository ${repositoryUrl}`)

  if (!repositoryUrl) {
    return callback(new Error('Repository URL is empty'))
  }

  if (isShallowRepository()) {
    log.debug('It is shallow clone, unshallowing...')
    unshallowRepository()
  }

  getCommitsToExclude({ url, repositoryUrl, isEvpProxy }, (err, commitsToExclude, latestCommits) => {
    if (err) {
      return callback(err)
    }
    log.debug(`There are ${commitsToExclude.length} commits to exclude.`)
    const [headCommit] = latestCommits
    const commitsToInclude = latestCommits.filter((commit) => !commitsToExclude.includes(commit))
    log.debug(`There are ${commitsToInclude.length} commits to include.`)

    const commitsToUpload = getCommitsToUpload(commitsToExclude, commitsToInclude)

    if (!commitsToUpload.length) {
      log.debug('No commits to upload')
      return callback(null)
    }
    log.debug(`There are ${commitsToUpload.length} commits to upload`)

    const packFilesToUpload = generatePackFilesForCommits(commitsToUpload)

    log.debug(`Uploading ${packFilesToUpload.length} packfiles.`)

    if (!packFilesToUpload.length) {
      return callback(new Error('Failed to generate packfiles'))
    }

    let packFileIndex = 0
    // This uploads packfiles sequentially
    const uploadPackFileCallback = (err) => {
      if (err || packFileIndex === packFilesToUpload.length) {
        return callback(err)
      }
      return uploadPackFile(
        {
          packFileToUpload: packFilesToUpload[packFileIndex++],
          url,
          isEvpProxy,
          repositoryUrl,
          headCommit
        },
        uploadPackFileCallback
      )
    }

    uploadPackFile(
      {
        packFileToUpload: packFilesToUpload[packFileIndex++],
        url,
        isEvpProxy,
        repositoryUrl,
        headCommit
      },
      uploadPackFileCallback
    )
  })
}

module.exports = {
  sendGitMetadata
}
