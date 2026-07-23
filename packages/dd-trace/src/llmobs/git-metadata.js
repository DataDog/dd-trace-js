'use strict'

const fs = require('node:fs')
const path = require('node:path')

const getGitMetadata = require('../git_metadata')
const { getCommitSHA, getRepositoryUrl, isGitAvailable } = require('../plugins/util/git')
const { filterSensitiveInfoFromRepository } = require('../plugins/util/url')

/**
 * @typedef {{ commitSHA: string | undefined, repositoryUrl: string | undefined }} GitMetadata
 * Cache enabled and disabled results independently: a disabled first call must not
 * short-circuit a later enabled initialization in the same process (mirrors git_metadata.js).
 * @type {{ enabled?: GitMetadata, disabled?: GitMetadata }}
 */
const cache = {}

/**
 * Resolve the git commit sha and repository url to tag LLMObs spans and
 * experiments with. Widens coverage beyond the APM file/env resolver: in a
 * typical local dev checkout the `DD_GIT_*` env vars and `git.properties` file
 * aren't present, so we fall back to the `git` CLI for whatever the file/env
 * reads missed. Both sources run at most once and the result is cached for the
 * process lifetime, so the CLI subprocess never touches a hot path. Honors
 * `DD_TRACE_GIT_METADATA_ENABLED`.
 *
 * @param {import('../config/config-types').ConfigProperties} config
 * @returns {GitMetadata}
 */
function resolveLLMObsGitMetadata (config) {
  if (!config.DD_TRACE_GIT_METADATA_ENABLED) {
    cache.disabled ??= { commitSHA: undefined, repositoryUrl: undefined }
    return cache.disabled
  }
  if (cache.enabled) return cache.enabled

  let { commitSHA, repositoryUrl } = getGitMetadata(config)

  // Only spawn the CLI when the file/env reads left something missing and we are
  // inside a git checkout with git installed. Gating on the .git folder keeps
  // no-repo production images (git present, no checkout) from spawning
  // `git rev-parse` and emitting per-startup "not a git repository" error logs.
  if (!commitSHA || !repositoryUrl) {
    const gitFolder = config.DD_GIT_FOLDER_PATH ?? path.join(process.cwd(), '.git')
    if (fs.existsSync(gitFolder) && isGitAvailable()) {
      commitSHA ||= getCommitSHA() || undefined
      repositoryUrl ||= filterSensitiveInfoFromRepository(getRepositoryUrl()) || undefined
    }
  }

  cache.enabled = { commitSHA, repositoryUrl }
  return cache.enabled
}

module.exports = resolveLLMObsGitMetadata
