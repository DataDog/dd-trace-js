'use strict'

const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('./constants')
const getGitMetadata = require('./git_metadata')
const eventWriter = require('./opentracing/event-writer')

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
      eventWriter.setTraceTag(spanContext, SCI_COMMIT_SHA, this.#commitSHA)
      eventWriter.setTraceTag(spanContext, SCI_REPOSITORY_URL, this.#repositoryUrl)
    }
  }
}

module.exports = GitMetadataTagger
