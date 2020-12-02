const id = require('../../dd-trace/src/id')
const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')

const { execSync } = require('child_process')
const { promisify } = require('util')

const GIT_COMMIT_SHA = 'git.commit.sha'
// TODO: remove this once CI App's UI and backend are ready
const DEPRECATED_GIT_COMMIT_SHA = 'git.commit_sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'
const BUILD_SOURCE_ROOT = 'build.source_root'
const TEST_FRAMEWORK = 'test.framework'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const CI_PROVIDER_NAME = 'ci.provider.name'

const SPAN_TYPE = 'span.type'
const RESOURCE_NAME = 'resource.name'

function getCIMetadata () {
  const { env } = process
  if (env.GITHUB_ACTIONS) {
    const { GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER, GITHUB_WORKSPACE } = env

    const pipelineURL = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

    return {
      [CI_PIPELINE_URL]: pipelineURL,
      [CI_PIPELINE_ID]: GITHUB_RUN_ID,
      [CI_PROVIDER_NAME]: 'github',
      [CI_PIPELINE_NUMBER]: GITHUB_RUN_NUMBER,
      [CI_WORKSPACE_PATH]: GITHUB_WORKSPACE,
      [GIT_BRANCH]: GITHUB_REF,
      [GIT_COMMIT_SHA]: GITHUB_SHA,
      [DEPRECATED_GIT_COMMIT_SHA]: GITHUB_SHA
    }
  }
  return {}
}

const sanitizedRun = cmd => {
  try {
    return execSync(cmd).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

function getGitMetadata () {
  const commitSha = sanitizedRun('git rev-parse HEAD')
  return {
    [GIT_REPOSITORY_URL]: sanitizedRun('git ls-remote --get-url'),
    [GIT_BRANCH]: sanitizedRun('git branch --show-current'),
    [GIT_COMMIT_SHA]: commitSha,
    [DEPRECATED_GIT_COMMIT_SHA]: commitSha
  }
}

function getEnvMetadata () {
  return {
    [BUILD_SOURCE_ROOT]: sanitizedRun('pwd')
  }
}

function getTestMetadata () {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const gitMetadata = getGitMetadata()
  const envMetadata = getEnvMetadata()

  return {
    [TEST_FRAMEWORK]: 'jest',
    ...ciMetadata,
    ...gitMetadata,
    ...envMetadata
  }
}

function wrapEnvironment (BaseEnvironment) {
  return class DatadogJestEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = context.testPath.replace(`${config.rootDir}/`, '')
    }
  }
}

function createWrapTeardown (tracer) {
  return function wrapTeardown (teardown) {
    return async function teardownWithTrace () {
      await new Promise((resolve) => {
        tracer._exporter._writer.flush(resolve)
      })
      return teardown.apply(this, arguments)
    }
  }
}

function createHandleTestEvent (tracer, testMetadata) {
  return async function handleTestEventWithTrace (event) {
    if (event.name !== 'test_skip' && event.name !== 'test_todo' && event.name !== 'test_start') {
      return
    }
    const childOf = tracer.extract('text_map', {
      'x-datadog-trace-id': id().toString(10),
      'x-datadog-parent-id': '0000000000000000',
      'x-datadog-sampled': 1
    })
    const commonSpanTags = {
      [TEST_TYPE]: 'test',
      [TEST_NAME]: event.test.name,
      [TEST_SUITE]: this.testSuite,
      [SAMPLING_RULE_DECISION]: 1,
      [SAMPLING_PRIORITY]: AUTO_KEEP,
      ...testMetadata
    }
    const resource = `${event.test.parent.name}.${event.test.name}`
    if (event.name === 'test_skip' || event.name === 'test_todo') {
      tracer.startSpan(
        'jest.test',
        {
          childOf,
          tags: {
            ...commonSpanTags,
            [SPAN_TYPE]: 'test',
            [RESOURCE_NAME]: resource,
            [TEST_STATUS]: 'skip'
          }
        }
      ).finish()
      return
    }
    // event.name === test_start at this point
    let specFunction = event.test.fn
    if (specFunction.length) {
      specFunction = promisify(specFunction)
    }
    event.test.fn = tracer.wrap(
      'jest.test',
      { type: 'test',
        childOf,
        resource,
        tags: commonSpanTags
      },
      async () => {
        let result
        try {
          result = await specFunction()
          tracer.scope().active().setTag(TEST_STATUS, 'pass')
        } catch (error) {
          tracer.scope().active().setTag(TEST_STATUS, 'fail')
          throw error
        } finally {
          tracer
            .scope()
            .active()
            .context()._trace.started.forEach((span) => {
              span.finish()
            })
        }
        return result
      }
    )
  }
}

module.exports = [
  {
    name: 'jest-environment-node',
    versions: ['>=24.8.0'],
    patch: function (NodeEnvironment, tracer) {
      const testMetadata = getTestMetadata()

      this.wrap(NodeEnvironment.prototype, 'teardown', createWrapTeardown(tracer))
      NodeEnvironment.prototype.handleTestEvent = createHandleTestEvent(tracer, testMetadata)
      return wrapEnvironment(NodeEnvironment)
    },
    unpatch: function (NodeEnvironment) {
      this.unwrap(NodeEnvironment.prototype, 'teardown')
      delete NodeEnvironment.prototype.handleTestEvent
    }
  },
  {
    name: 'jest-environment-jsdom',
    versions: ['>=24.8.0'],
    patch: function (JsdomEnvironment, tracer) {
      const testMetadata = getTestMetadata()

      this.wrap(JsdomEnvironment.prototype, 'teardown', createWrapTeardown(tracer))
      JsdomEnvironment.prototype.handleTestEvent = createHandleTestEvent(tracer, testMetadata)
      return wrapEnvironment(JsdomEnvironment)
    },
    unpatch: function (JsdomEnvironment) {
      this.unwrap(JsdomEnvironment.prototype, 'teardown')
      delete JsdomEnvironment.prototype.handleTestEvent
    }
  }
]
