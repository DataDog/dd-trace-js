
const fs = require('fs')
const path = require('path')

const FormData = require('../../../exporters/common/form-data')
const request = require('../../../exporters/common/request')

const log = require('../../../log')
const {
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsToUpload
} = require('../../../plugins/util/git')

const isValidSha = (sha) => /[0-9a-f]{40}/.test(sha)

function sanitizeCommits (commits) {
  return commits.map(({ id: commitSha, type }) => {
    if (type !== 'commit') {
      throw new Error('Invalid commit type response')
    }
    const sanitizedCommit = commitSha.replace(/[^0-9a-f]+/g, '')
    if (sanitizedCommit !== commitSha || !isValidSha(sanitizedCommit)) {
      throw new Error('Invalid commit format')
    }
    return sanitizedCommit
  })
}

function getCommonRequestOptions (url) {
  return {
    method: 'POST',
    headers: {
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    },
    timeout: 15000,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port
  }
}

/**
 * This function posts the SHAs of the commits of the last month
 * The response are the commits for which the backend already has information
 * This response is used to know which commits can be ignored from there on
 */
function getCommitsToExclude ({ url, repositoryUrl }, callback) {
  const latestCommits = getLatestCommits()
  const [headCommit] = latestCommits

  const commonOptions = getCommonRequestOptions(url)

  const options = {
    ...commonOptions,
    headers: {
      ...commonOptions.headers,
      'Content-Type': 'application/json'
    },
    path: '/api/v2/git/repository/search_commits'
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

  request(localCommitData, options, (err, response, statusCode) => {
    if (err) {
      const error = new Error(`search_commits returned a status code ${statusCode}: ${err.message}`)
      return callback(error)
    }
    let commitsToExclude
    try {
      commitsToExclude = sanitizeCommits(JSON.parse(response).data)
    } catch (e) {
      return callback(new Error(`Can't parse search_commits response: ${e.message}`))
    }
    callback(null, commitsToExclude, headCommit)
  })
}

/**
 * This function uploads a git packfile
 */
function uploadPackFile ({ url, packFileToUpload, repositoryUrl, headCommit }, callback) {
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
function sendGitMetadata (site, callback) {
  const url = new URL(`https://api.${site}`)

  const repositoryUrl = getRepositoryUrl()

  if (!repositoryUrl) {
    return callback(new Error('Repository URL is empty'))
  }

  getCommitsToExclude({ url, repositoryUrl }, (err, commitsToExclude, headCommit) => {
    if (err) {
      return callback(err)
    }
    const commitsToUpload = getCommitsToUpload(commitsToExclude)

    if (!commitsToUpload.length) {
      log.debug('No commits to upload')
      return callback(null)
    }
    const packFilesToUpload = generatePackFilesForCommits(commitsToUpload)

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
          repositoryUrl,
          headCommit
        },
        uploadPackFileCallback
      )
    }

    uploadPackFile(
      {
        url,
        packFileToUpload: packFilesToUpload[packFileIndex++],
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
