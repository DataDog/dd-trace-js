const { relative } = require('path')

const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')

const {
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  getTestEnvironmentMetadata
} = require('../../dd-trace/src/plugins/util/test')

function setStatusFromResult (span, result) {
  if (result.status === 1) {
    span.setTag(TEST_STATUS, 'pass')
  } else if (result.status === 2) {
    span.setTag(TEST_STATUS, 'skip')
    span.setTag('error.msg', 'skipped')
  } else if (result.status === 4) {
    span.setTag(TEST_STATUS, 'skip')
    span.setTag('error.msg', 'not implemented')
  } else {
    span.setTag(TEST_STATUS, 'fail')
    span.setTag('error.msg', result.message)
  }
}

function createWrapRun (tracer, testEnvironmentMetadata, sourceRoot) {
  return function wrapRun (run) {
    return function handleRun () {
      const testName = this.pickle.name
      const testSuite = relative(sourceRoot, this.pickle.uri)

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
        async (span) => {
          const promise = run.apply(this, arguments)
          promise.then(() => {
            setStatusFromResult(span, this.getWorstStepResult())
          })
          return promise
        }
      )
    }
  }
}

function createWrapRunStep (tracer) {
  return function wrapRunStep (runStep) {
    return function handleRunStep () {
      const resource = arguments[0].isHook ? 'hook' : arguments[0].pickleStep.text
      return tracer.trace(
        'cucumber.step',
        { type: 'test', resource: resource },
        async (span) => {
          const promise = runStep.apply(this, arguments)
          promise.then((result) => {
            setStatusFromResult(span, result)
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
    versions: ['>=7.0.0'],
    file: 'lib/runtime/pickle_runner.js',
    patch (PickleRunner, tracer) {
      const testEnvironmentMetadata = getTestEnvironmentMetadata('cucumber')
      const sourceRoot = process.cwd()
      const pl = PickleRunner.default
      this.wrap(pl.prototype, 'run', createWrapRun(tracer, testEnvironmentMetadata, sourceRoot))
      this.wrap(pl.prototype, 'runStep', createWrapRunStep(tracer))
    },
    unpatch (PickleRunner) {
      const pl = PickleRunner.default
      this.unwrap(pl.prototype, 'run')
      this.unwrap(pl.prototype, 'runStep')
    }
  }
]
