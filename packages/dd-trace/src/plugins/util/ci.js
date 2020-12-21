const { GIT_BRANCH, GIT_COMMIT_SHA, DEPRECATED_GIT_COMMIT_SHA, GIT_TAG } = require('./git')

const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NAME = 'ci.pipeline.name'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PROVIDER_NAME = 'ci.provider.name'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const GIT_REPOSITORY_URL = 'git.repository_url'
const CI_JOB_URL = 'ci.job.url'

function normalizeRef (ref) {
  if (!ref) {
    return ref
  }
  return ref.replace(/origin\/|refs\/heads\/|tags\//gm, '')
}

function filterSensitiveInfoFromRepository (repositoryUrl) {
  if (repositoryUrl.startsWith('git@')) {
    return repositoryUrl
  }
  try {
    const url = new URL(repositoryUrl)
    return `${url.protocol}//${url.hostname}${url.pathname}`
  } catch (e) {
    return repositoryUrl
  }
}

function resolveTilde (filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return ''
  }
  // '~/folder/path' or '~'
  if (filePath[0] === '~' && (filePath[1] === '/' || filePath.length === 1)) {
    return filePath.replace('~', process.env.HOME)
  }
  return filePath
}

module.exports = {
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
        GIT_URL: JENKINS_GIT_REPOSITORY_URL
      } = env

      const isTag = JENKINS_GIT_BRANCH && JENKINS_GIT_BRANCH.includes('tags')
      const finalRefKey = isTag ? GIT_TAG : GIT_BRANCH
      const ref = normalizeRef(JENKINS_GIT_BRANCH)

      let finalPipelineName = ''
      if (JOB_NAME) {
        const splittedPipelineName = JOB_NAME.split('/')
        // There are parameters
        if (splittedPipelineName.length > 1 && splittedPipelineName[1].includes('=')) {
          finalPipelineName = splittedPipelineName[0]
        } else {
          finalPipelineName = JOB_NAME.replace(`/${ref}`, '')
        }
      }

      const tags = {
        [CI_PIPELINE_ID]: BUILD_TAG,
        [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
        [CI_PIPELINE_URL]: BUILD_URL,
        [CI_PROVIDER_NAME]: 'jenkins',
        [GIT_COMMIT_SHA]: JENKINS_GIT_COMMIT,
        [DEPRECATED_GIT_COMMIT_SHA]: JENKINS_GIT_COMMIT,
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(JENKINS_GIT_REPOSITORY_URL),
        [finalRefKey]: ref
      }
      if (WORKSPACE) {
        tags[CI_WORKSPACE_PATH] = resolveTilde(WORKSPACE)
      }
      if (finalPipelineName) {
        tags[CI_PIPELINE_NAME] = finalPipelineName
      }

      return tags
    }

    if (env.GITLAB_CI) {
      const {
        CI_PIPELINE_ID: GITLAB_PIPELINE_ID,
        CI_PROJECT_PATH,
        CI_PIPELINE_IID,
        CI_PIPELINE_URL: GITLAB_PIPELINE_URL,
        CI_PROJECT_DIR,
        CI_COMMIT_BRANCH,
        CI_COMMIT_TAG,
        CI_COMMIT_SHA,
        CI_REPOSITORY_URL,
        CI_JOB_URL: GITLAB_CI_JOB_URL
      } = env

      const tags = {
        [CI_PIPELINE_ID]: GITLAB_PIPELINE_ID,
        [CI_PIPELINE_NAME]: CI_PROJECT_PATH,
        [CI_PIPELINE_NUMBER]: CI_PIPELINE_IID,
        [CI_PROVIDER_NAME]: 'gitlab',
        [GIT_COMMIT_SHA]: CI_COMMIT_SHA,
        [DEPRECATED_GIT_COMMIT_SHA]: CI_COMMIT_SHA,
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(CI_REPOSITORY_URL),
        [CI_JOB_URL]: GITLAB_CI_JOB_URL
      }

      if (CI_COMMIT_TAG) {
        tags[GIT_TAG] = normalizeRef(CI_COMMIT_TAG)
      }
      if (CI_COMMIT_BRANCH) {
        tags[GIT_BRANCH] = normalizeRef(CI_COMMIT_BRANCH)
      }
      if (CI_PROJECT_DIR) {
        tags[CI_WORKSPACE_PATH] = resolveTilde(CI_PROJECT_DIR)
      }
      if (GITLAB_PIPELINE_URL) {
        tags[CI_PIPELINE_URL] = `${(GITLAB_PIPELINE_URL).replace('/-/pipelines/', '/pipelines/')}`
      }

      return tags
    }

    if (env.CIRCLECI) {
      const {
        CIRCLE_WORKFLOW_ID,
        CIRCLE_PROJECT_REPONAME,
        CIRCLE_BUILD_NUM,
        CIRCLE_BUILD_URL,
        CIRCLE_WORKING_DIRECTORY,
        CIRCLE_BRANCH,
        CIRCLE_TAG,
        CIRCLE_SHA1,
        CIRCLE_REPOSITORY_URL
      } = env

      const tags = {
        [CI_PIPELINE_ID]: CIRCLE_WORKFLOW_ID,
        [CI_PIPELINE_NAME]: CIRCLE_PROJECT_REPONAME,
        [CI_PIPELINE_NUMBER]: CIRCLE_BUILD_NUM,
        [CI_PIPELINE_URL]: CIRCLE_BUILD_URL,
        [CI_PROVIDER_NAME]: 'circleci',
        [GIT_COMMIT_SHA]: CIRCLE_SHA1,
        [DEPRECATED_GIT_COMMIT_SHA]: CIRCLE_SHA1,
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(CIRCLE_REPOSITORY_URL)
      }

      if (CIRCLE_TAG) {
        tags[GIT_TAG] = normalizeRef(CIRCLE_TAG)
      } else if (CIRCLE_BRANCH) {
        tags[GIT_BRANCH] = normalizeRef(CIRCLE_BRANCH)
      }
      if (CIRCLE_WORKING_DIRECTORY) {
        tags[CI_WORKSPACE_PATH] = resolveTilde(CIRCLE_WORKING_DIRECTORY)
      }
      if (CIRCLE_BUILD_URL) {
        tags[CI_JOB_URL] = CIRCLE_BUILD_URL
      }

      return tags
    }

    if (env.GITHUB_ACTIONS || env.GITHUB_ACTION) {
      const {
        GITHUB_RUN_ID,
        GITHUB_WORKFLOW,
        GITHUB_RUN_NUMBER,
        GITHUB_WORKSPACE,
        GITHUB_HEAD_REF,
        GITHUB_REF,
        GITHUB_SHA,
        GITHUB_REPOSITORY
      } = env

      const repositoryURL = `https://github.com/${GITHUB_REPOSITORY}.git`
      const pipelineURL = `https://github.com/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}/checks`

      const tags = {
        [CI_PIPELINE_ID]: GITHUB_RUN_ID,
        [CI_PIPELINE_NAME]: GITHUB_WORKFLOW,
        [CI_PIPELINE_NUMBER]: GITHUB_RUN_NUMBER,
        [CI_PIPELINE_URL]: pipelineURL,
        [CI_PROVIDER_NAME]: 'github',
        [GIT_COMMIT_SHA]: GITHUB_SHA,
        [DEPRECATED_GIT_COMMIT_SHA]: GITHUB_SHA,
        [GIT_REPOSITORY_URL]: repositoryURL,
        [CI_JOB_URL]: pipelineURL
      }

      const finalRef = GITHUB_HEAD_REF || GITHUB_REF || ''
      const finalRefKey = finalRef.includes('tags') ? GIT_TAG : GIT_BRANCH

      tags[finalRefKey] = normalizeRef(finalRef)

      if (GITHUB_WORKSPACE) {
        tags[CI_WORKSPACE_PATH] = resolveTilde(GITHUB_WORKSPACE)
      }

      return tags
    }
    return {}
  }
}
