const { exec } = require('child_process')
const { promisify } = require('util')

const promiseExec = promisify(exec)

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

async function getGitInformation () {
  const sanitizeStdout = (stdout) => stdout.replace(/(\r\n|\n|\r)/gm, '')
  try {
    const [{ stdout: readRepository }, { stdout: readBranch }, { stdout: readCommit }] = await Promise.all([
      promiseExec('git ls-remote --get-url'),
      promiseExec('git branch --show-current'),
      promiseExec('git rev-parse HEAD')
    ])
    return {
      repository: sanitizeStdout(readRepository),
      branch: sanitizeStdout(readBranch),
      commit: sanitizeStdout(readCommit)
    }
  } catch (e) {
    return {
      repository: '',
      branch: '',
      commit: ''
    }
  }
}

function finishStartedSpans () {
  global.tracer
    .scope()
    .active()
    ._spanContext._trace.started.forEach((span) => {
      span.finish()
    })
}

function setTestStatus (status) {
  global.tracer.scope().active().setTag(TEST_STATUS, status)
}

module.exports = function (BaseEnvironment) {
  return class DatadogJestEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      this.testSuite = context.testPath.replace(`${config.rootDir}/`, '')
      this.rootDir = config.rootDir
    }
    async setup () {
      if (!global.tracer) {
        const ciMetadata = getCIMetadata()
        const { repository, branch, commit } = await getGitInformation()
        global.tracer = require('../../dd-trace').init({
          sampleRate: 1,
          flushInterval: 1,
          startupLogs: false,
          ingestion: {
            sampleRate: 1
          },
          tags: {
            ...ciMetadata,
            [GIT_COMMIT_SHA]: commit,
            [GIT_BRANCH]: process.env.TESTING_BRANCH,
            [GIT_REPOSITORY_URL]: repository,
            [BUILD_SOURCE_ROOT]: this.rootDir,
            [TEST_FRAMEWORK]: 'jest'
          }
        })
      }

      return super.setup()
    }
    async teardown () {
      await new Promise((resolve) => {
        global.tracer._tracer._exporter._writer.flush(resolve)
      })
      return super.teardown()
    }

    async handleTestEvent (event) {
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        global.tracer.startSpan(
          'jest.test',
          {
            tags: {
              type: 'test',
              resource: `${event.test.parent.name}.${event.test.name}`,
              [TEST_TYPE]: 'test',
              [TEST_NAME]: event.test.name,
              [TEST_SUITE]: this.testSuite,
              [TEST_STATUS]: 'skip'
            }
          }
        ).finish()
      }
      if (event.name === 'test_start') {
        const originalSpecFunction = event.test.fn
        if (originalSpecFunction.length) {
          event.test.fn = global.tracer.wrap(
            'jest.test',
            { type: 'test',
              resource: `${event.test.parent.name}.${event.test.name}`,
              tags: {
                [TEST_TYPE]: 'test',
                [TEST_NAME]: event.test.name,
                [TEST_SUITE]: this.testSuite
              } },
            () => {
              const promisifiedSpecFunction = promisify(originalSpecFunction)
              return promisifiedSpecFunction()
                .then(() => {
                  setTestStatus('pass')
                })
                .catch((err) => {
                  setTestStatus('fail')
                  throw err
                })
                .finally(finishStartedSpans)
            }
          )
        } else {
          event.test.fn = global.tracer.wrap(
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
                result = await originalSpecFunction()
                setTestStatus('pass')
              } catch (error) {
                setTestStatus('fail')
                throw error
              } finally {
                finishStartedSpans()
              }
              return result
            }
          )
        }
      }
    }
  }
}
