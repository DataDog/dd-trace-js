'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const cp = require('child_process')

const log = require('../../log')
const { getEnvironmentVariable } = require('../../config-helper')
const { isTrue } = require('../../util')

let isGitEnabled = isTrue(getEnvironmentVariable('DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED'))
const GIT_CACHE_DIR = getEnvironmentVariable('DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR') ||
  path.join(os.tmpdir(), 'dd-trace-git-cache')

if (isGitEnabled) {
  try {
    if (!fs.existsSync(GIT_CACHE_DIR)) {
      fs.mkdirSync(GIT_CACHE_DIR, { recursive: true })
    }
  } catch (err) {
    log.error('Failed to create git cache directory, disabling cache', err)
    isGitEnabled = false
  }
}

function getCacheKey (cmd, flags) {
  // Create a hash of the command and flags to use as cache key
  const commandString = `${cmd} ${flags.join(' ')}`
  return crypto.createHash('sha256').update(commandString).digest('hex')
}

function getCacheFilePath (cacheKey) {
  return path.join(GIT_CACHE_DIR, `${cacheKey}.cache`)
}

function getCache (cacheKey) {
  if (!isGitEnabled) return null

  try {
    const cacheFilePath = getCacheFilePath(cacheKey)
    if (!fs.existsSync(cacheFilePath)) {
      return null
    }

    const content = fs.readFileSync(cacheFilePath, 'utf8')
    return content
  } catch (err) {
    log.error('Failed to read git cache', err)
    return null
  }
}

function setCache (cacheKey, result) {
  if (!isGitEnabled) return

  try {
    const cacheFilePath = getCacheFilePath(cacheKey)
    fs.writeFileSync(cacheFilePath, result, 'utf8')
  } catch (err) {
    log.error('Failed to write git cache', err)
  }
}

function cachedExec (cmd, flags, options) {
  if (options === undefined) {
    options = { stdio: 'pipe' }
  }
  if (!isGitEnabled) {
    return cp.execFileSync(cmd, flags, options)
  }
  const cacheKey = getCacheKey(cmd, flags)
  const cachedResult = getCache(cacheKey)
  if (cachedResult !== null) {
    if (cachedResult.startsWith('__GIT_COMMAND_FAILED__')) {
      let error
      try {
        const errorData = cachedResult.replace('__GIT_COMMAND_FAILED__', '')
        const { message, code, status, errno } = JSON.parse(errorData)
        error = new Error(message)
        error.code = code
        error.status = status
        error.errno = errno
      } catch {
        // we couldn't parse the error data, so we'll throw a generic error
        throw new Error('Git command failed')
      }
      throw error
    }
    return cachedResult
  }
  try {
    const result = cp.execFileSync(cmd, flags, options)
    setCache(cacheKey, result)
    return result
  } catch (err) {
    const cacheValue = '__GIT_COMMAND_FAILED__' +
      JSON.stringify({
        code: err.code,
        status: err.status,
        errno: err.errno,
        message: err.message
      })
    setCache(cacheKey, cacheValue)
    throw err
  }
}

module.exports = {
  cachedExec,
  getCacheKey,
}
