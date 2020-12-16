const { GIT_BRANCH, GIT_COMMIT_SHA } = require('./git')

const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const CI_PROVIDER_NAME = 'ci.provider.name'
const BUILD_SOURCE_ROOT = 'build.source_root'

module.exports = {
  CI_PIPELINE_URL,
  CI_PIPELINE_ID,
  CI_PIPELINE_NUMBER,
  CI_WORKSPACE_PATH,
  CI_PROVIDER_NAME,
  BUILD_SOURCE_ROOT,
  getCIMetadata () {
    const { env } = process

    if (env.JENKINS_URL) {
      const { BUILD_URL, GIT_COMMIT, GIT_BRANCH, BUILD_ID, BUILD_NUMBER, WORKSPACE } = env
      return {
        [CI_PIPELINE_URL]: BUILD_URL,
        [CI_PIPELINE_ID]: BUILD_ID,
        [CI_PROVIDER_NAME]: 'jenkins',
        [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
        [CI_WORKSPACE_PATH]: WORKSPACE,
        [GIT_BRANCH]: GIT_BRANCH,
        [GIT_COMMIT_SHA]: GIT_COMMIT,
        [BUILD_SOURCE_ROOT]: WORKSPACE
      }
    }

    if (env.GITLAB_CI) {
      const { CI_JOB_URL, CI_COMMIT_SHA, CI_COMMIT_BRANCH, CI_BUILD_ID, CI_PROJECT_PATH } = env
      return {
        [CI_PIPELINE_URL]: CI_JOB_URL,
        [CI_PIPELINE_ID]: CI_BUILD_ID,
        [CI_PROVIDER_NAME]: 'gitlab',
        [CI_WORKSPACE_PATH]: CI_PROJECT_PATH,
        [GIT_BRANCH]: CI_COMMIT_BRANCH,
        [GIT_COMMIT_SHA]: CI_COMMIT_SHA,
        [BUILD_SOURCE_ROOT]: CI_PROJECT_PATH
      }
    }

    if (env.CIRCLECI) {
      const {
        CIRCLE_BUILD_URL,
        CIRCLE_BUILD_NUM,
        CIRCLE_WORKFLOW_ID,
        CIRCLE_WORKING_DIRECTORY,
        CIRCLE_SHA1,
        CIRCLE_BRANCH
      } = env
      return {
        [CI_PIPELINE_URL]: CIRCLE_BUILD_URL,
        [CI_PIPELINE_ID]: CIRCLE_WORKFLOW_ID,
        [CI_PROVIDER_NAME]: 'circleci',
        [CI_PIPELINE_NUMBER]: CIRCLE_BUILD_NUM,
        [CI_WORKSPACE_PATH]: CIRCLE_WORKING_DIRECTORY,
        [GIT_BRANCH]: CIRCLE_BRANCH,
        [GIT_COMMIT_SHA]: CIRCLE_SHA1,
        [BUILD_SOURCE_ROOT]: CIRCLE_WORKING_DIRECTORY
      }
    }

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
        [BUILD_SOURCE_ROOT]: GITHUB_WORKSPACE
      }
    }
    return {}
  }
}
