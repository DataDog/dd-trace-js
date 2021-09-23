const { relative } = require('path')

const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')

const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SKIP_REASON,
  CI_APP_ORIGIN,
  ERROR_MESSAGE,
  getTestEnvironmentMetadata,
  finishAllTraceSpans
} = require('../../dd-trace/src/plugins/util/test')

function setStatusFromResult (span, result, tag) {
  if (result.status === 1) {
    span.setTag(tag, 'pass')
  } else if (result.status === 2) {
    span.setTag(tag, 'skip')
  } else if (result.status === 4) {
    span.setTag(tag, 'skip')
    span.setTag(TEST_SKIP_REASON, 'not implemented')
  } else {
    span.setTag(tag, 'fail')
    span.setTag(ERROR_MESSAGE, result.message)
  }
}

function setStatusFromResultLatest (span, result, tag) {
  if (result.status === 'PASSED') {
    span.setTag(tag, 'pass')
  } else if (result.status === 'SKIPPED' || result.status === 'PENDING') {
    span.setTag(tag, 'skip')
  } else if (result.status === 'UNDEFINED') {
    span.setTag(tag, 'skip')
    span.setTag(TEST_SKIP_REASON, 'not implemented')
  } else {
    span.setTag(tag, 'fail')
    span.setTag(ERROR_MESSAGE, result.message)
  }
}

function createWrapRun (tracer, testEnvironmentMetadata, getTestSuiteName, setStatus) {
  return function wrapRun (run) {
    return function handleRun () {
      const testName = this.pickle.name
      const testSuite = getTestSuiteName(this.pickle.uri)

      const commonSpanTags = {
        [TEST_TYPE]: 'test',
        [TEST_NAME]: testName,
        [TEST_SUITE]: testSuite,
        [SAMPLING_RULE_DECISION]: 1,
        ...testEnvironmentMetadata
      }

      return tracer.trace(
        'cucumber.test',
        {
          type: 'test',
          resource: testName,
          tags: commonSpanTags
        },
        (testSpan) => {
          testSpan.context()._trace.origin = CI_APP_ORIGIN
          const promise = run.apply(this, arguments)
          promise.then(() => {
            setStatus(testSpan, this.getWorstStepResult(), TEST_STATUS)
          }).finally(() => {
            finishAllTraceSpans(testSpan)
          })
          return promise
        }
      )
    }
  }
}

function createWrapRunStep (tracer, getResourceName, setStatus) {
  return function wrapRunStep (runStep) {
    return function handleRunStep () {
      const resource = getResourceName(arguments[0])
      return tracer.trace(
        'cucumber.step',
        { resource, tags: { 'cucumber.step': resource } },
        (span) => {
          const promise = runStep.apply(this, arguments)
          promise.then((result) => {
            setStatus(span, result, 'step.status')
          })
          return promise
        }
      )
    }
  }
}

module.exports = [
  {
    name: '@cucumber/cucumber',
    versions: ['7.0.0 - 7.2.1'],
    file: 'lib/runtime/pickle_runner.js',
    patch (PickleRunner, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber')
      const sourceRoot = process.cwd()
      const getTestSuiteName = (pickleUri) => {
        return relative(sourceRoot, pickleUri)
      }
      const pl = PickleRunner.default
      this.wrap(
        pl.prototype,
        'run',
        createWrapRun(tracer, testEnvironmentMetadata, getTestSuiteName, setStatusFromResult)
      )
      const getResourceName = (testStep) => {
        return testStep.isHook ? 'hook' : testStep.pickleStep.text
      }
      this.wrap(pl.prototype, 'runStep', createWrapRunStep(tracer, getResourceName, setStatusFromResult))
    },
    unpatch (PickleRunner) {
      const pl = PickleRunner.default
      this.unwrap(pl.prototype, 'run')
      this.unwrap(pl.prototype, 'runStep')
    }
  },
  {
    name: '@cucumber/cucumber',
    versions: ['>=7.3.0'],
    file: 'lib/runtime/test_case_runner.js',
    patch (TestCaseRunner, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber')
      const sourceRoot = process.cwd()
      const getTestSuiteName = (pickleUri) => {
        return relative(sourceRoot, pickleUri)
      }
      const pl = TestCaseRunner.default
      this.wrap(
        pl.prototype,
        'run',
        createWrapRun(tracer, testEnvironmentMetadata, getTestSuiteName, setStatusFromResultLatest)
      )
      const getResourceName = (testStep) => {
        return testStep.text
      }
      this.wrap(pl.prototype, 'runStep', createWrapRunStep(tracer, getResourceName, setStatusFromResultLatest))
    },
    unpatch (TestCaseRunner) {
      const pl = TestCaseRunner.default
      this.unwrap(pl.prototype, 'run')
      this.unwrap(pl.prototype, 'runStep')
    }
  }
]
