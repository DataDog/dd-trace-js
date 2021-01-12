const Url = require('url-parse')

const { GIT_BRANCH, GIT_COMMIT_SHA, GIT_TAG } = require('./git')

const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NAME = 'ci.pipeline.name'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PROVIDER_NAME = 'ci.provider.name'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const GIT_REPOSITORY_URL = 'git.repository_url'
const CI_JOB_URL = 'ci.job.url'

function addTag (value, tagKey, normalize, targetTags) {
  if (value) {
    targetTags[tagKey] = normalize(value)
  }
}

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
  const { protocol, hostname, pathname } = new Url(repositoryUrl)
  if (!protocol || !hostname) {
    return repositoryUrl
  }
  return `${protocol}//${hostname}${pathname}`
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

      const tags = {
        [CI_PIPELINE_ID]: BUILD_TAG,
        [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
        [CI_PIPELINE_URL]: BUILD_URL,
        [CI_PROVIDER_NAME]: 'jenkins',
        [GIT_COMMIT_SHA]: JENKINS_GIT_COMMIT,
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(JENKINS_GIT_REPOSITORY_URL)
      }

      const isTag = JENKINS_GIT_BRANCH && JENKINS_GIT_BRANCH.includes('tags')
      const finalRefKey = isTag ? GIT_TAG : GIT_BRANCH
      const ref = normalizeRef(JENKINS_GIT_BRANCH)

      tags[finalRefKey] = ref

      addTag(WORKSPACE, CI_WORKSPACE_PATH, resolveTilde, tags)

      let finalPipelineName = ''
      if (JOB_NAME) {
        // Job names can contain parameters, e.g. jobName/KEY1=VALUE1,KEY2=VALUE2/branchName
        const jobNameAndParams = JOB_NAME.split('/')
        if (jobNameAndParams.length > 1 && jobNameAndParams[1].includes('=')) {
          finalPipelineName = jobNameAndParams[0]
        } else {
          finalPipelineName = JOB_NAME.replace(`/${ref}`, '')
        }
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
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(CI_REPOSITORY_URL),
        [CI_JOB_URL]: GITLAB_CI_JOB_URL
      }

      addTag(CI_COMMIT_TAG, GIT_TAG, normalizeRef, tags)
      addTag(CI_COMMIT_BRANCH, GIT_BRANCH, normalizeRef, tags)
      addTag(CI_PROJECT_DIR, CI_WORKSPACE_PATH, resolveTilde, tags)
      addTag(GITLAB_PIPELINE_URL, CI_PIPELINE_URL, (value) => value.replace('/-/pipelines/', '/pipelines/'), tags)

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
        [GIT_REPOSITORY_URL]: filterSensitiveInfoFromRepository(CIRCLE_REPOSITORY_URL)
      }

      addTag(CIRCLE_TAG || CIRCLE_BRANCH, CIRCLE_TAG ? GIT_TAG : GIT_BRANCH, normalizeRef, tags)
      addTag(CIRCLE_WORKING_DIRECTORY, CI_WORKSPACE_PATH, resolveTilde, tags)
      addTag(CIRCLE_BUILD_URL, CI_JOB_URL, value => value, tags)

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
        [GIT_REPOSITORY_URL]: repositoryURL,
        [CI_JOB_URL]: pipelineURL
      }

      const finalRef = GITHUB_HEAD_REF || GITHUB_REF || ''
      const finalRefKey = finalRef.includes('tags') ? GIT_TAG : GIT_BRANCH

      tags[finalRefKey] = normalizeRef(finalRef)

      addTag(GITHUB_WORKSPACE, CI_WORKSPACE_PATH, resolveTilde, tags)

      return tags
    }
    return {}
  }
}
