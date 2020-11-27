const { execSync } = require('child_process')
const { promisify } = require('util')

const GIT_COMMIT_SHA = 'git.commit_sha'
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
      [GIT_COMMIT_SHA]: GITHUB_SHA
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
  return {
    [GIT_REPOSITORY_URL]: sanitizedRun('git ls-remote --get-url'),
    [GIT_BRANCH]: process.env.TESTING_BRANCH, //sanitizedRun('git branch --show-current'),
    [GIT_COMMIT_SHA]: sanitizedRun('git rev-parse HEAD')
  }
}

function wrapEnvironment (tracer, BaseEnvironment) {
  return class DatadogJestEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = context.testPath.replace(`${config.rootDir}/`, '')
      this.tracer = tracer
      this.tracer._tags[BUILD_SOURCE_ROOT] = config.rootDir
    }
    async teardown () {
      await new Promise((resolve) => {
        this.tracer._exporter._writer.flush(resolve)
      })
      return super.teardown()
    }

    async handleTestEvent (event) {
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        this.tracer.startSpan(
          'jest.test',
          {
            tags: {
              // Since we are using `startSpan` we can't use `type` and `resource` options
              // so we have to manually set the tags.
              [SPAN_TYPE]: 'test',
              [RESOURCE_NAME]: `${event.test.parent.name}.${event.test.name}`,
              [TEST_TYPE]: 'test',
              [TEST_NAME]: event.test.name,
              [TEST_SUITE]: this.testSuite,
              [TEST_STATUS]: 'skip'
            }
          }
        ).finish()
      }
      if (event.name === 'test_start') {
        let specFunction = event.test.fn
        if (specFunction.length) {
          specFunction = promisify(specFunction)
        }
        event.test.fn = this.tracer.wrap(
          'jest.test',
          { type: 'test',
            resource: `${event.test.parent.name}.${event.test.name}`,
            tags: {
              [TEST_TYPE]: 'test',
              [TEST_NAME]: event.test.name,
              [TEST_SUITE]: this.testSuite
            } },
          async () => {
            let result
            try {
              result = await specFunction()
              this.tracer.scope().active().setTag(TEST_STATUS, 'pass')
            } catch (error) {
              this.tracer.scope().active().setTag(TEST_STATUS, 'fail')
              throw error
            } finally {
              this.tracer
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
  }
}

module.exports = {
  name: 'jest-environment-node',
  // ** Important: This needs to be the same as the versions for datadog-plugin-jest-circus
  versions: ['>=24.8.0'],
  patch: function (NodeEnvironment, tracer) {
    const ciMetadata = getCIMetadata()
    const gitMetadata = getGitMetadata()
    tracer._tags = {
      ...tracer._tags,
      [TEST_FRAMEWORK]: 'jest',
      ...ciMetadata,
      ...gitMetadata
    }
    return wrapEnvironment(tracer, NodeEnvironment)
  }
}
