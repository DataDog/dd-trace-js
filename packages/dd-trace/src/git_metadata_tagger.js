'use strict'

const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('./constants')

class GitMetadataTagger {
  #config

  constructor (config) {
    this.#config = config
  }

  tagGitMetadata (spanContext) {
    if (this.#config.gitMetadataEnabled) {
      // These tags are added only to the local root span
      spanContext._trace.tags[SCI_COMMIT_SHA] = this.#config.commitSHA
      spanContext._trace.tags[SCI_REPOSITORY_URL] = this.#config.repositoryUrl
    }
  }
}

module.exports = GitMetadataTagger
