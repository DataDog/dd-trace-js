const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('./constants')

class GitMetadataTagger {
  constructor (config) {
    this._config = config
  }

  tagGitMetadata (spanContext) {
    if (this._config.gitMetadataEnabled) {
      // These tags are added only to the local root span
      spanContext._trace.tags[SCI_COMMIT_SHA] = this._config.commitSHA
      spanContext._trace.tags[SCI_REPOSITORY_URL] = this._config.repositoryUrl
    }
  }
}

module.exports = GitMetadataTagger
