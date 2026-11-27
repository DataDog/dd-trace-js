'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const cp = require('child_process')

const log = require('../../log')
const getConfig = require('../../config')

let isGitEnabled
let gitCacheDir

function ensureCacheDir () {
  if (isGitEnabled === undefined) {
    const config = getConfig()
    isGitEnabled = config.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED
    // TODO: Move the default to config/index.js applyCalculated
    // when using the config singleton.
    gitCacheDir = config.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR ||
      path.join(os.tmpdir(), 'dd-trace-git-cache')
  }

  if (!isGitEnabled) return false

  try {
    if (fs.existsSync(gitCacheDir)) {
      const stats = fs.statSync(gitCacheDir)
      if (!stats.isDirectory()) {
        throw new Error(`Cache directory path exists but is not a directory: ${gitCacheDir}`)
      }
    } else {
      fs.mkdirSync(gitCacheDir, { recursive: true })
    }
    return true
  } catch (err) {
    log.error('Failed to create git cache directory, disabling cache', err)
    isGitEnabled = false
    return false
  }
}

function getCacheKey (cmd, flags, cwd = process.cwd()) {
  // Commands in independent checkouts must not share cached output.
  const commandString = JSON.stringify([path.resolve(cwd), cmd, flags])
  return crypto.createHash('sha256').update(commandString).digest('hex')
}

function getCacheFilePath (cacheKey) {
  ensureCacheDir()
  return path.join(gitCacheDir, `${cacheKey}.cache`)
}

function getCache (cacheKey) {
  if (!ensureCacheDir()) return null

  try {
    const cacheFilePath = getCacheFilePath(cacheKey)
    if (!fs.existsSync(cacheFilePath)) {
      return
    }

    return fs.readFileSync(cacheFilePath, 'utf8')
  } catch (err) {
    log.error('Failed to read git cache', err)
  }
}

function setCache (cacheKey, result) {
  if (!ensureCacheDir()) return

  try {
    const cacheFilePath = getCacheFilePath(cacheKey)
    fs.writeFileSync(cacheFilePath, result, 'utf8')
  } catch (err) {
    log.error('Failed to write git cache', err)
  }
}

const GIT_COMMAND_FAILED_PREFIX = '__GIT_COMMAND_FAILED__'

/**
 * @param {string} cachedResult
 */
function deserializeCachedError (cachedResult) {
  let error
  try {
    const errorData = cachedResult.replace(GIT_COMMAND_FAILED_PREFIX, '')
    const { message, code, status, errno } = JSON.parse(errorData)
    error = new Error(message)
    error.code = code
    error.status = status
    error.errno = errno
  } catch {
    // we couldn't parse the error data, so we'll throw a generic error
    return new Error('Git command failed')
  }
  return error
}

/**
 * @param {Error & { code?: string | number, status?: number, errno?: number }} err
 */
function serializeCachedError (err) {
  return GIT_COMMAND_FAILED_PREFIX + JSON.stringify({
    code: err.code,
    status: err.status,
    errno: err.errno,
    message: err.message,
  })
}

/**
 * @param {string} cmd
 * @param {string[]} flags
 * @param {import('node:child_process').ExecFileOptions} [options]
 * @returns {Promise<string | Buffer>}
 */
function execFileAsync (cmd, flags, options) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, flags, options, (err, stdout) => {
      if (err) {
        if (typeof err.code === 'number' && err.status === undefined) {
          err.status = err.code
        }
        return reject(err)
      }
      resolve(stdout)
    })
  })
}

function cachedExec (cmd, flags, options) {
  if (options === undefined) {
    options = { stdio: 'pipe' }
  }
  if (!ensureCacheDir()) {
    return cp.execFileSync(cmd, flags, options)
  }
  const cacheKey = getCacheKey(cmd, flags, options.cwd)
  const cachedResult = getCache(cacheKey)
  if (cachedResult !== undefined) {
    if (cachedResult.startsWith(GIT_COMMAND_FAILED_PREFIX)) {
      throw deserializeCachedError(cachedResult)
    }
    return cachedResult
  }
  try {
    const result = cp.execFileSync(cmd, flags, options)
    setCache(cacheKey, result)
    return result
  } catch (err) {
    setCache(cacheKey, serializeCachedError(err))
    throw err
  }
}

/**
 * @param {string} cmd
 * @param {string[]} flags
 * @param {import('node:child_process').ExecFileOptions} [options]
 * @returns {Promise<string | Buffer>}
 */
async function cachedExecAsync (cmd, flags, options) {
  const execOptions = options === undefined ? {} : options
  if (!ensureCacheDir()) {
    return execFileAsync(cmd, flags, execOptions)
  }
  const cacheKey = getCacheKey(cmd, flags, execOptions.cwd)
  const cachedResult = getCache(cacheKey)
  if (cachedResult !== undefined) {
    if (cachedResult.startsWith(GIT_COMMAND_FAILED_PREFIX)) {
      throw deserializeCachedError(cachedResult)
    }
    return cachedResult
  }
  try {
    const result = await execFileAsync(cmd, flags, execOptions)
    setCache(cacheKey, result.toString())
    return result
  } catch (err) {
    setCache(cacheKey, serializeCachedError(err))
    throw err
  }
}

module.exports = {
  getCacheKey,
  getCacheFilePath,
  cachedExec,
  cachedExecAsync,
}
