'use strict'

const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('./constants')
const getGitMetadata = require('./git_metadata')

class GitMetadataTagger {
  #commitSHA
  #repositoryUrl
  #enabled

  constructor (config) {
    this.#enabled = config.DD_TRACE_GIT_METADATA_ENABLED
    const { commitSHA, repositoryUrl } = getGitMetadata(config)
    this.#commitSHA = commitSHA
    this.#repositoryUrl = repositoryUrl
  }

  tagGitMetadata (spanContext) {
    if (this.#enabled) {
      const tags = spanContext._trace.tags
      tags[SCI_COMMIT_SHA] = this.#commitSHA
      tags[SCI_REPOSITORY_URL] = this.#repositoryUrl
    }
  }
}

module.exports = GitMetadataTagger
