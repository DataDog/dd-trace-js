const { GIT_BRANCH, GIT_COMMIT_SHA } = require('./git')

const BUILD_SOURCE_ROOT = 'build.source_root'
const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NAME = 'ci.pipeline.name'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PROVIDER_NAME = 'ci.provider.name'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const GIT_REPOSITORY_URL = 'git.repository_url'

module.exports = {
  BUILD_SOURCE_ROOT,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  getCIMetadata () {
    const { env } = process

    if (env.JENKINS_URL) {
      const {
        WORKSPACE,
        BUILD_TAG,
        JOB_NAME,
        BUILD_NUMBER,
        BUILD_URL,
        GIT_BRANCH: JENKINS_GIT_BRANCH,
        GIT_COMMIT: JENKINS_GIT_COMMIT,
        JENKINS_GIT_REPOSITORY_URL
      } = env
      return {
        [BUILD_SOURCE_ROOT]: WORKSPACE,
        [CI_PIPELINE_ID]: BUILD_TAG,
        [CI_PIPELINE_NAME]: JOB_NAME,
        [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
        [CI_PIPELINE_URL]: BUILD_URL,
        [CI_PROVIDER_NAME]: 'jenkins',
        [CI_WORKSPACE_PATH]: WORKSPACE,
        [GIT_BRANCH]: JENKINS_GIT_BRANCH,
        [GIT_COMMIT_SHA]: JENKINS_GIT_COMMIT,
        [GIT_REPOSITORY_URL]: JENKINS_GIT_REPOSITORY_URL
      }
    }

    if (env.GITLAB_CI) {
      const {
        CI_PIPELINE_ID: GITLAB_PIPELINE_ID,
        CI_PROJECT_PATH,
        CI_PIPELINE_IID,
        CI_PIPELINE_URL,
        CI_PROJECT_DIR,
        CI_COMMIT_BRANCH,
        CI_COMMIT_SHA,
        CI_REPOSITORY_URL
      } = env
      return {
        [BUILD_SOURCE_ROOT]: CI_PROJECT_DIR,
        [CI_PIPELINE_ID]: GITLAB_PIPELINE_ID,
        [CI_PIPELINE_NAME]: CI_PROJECT_PATH,
        [CI_PIPELINE_NUMBER]: CI_PIPELINE_IID,
        [CI_PIPELINE_URL]: `${(CI_PIPELINE_URL || '').replace('/-/pipelines/', '/pipelines/')}`,
        [CI_PROVIDER_NAME]: 'gitlab',
        [CI_WORKSPACE_PATH]: CI_PROJECT_DIR,
        [GIT_BRANCH]: CI_COMMIT_BRANCH,
        [GIT_COMMIT_SHA]: CI_COMMIT_SHA,
        [GIT_REPOSITORY_URL]: CI_REPOSITORY_URL
      }
    }

    if (env.CIRCLECI) {
      const {
        CIRCLE_WORKFLOW_ID,
        CIRCLE_PROJECT_REPONAME,
        CIRCLE_BUILD_NUM,
        CIRCLE_BUILD_URL,
        CIRCLE_WORKING_DIRECTORY,
        CIRCLE_BRANCH,
        CIRCLE_SHA1,
        CIRCLE_REPOSITORY_URL
      } = env
      return {
        [BUILD_SOURCE_ROOT]: CIRCLE_WORKING_DIRECTORY,
        [CI_PIPELINE_ID]: CIRCLE_WORKFLOW_ID,
        [CI_PIPELINE_NAME]: CIRCLE_PROJECT_REPONAME,
        [CI_PIPELINE_NUMBER]: CIRCLE_BUILD_NUM,
        [CI_PIPELINE_URL]: CIRCLE_BUILD_URL,
        [CI_PROVIDER_NAME]: 'circleci',
        [CI_WORKSPACE_PATH]: CIRCLE_WORKING_DIRECTORY,
        [GIT_BRANCH]: CIRCLE_BRANCH,
        [GIT_COMMIT_SHA]: CIRCLE_SHA1,
        [GIT_REPOSITORY_URL]: CIRCLE_REPOSITORY_URL
      }
    }

    if (env.GITHUB_ACTIONS) {
      const {
        GITHUB_RUN_ID,
        GITHUB_WORKFLOW,
        GITHUB_RUN_NUMBER,
        GITHUB_WORKSPACE,
        GITHUB_REF,
        GITHUB_SHA,
        GITHUB_REPOSITORY
      } = env

      const repositoryURL = `https://github.com/${GITHUB_REPOSITORY}`
      const pipelineURL = `${repositoryURL}/actions/runs/${GITHUB_RUN_ID}`

      return {
        [BUILD_SOURCE_ROOT]: GITHUB_WORKSPACE,
        [CI_PIPELINE_ID]: GITHUB_RUN_ID,
        [CI_PIPELINE_NAME]: GITHUB_WORKFLOW,
        [CI_PIPELINE_NUMBER]: GITHUB_RUN_NUMBER,
        [CI_PIPELINE_URL]: pipelineURL,
        [CI_PROVIDER_NAME]: 'github',
        [CI_WORKSPACE_PATH]: GITHUB_WORKSPACE,
        [GIT_BRANCH]: GITHUB_REF,
        [GIT_COMMIT_SHA]: GITHUB_SHA,
        [GIT_REPOSITORY_URL]: repositoryURL
      }
    }
    return {}
  }
}
