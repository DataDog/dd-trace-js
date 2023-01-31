'use strict'

const URL = require('url').URL

const { sendGitMetadata: sendGitMetadataRequest } = require('./git/git_metadata')
const { getItrConfiguration: getItrConfigurationRequest } = require('../intelligent-test-runner/get-itr-configuration')
const { getSkippableSuites: getSkippableSuitesRequest } = require('../intelligent-test-runner/get-skippable-suites')
const log = require('../../log')
const AgentInfoExporter = require('../../exporters/common/agent-info-exporter')

function getIsTestSessionTrace (trace) {
  return trace.some(span =>
    span.type === 'test_session_end' || span.type === 'test_suite_end' || span.type === 'test_module_end'
  )
}

class CiVisibilityExporter extends AgentInfoExporter {
  constructor (config) {
    super(config)
    this._timer = undefined
    this._coverageTimer = undefined
    this._coverageBuffer = []
    // The library can use new features like ITR and test suite level visibility
    // AKA CI Vis Protocol
    this._canUseCiVisProtocol = false

    // TODO: add timeout to reject this promise
    this._gitUploadPromise = new Promise(resolve => {
      this._resolveGit = resolve
    })

    // TODO: add timeout to reject this promise
    this._canUseCiVisProtocolPromise = new Promise(resolve => {
      this._resolveCanUseCiVisProtocol = (canUseCiVisProtocol) => {
        this._canUseCiVisProtocol = canUseCiVisProtocol
        resolve(canUseCiVisProtocol)
      }
    })

    process.once('beforeExit', () => {
      if (this._writer) {
        this._writer.flush()
      }
      if (this._coverageWriter) {
        this._coverageWriter.flush()
      }
    })
  }

  shouldRequestSkippableSuites () {
    return !!(this._config.isIntelligentTestRunnerEnabled &&
      this._canUseCiVisProtocol &&
      this._itrConfig &&
      this._itrConfig.isSuitesSkippingEnabled)
  }

  shouldRequestItrConfiguration () {
    return this._config.isIntelligentTestRunnerEnabled
  }

  canReportSessionTraces () {
    return this._canUseCiVisProtocol
  }

  canReportCodeCoverage () {
    return this._canUseCiVisProtocol
  }

  // We can't call the skippable endpoint until git upload has finished,
  // hence the this._gitUploadPromise.then
  getSkippableSuites (testConfiguration, callback) {
    if (!this.shouldRequestSkippableSuites()) {
      return callback(null, [])
    }
    this._gitUploadPromise.then(gitUploadError => {
      if (gitUploadError) {
        return callback(gitUploadError, [])
      }
      const configuration = {
        url: this._getApiUrl(),
        site: this._config.site,
        env: this._config.env,
        service: this._config.service,
        isEvpProxy: !!this._isUsingEvpProxy,
        ...testConfiguration
      }
      getSkippableSuitesRequest(configuration, callback)
    })
  }

  /**
   * We can't request ITR configuration until we know whether we can use the
   * CI Visibility Protocol, hence the this._canUseCiVisProtocol promise.
   */
  getItrConfiguration (testConfiguration, callback) {
    if (!this.shouldRequestItrConfiguration()) {
      return callback(null, {})
    }
    this._canUseCiVisProtocolPromise.then((canUseCiVisProtocol) => {
      if (!canUseCiVisProtocol) {
        return callback(null, {})
      }
      const configuration = {
        url: this._getApiUrl(),
        env: this._config.env,
        service: this._config.service,
        isEvpProxy: !!this._isUsingEvpProxy,
        ...testConfiguration
      }
      getItrConfigurationRequest(configuration, (err, itrConfig) => {
        /**
         * **Important**: this._itrConfig remains empty in testing frameworks
         * where the tests run in a subprocess, because `getItrConfiguration` is called only once.
         */
        this._itrConfig = itrConfig
        callback(err, itrConfig)
      })
    })
  }

  sendGitMetadata ({ url, isEvpProxy }) {
    sendGitMetadataRequest(url, isEvpProxy, (err) => {
      if (err) {
        log.error(`Error uploading git metadata: ${err.message}`)
      } else {
        log.debug('Successfully uploaded git metadata')
      }
      this._resolveGit(err)
    })
  }

  export (trace) {
    // Until it's initialized, we just store the traces as is
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    if (!this.canReportSessionTraces() && getIsTestSessionTrace(trace)) {
      return
    }
    this._export(trace)
  }

  exportCoverage (coveragePayload) {
    // Until it's initialized, we just store the coverages as is
    if (!this._isInitialized) {
      this._coverageBuffer.push(coveragePayload)
      return
    }
    if (!this.canReportCodeCoverage()) {
      return
    }

    const { span, coverageFiles } = coveragePayload
    const formattedCoverage = {
      traceId: span.context()._traceId,
      spanId: span.context()._spanId,
      files: coverageFiles
    }

    this._export(formattedCoverage, this._coverageWriter, '_coverageTimer')
  }

  flush (done = () => {}) {
    if (!this._isInitialized) {
      return done()
    }
    this._writer.flush(() => {
      if (this._coverageWriter) {
        this._coverageWriter.flush(done)
      } else {
        done()
      }
    })
  }

  exportUncodedCoverages () {
    this._coverageBuffer.forEach(oldCoveragePayload => {
      this.exportCoverage(oldCoveragePayload)
    })
    this._coverageBuffer = []
  }

  _setUrl (url, coverageUrl = url) {
    try {
      url = new URL(url)
      coverageUrl = new URL(coverageUrl)
      this._url = url
      this._coverageUrl = coverageUrl
      this._writer.setUrl(url)
      this._coverageWriter.setUrl(coverageUrl)
    } catch (e) {
      log.error(e)
    }
  }

  _getApiUrl () {
    return this._url
  }
}

module.exports = CiVisibilityExporter
