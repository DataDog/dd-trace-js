const { channel } = require('diagnostics_channel')

const { getTestEnvironmentMetadata, getCodeOwnersFileEntries } = require('./util/test')
const { getItrConfiguration } = require('../ci-visibility/intelligent-test-runner/get-itr-configuration')
const { getSkippableSuites } = require('../ci-visibility/intelligent-test-runner/get-skippable-suites')

const Plugin = require('./plugin')

module.exports = class CiPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    const gitMetadataUploadFinishCh = channel('ci:git-metadata-upload:finish')
    // `gitMetadataPromise` is used to wait until git metadata is uploaded to
    // proceed with calculating the suites to skip
    // TODO: add timeout after which the promise is resolved
    const gitMetadataPromise = new Promise(resolve => {
      gitMetadataUploadFinishCh.subscribe(err => {
        resolve(err)
      })
    })

    this.testEnvironmentMetadata = getTestEnvironmentMetadata(this.constructor.name, this.config)
    this.codeOwnersEntries = getCodeOwnersFileEntries()

    const {
      'git.repository_url': repositoryUrl,
      'git.commit.sha': sha,
      'os.version': osVersion,
      'os.platform': osPlatform,
      'os.architecture': osArchitecture,
      'runtime.name': runtimeName,
      'runtime.version': runtimeVersion,
      'git.branch': branch
    } = this.testEnvironmentMetadata

    const testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch
    }

    this.addSub(`ci:${this.constructor.name}:configuration`, ({ onDone }) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        onDone({ config: {} })
        return
      }
      getItrConfiguration({
        ...testConfiguration,
        url: this.config.url,
        site: this.config.site,
        env: this.tracer._env,
        service: this.config.service || this.tracer._service
      }, (err, config) => {
        if (err) {
          onDone({ err })
        } else {
          this.itrConfig = config
          onDone({ config })
        }
      })
    })

    // jest one
    this.addSub(`ci:${this.constructor.name}:test-suite:skippable`, ({ onDone }) => {
      if (!this.config.isAgentlessEnabled || !this.config.isIntelligentTestRunnerEnabled) {
        return onDone({ skippableSuites: [] })
      }
      // we only request after git upload has happened, if it didn't fail
      gitMetadataPromise.then((gitUploadError) => {
        if (gitUploadError) {
          return onDone({ err: gitUploadError })
        }
        if (!this.itrConfig || !this.itrConfig.isSuitesSkippingEnabled) {
          return onDone(null, [])
        }
        getSkippableSuites({
          ...testConfiguration,
          url: this.config.url,
          site: this.config.site,
          env: this.tracer._env,
          service: this.config.service || this.tracer._service
        }, (err, skippableSuites) => {
          if (err) {
            onDone({ err })
          } else {
            onDone({ skippableSuites })
          }
        })
      })
    })
  }
}
