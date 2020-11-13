const { promisify } = require('util')
const { exec } = require('child_process')

const asyncExec = promisify(exec)
const sanitizeStdout = (stdout) => stdout.replace(/(\r\n|\n|\r)/gm, '')

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
  try {
    const [{ stdout: readRepository }, { stdout: readBranch }, { stdout: readCommit }] = await Promise.all([
      asyncExec('git ls-remote --get-url'),
      asyncExec('git branch --show-current'),
      asyncExec('git rev-parse HEAD')
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
            [GIT_BRANCH]: branch,
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
        global.tracer.trace(
          'jest.test',
          { type: 'test', resource: `${event.test.parent.name}.${event.test.name}` },
          (span) => {
            span.addTags({
              [TEST_TYPE]: 'test',
              [TEST_NAME]: event.test.name,
              [TEST_SUITE]: this.testSuite,
              [TEST_STATUS]: 'skip',
            })
          }
        )
      }
      if (event.name === 'test_start') {
        const originalSpecFunction = event.test.fn
        if (originalSpecFunction.length) {
          event.test.fn = global.tracer.wrap(
            'jest.test',
            { type: 'test', resource: `${event.test.parent.name}.${event.test.name}` },
            () => {
              global.tracer
                .scope()
                .active()
                .addTags({
                  [TEST_TYPE]: 'test',
                  [TEST_NAME]: event.test.name,
                  [TEST_SUITE]: this.testSuite
                })
              return new Promise((resolve, reject) => {
                originalSpecFunction((err) => {
                  if (err) {
                    global.tracer.scope().active().setTag(TEST_STATUS, 'fail')
                    reject(err)
                  } else {
                    global.tracer.scope().active().setTag(TEST_STATUS, 'pass')
                    resolve()
                  }
                  global.tracer
                    .scope()
                    .active()
                    ._spanContext._trace.started.forEach((span) => {
                      span.finish()
                    })
                })
              })
            }
          )
        } else {
          event.test.fn = global.tracer.wrap(
            'jest.test',
            { type: 'test', resource: `${event.test.parent.name}.${event.test.name}` },
            () => {
              let result
              global.tracer
                .scope()
                .active()
                .addTags({
                  [TEST_TYPE]: 'test',
                  [TEST_NAME]: event.test.name,
                  [TEST_SUITE]: this.testSuite
                })
              try {
                result = originalSpecFunction()
              } catch (error) {
                global.tracer.scope().active().setTag(TEST_STATUS, 'fail')
                global.tracer
                  .scope()
                  .active()
                  ._spanContext._trace.started.forEach((span) => {
                    span.finish()
                  })
                throw error
              }

              if (result && result.then) {
                return result
                  .then(() => {
                    global.tracer.scope().active().setTag(TEST_STATUS, 'pass')
                  })
                  .catch((err) => {
                    global.tracer.scope().active().setTag(TEST_STATUS, 'fail')
                    throw err
                  })
                  .finally(() => {
                    global.tracer
                      .scope()
                      .active()
                      ._spanContext._trace.started.forEach((span) => {
                        span.finish()
                      })
                  })
              }
              global.tracer.scope().active().setTag(TEST_STATUS, 'pass')
              global.tracer
                .scope()
                .active()
                ._spanContext._trace.started.forEach((span) => {
                  span.finish()
                })
              return result
            }
          )
        }
      }
    }
  }
}
