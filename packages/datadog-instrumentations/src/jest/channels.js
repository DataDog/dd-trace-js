'use strict'

const { channel } = require('../helpers/instrument')

const testSessionStartCh = channel('ci:jest:session:start')
const testSessionFinishCh = channel('ci:jest:session:finish')
const codeCoverageReportCh = channel('ci:jest:coverage-report')

const testSessionConfigurationCh = channel('ci:jest:session:configuration')

const testSuiteStartCh = channel('ci:jest:test-suite:start')
const testSuiteFinishCh = channel('ci:jest:test-suite:finish')
const testSuiteErrorCh = channel('ci:jest:test-suite:error')

const workerReportTraceCh = channel('ci:jest:worker-report:trace')
const workerReportCoverageCh = channel('ci:jest:worker-report:coverage')
const workerReportLogsCh = channel('ci:jest:worker-report:logs')
const workerReportTelemetryCh = channel('ci:jest:worker-report:telemetry')

const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')
const testFnCh = channel('ci:jest:test:fn')
const testSuiteHookFnCh = channel('ci:jest:test-suite:hook:fn')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const libraryConfigurationCh = channel('ci:jest:library-configuration')
const knownTestsCh = channel('ci:jest:known-tests')
const testManagementTestsCh = channel('ci:jest:test-management-tests')
const modifiedFilesCh = channel('ci:jest:modified-files')

const itrSkippedSuitesCh = channel('ci:jest:itr:skipped-suites')

// Message sent by jest's main process to workers to run a test suite (=test file)
// https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/types.ts#L37
const CHILD_MESSAGE_CALL = 1

// Maximum time we'll wait for the tracer to flush
const FLUSH_TIMEOUT = 10_000

// https://github.com/jestjs/jest/blob/41f842a46bb2691f828c3a5f27fc1d6290495b82/packages/jest-circus/src/types.ts#L9C8-L9C54
const RETRY_TIMES = Symbol.for('RETRY_TIMES')

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200
const ATR_RETRY_SUPPRESSION_FLAG = '_ddDisableAtrRetry'

module.exports = {
  testSessionStartCh,
  testSessionFinishCh,
  codeCoverageReportCh,
  testSessionConfigurationCh,
  testSuiteStartCh,
  testSuiteFinishCh,
  testSuiteErrorCh,
  workerReportTraceCh,
  workerReportCoverageCh,
  workerReportLogsCh,
  workerReportTelemetryCh,
  testSuiteCodeCoverageCh,
  testStartCh,
  testSkippedCh,
  testFinishCh,
  testErrCh,
  testFnCh,
  testSuiteHookFnCh,
  skippableSuitesCh,
  libraryConfigurationCh,
  knownTestsCh,
  testManagementTestsCh,
  modifiedFilesCh,
  itrSkippedSuitesCh,
  CHILD_MESSAGE_CALL,
  FLUSH_TIMEOUT,
  RETRY_TIMES,
  BREAKPOINT_HIT_GRACE_PERIOD_MS,
  ATR_RETRY_SUPPRESSION_FLAG,
}
