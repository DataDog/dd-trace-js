const {
  getTestEnvironmentMetadata,
  getCodeOwnersFileEntries,
  getTestParentSpan,
  getTestCommonTags,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  CI_APP_ORIGIN
} = require('./util/test')
const { COMPONENT } = require('../constants')

const Plugin = require('./plugin')

module.exports = class CiPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`ci:${this.constructor.name}:itr-configuration`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getItrConfiguration) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getItrConfiguration(this.testConfiguration, (err, itrConfig) => {
        if (!err) {
          this.itrConfig = itrConfig
        }
        onDone({ err, itrConfig })
      })
    })

    this.addSub(`ci:${this.constructor.name}:test-suite:skippable`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getSkippableSuites) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getSkippableSuites(this.testConfiguration, (err, skippableSuites) => {
        onDone({ err, skippableSuites })
      })
    })
  }

  configure (config) {
    super.configure(config)
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

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch
    }
  }

  startTestSpan (name, suite, extraTags, childOf) {
    const parent = childOf || getTestParentSpan(this.tracer)
    const testCommonTags = getTestCommonTags(name, suite, this.tracer._version)

    const testTags = {
      ...testCommonTags,
      [COMPONENT]: this.constructor.name,
      ...extraTags
    }

    const codeOwners = getCodeOwnersForFilename(suite, this.codeOwnersEntries)

    if (codeOwners) {
      testTags[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan(`${this.constructor.name}.test`, {
        childOf: parent,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testTags
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}
