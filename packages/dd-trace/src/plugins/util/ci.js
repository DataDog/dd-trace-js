const {
  GIT_BRANCH,
  GIT_COMMIT_SHA,
  GIT_TAG,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_REPOSITORY_URL,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  CI_JOB_URL,
  CI_JOB_NAME,
  CI_STAGE_NAME,
  CI_ENV_VARS,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_COMMITTER_EMAIL,
  CI_NODE_LABELS,
  CI_NODE_NAME
} = require('./tags')
const { filterSensitiveInfoFromRepository } = require('./url')

// Receives a string with the form 'John Doe <john.doe@gmail.com>'
// and returns { name: 'John Doe', email: 'john.doe@gmail.com' }
function parseEmailAndName (emailAndName) {
  if (!emailAndName) {
    return { name: '', email: '' }
  }
  let name = ''
  let email = ''
  const matchNameAndEmail = emailAndName.match(/(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/)
  if (matchNameAndEmail) {
    name = matchNameAndEmail[1]
    email = matchNameAndEmail[2]
  }

  return { name, email }
}

function removeEmptyValues (tags) {
  return Object.keys(tags).reduce((filteredTags, tag) => {
    if (!tags[tag]) {
      return filteredTags
    }
    return {
      ...filteredTags,
      [tag]: tags[tag]
    }
  }, {})
}

function normalizeTag (targetTags, tagKey, normalize) {
  if (targetTags[tagKey]) {
    targetTags[tagKey] = normalize(targetTags[tagKey])
  }
}

function normalizeRef (ref) {
  if (!ref) {
    return ref
  }
  return ref.replace(/origin\/|refs\/heads\/|tags\//gm, '')
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
  normalizeRef,
  getCIMetadata () {
    const { env } = process

    let tags = {}

    if (env.JENKINS_URL) {
      const {
        WORKSPACE,
        BUILD_TAG,
        JOB_NAME,
        BUILD_NUMBER,
        BUILD_URL,
        GIT_BRANCH: JENKINS_GIT_BRANCH,
        GIT_COMMIT: JENKINS_GIT_COMMIT,
        GIT_URL: JENKINS_GIT_REPOSITORY_URL,
        GIT_URL_1: JENKINS_GIT_REPOSITORY_URL_1,
        DD_CUSTOM_TRACE_ID,
        NODE_NAME,
        NODE_LABELS
      } = env

      tags = {
        [CI_PIPELINE_ID]: BUILD_TAG,
        [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
        [CI_PIPELINE_URL]: BUILD_URL,
        [CI_PROVIDER_NAME]: 'jenkins',
        [GIT_COMMIT_SHA]: JENKINS_GIT_COMMIT,
        [GIT_REPOSITORY_URL]: JENKINS_GIT_REPOSITORY_URL || JENKINS_GIT_REPOSITORY_URL_1,
        [CI_WORKSPACE_PATH]: WORKSPACE,
        [CI_ENV_VARS]: JSON.stringify({ DD_CUSTOM_TRACE_ID }),
        [CI_NODE_NAME]: NODE_NAME
      }

      if (NODE_LABELS) {
        let nodeLabels
        try {
          nodeLabels = JSON.stringify(NODE_LABELS.split(' '))
          tags[CI_NODE_LABELS] = nodeLabels
        } catch (e) {
          // ignore errors
        }
      }

      const isTag = JENKINS_GIT_BRANCH && JENKINS_GIT_BRANCH.includes('tags/')
      const refKey = isTag ? GIT_TAG : GIT_BRANCH
      const ref = normalizeRef(JENKINS_GIT_BRANCH)

      tags[refKey] = ref

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
    }

    if (env.GITLAB_CI) {
      const {
        CI_PIPELINE_ID: GITLAB_PIPELINE_ID,
        CI_PROJECT_PATH,
        CI_PIPELINE_IID,
        CI_PIPELINE_URL: GITLAB_PIPELINE_URL,
        CI_PROJECT_DIR,
        CI_COMMIT_REF_NAME,
        CI_COMMIT_TAG,
        CI_COMMIT_SHA,
        CI_REPOSITORY_URL,
        CI_JOB_URL: GITLAB_CI_JOB_URL,
        CI_JOB_STAGE,
        CI_JOB_NAME: GITLAB_CI_JOB_NAME,
        CI_COMMIT_MESSAGE,
        CI_COMMIT_TIMESTAMP,
        CI_COMMIT_AUTHOR,
        CI_PROJECT_URL: GITLAB_PROJECT_URL,
        CI_JOB_ID: GITLAB_CI_JOB_ID,
        CI_RUNNER_ID,
        CI_RUNNER_TAGS
      } = env

      const { name, email } = parseEmailAndName(CI_COMMIT_AUTHOR)

      tags = {
        [CI_PIPELINE_ID]: GITLAB_PIPELINE_ID,
        [CI_PIPELINE_NAME]: CI_PROJECT_PATH,
        [CI_PIPELINE_NUMBER]: CI_PIPELINE_IID,
        [CI_PROVIDER_NAME]: 'gitlab',
        [GIT_COMMIT_SHA]: CI_COMMIT_SHA,
        [GIT_REPOSITORY_URL]: CI_REPOSITORY_URL,
        [CI_JOB_URL]: GITLAB_CI_JOB_URL,
        [GIT_TAG]: CI_COMMIT_TAG,
        [GIT_BRANCH]: CI_COMMIT_REF_NAME,
        [CI_WORKSPACE_PATH]: CI_PROJECT_DIR,
        [CI_PIPELINE_URL]: GITLAB_PIPELINE_URL,
        [CI_STAGE_NAME]: CI_JOB_STAGE,
        [CI_JOB_NAME]: GITLAB_CI_JOB_NAME,
        [GIT_COMMIT_MESSAGE]: CI_COMMIT_MESSAGE,
        [GIT_COMMIT_AUTHOR_NAME]: name,
        [GIT_COMMIT_AUTHOR_EMAIL]: email,
        [GIT_COMMIT_AUTHOR_DATE]: CI_COMMIT_TIMESTAMP,
        [CI_ENV_VARS]: JSON.stringify({
          CI_PROJECT_URL: GITLAB_PROJECT_URL,
          CI_PIPELINE_ID: GITLAB_PIPELINE_ID,
          CI_JOB_ID: GITLAB_CI_JOB_ID
        }),
        [CI_NODE_LABELS]: CI_RUNNER_TAGS,
        [CI_NODE_NAME]: CI_RUNNER_ID
      }
    }

    if (env.CIRCLECI) {
      const {
        CIRCLE_WORKFLOW_ID,
        CIRCLE_PROJECT_REPONAME,
        CIRCLE_BUILD_URL,
        CIRCLE_WORKING_DIRECTORY,
        CIRCLE_BRANCH,
        CIRCLE_TAG,
        CIRCLE_SHA1,
        CIRCLE_REPOSITORY_URL,
        CIRCLE_JOB,
        CIRCLE_BUILD_NUM
      } = env

      const pipelineUrl = `https://app.circleci.com/pipelines/workflows/${CIRCLE_WORKFLOW_ID}`

      tags = {
        [CI_PIPELINE_ID]: CIRCLE_WORKFLOW_ID,
        [CI_PIPELINE_NAME]: CIRCLE_PROJECT_REPONAME,
        [CI_PIPELINE_URL]: pipelineUrl,
        [CI_JOB_NAME]: CIRCLE_JOB,
        [CI_PROVIDER_NAME]: 'circleci',
        [GIT_COMMIT_SHA]: CIRCLE_SHA1,
        [GIT_REPOSITORY_URL]: CIRCLE_REPOSITORY_URL,
        [CI_JOB_URL]: CIRCLE_BUILD_URL,
        [CI_WORKSPACE_PATH]: CIRCLE_WORKING_DIRECTORY,
        [GIT_TAG]: CIRCLE_TAG,
        [GIT_BRANCH]: CIRCLE_BRANCH,
        [CI_ENV_VARS]: JSON.stringify({
          CIRCLE_WORKFLOW_ID,
          CIRCLE_BUILD_NUM
        })
      }
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
        GITHUB_REPOSITORY,
        GITHUB_SERVER_URL,
        GITHUB_RUN_ATTEMPT,
        GITHUB_JOB
      } = env

      const repositoryURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git`
      let pipelineURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

      if (GITHUB_RUN_ATTEMPT) {
        pipelineURL = `${pipelineURL}/attempts/${GITHUB_RUN_ATTEMPT}`
      }

      const jobUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}/checks`

      const ref = GITHUB_HEAD_REF || GITHUB_REF || ''
      const refKey = ref.includes('tags/') ? GIT_TAG : GIT_BRANCH

      // Both pipeline URL and job URL include GITHUB_SERVER_URL, which can include user credentials,
      // so we pass them through `filterSensitiveInfoFromRepository`.
      tags = {
        [CI_PIPELINE_ID]: GITHUB_RUN_ID,
        [CI_PIPELINE_NAME]: GITHUB_WORKFLOW,
        [CI_PIPELINE_NUMBER]: GITHUB_RUN_NUMBER,
        [CI_PIPELINE_URL]: filterSensitiveInfoFromRepository(pipelineURL),
        [CI_PROVIDER_NAME]: 'github',
        [GIT_COMMIT_SHA]: GITHUB_SHA,
        [GIT_REPOSITORY_URL]: repositoryURL,
        [CI_JOB_URL]: filterSensitiveInfoFromRepository(jobUrl),
        [CI_JOB_NAME]: GITHUB_JOB,
        [CI_WORKSPACE_PATH]: GITHUB_WORKSPACE,
        [refKey]: ref,
        [CI_ENV_VARS]: JSON.stringify({
          GITHUB_SERVER_URL: filterSensitiveInfoFromRepository(GITHUB_SERVER_URL),
          GITHUB_REPOSITORY,
          GITHUB_RUN_ID,
          GITHUB_RUN_ATTEMPT
        })
      }
    }

    if (env.APPVEYOR) {
      const {
        APPVEYOR_REPO_NAME,
        APPVEYOR_REPO_PROVIDER,
        APPVEYOR_BUILD_FOLDER,
        APPVEYOR_BUILD_ID,
        APPVEYOR_BUILD_NUMBER,
        APPVEYOR_REPO_COMMIT,
        APPVEYOR_PULL_REQUEST_HEAD_REPO_BRANCH,
        APPVEYOR_REPO_BRANCH,
        APPVEYOR_REPO_TAG_NAME,
        APPVEYOR_REPO_COMMIT_AUTHOR,
        APPVEYOR_REPO_COMMIT_AUTHOR_EMAIL,
        APPVEYOR_REPO_COMMIT_MESSAGE,
        APPVEYOR_REPO_COMMIT_MESSAGE_EXTENDED
      } = env

      const pipelineUrl = `https://ci.appveyor.com/project/${APPVEYOR_REPO_NAME}/builds/${APPVEYOR_BUILD_ID}`

      tags = {
        [CI_PROVIDER_NAME]: 'appveyor',
        [CI_PIPELINE_URL]: pipelineUrl,
        [CI_PIPELINE_ID]: APPVEYOR_BUILD_ID,
        [CI_PIPELINE_NAME]: APPVEYOR_REPO_NAME,
        [CI_PIPELINE_NUMBER]: APPVEYOR_BUILD_NUMBER,
        [CI_JOB_URL]: pipelineUrl,
        [CI_WORKSPACE_PATH]: APPVEYOR_BUILD_FOLDER,
        [GIT_COMMIT_AUTHOR_NAME]: APPVEYOR_REPO_COMMIT_AUTHOR,
        [GIT_COMMIT_AUTHOR_EMAIL]: APPVEYOR_REPO_COMMIT_AUTHOR_EMAIL,
        [GIT_COMMIT_MESSAGE]: APPVEYOR_REPO_COMMIT_MESSAGE + '\n' + APPVEYOR_REPO_COMMIT_MESSAGE_EXTENDED
      }

      if (APPVEYOR_REPO_PROVIDER === 'github') {
        tags = {
          ...tags,
          [GIT_REPOSITORY_URL]: `https://github.com/${APPVEYOR_REPO_NAME}.git`,
          [GIT_COMMIT_SHA]: APPVEYOR_REPO_COMMIT,
          [GIT_TAG]: APPVEYOR_REPO_TAG_NAME,
          [GIT_BRANCH]: APPVEYOR_PULL_REQUEST_HEAD_REPO_BRANCH || APPVEYOR_REPO_BRANCH
        }
      }
    }

    if (env.TF_BUILD) {
      const {
        BUILD_SOURCESDIRECTORY,
        BUILD_BUILDID,
        BUILD_DEFINITIONNAME,
        SYSTEM_TEAMFOUNDATIONSERVERURI,
        SYSTEM_TEAMPROJECTID,
        SYSTEM_JOBID,
        SYSTEM_TASKINSTANCEID,
        SYSTEM_PULLREQUEST_SOURCEBRANCH,
        BUILD_SOURCEBRANCH,
        BUILD_SOURCEBRANCHNAME,
        SYSTEM_PULLREQUEST_SOURCECOMMITID,
        SYSTEM_PULLREQUEST_SOURCEREPOSITORYURI,
        BUILD_REPOSITORY_URI,
        BUILD_SOURCEVERSION,
        BUILD_REQUESTEDFORID,
        BUILD_REQUESTEDFOREMAIL,
        BUILD_SOURCEVERSIONMESSAGE,
        SYSTEM_STAGEDISPLAYNAME,
        SYSTEM_JOBDISPLAYNAME
      } = env

      const ref = SYSTEM_PULLREQUEST_SOURCEBRANCH || BUILD_SOURCEBRANCH || BUILD_SOURCEBRANCHNAME
      const refKey = (ref || '').includes('tags/') ? GIT_TAG : GIT_BRANCH

      tags = {
        [CI_PROVIDER_NAME]: 'azurepipelines',
        [CI_PIPELINE_ID]: BUILD_BUILDID,
        [CI_PIPELINE_NAME]: BUILD_DEFINITIONNAME,
        [CI_PIPELINE_NUMBER]: BUILD_BUILDID,
        [GIT_COMMIT_SHA]: SYSTEM_PULLREQUEST_SOURCECOMMITID || BUILD_SOURCEVERSION,
        [CI_WORKSPACE_PATH]: BUILD_SOURCESDIRECTORY,
        [GIT_REPOSITORY_URL]: SYSTEM_PULLREQUEST_SOURCEREPOSITORYURI || BUILD_REPOSITORY_URI,
        [refKey]: ref,
        [GIT_COMMIT_AUTHOR_NAME]: BUILD_REQUESTEDFORID,
        [GIT_COMMIT_AUTHOR_EMAIL]: BUILD_REQUESTEDFOREMAIL,
        [GIT_COMMIT_MESSAGE]: BUILD_SOURCEVERSIONMESSAGE,
        [CI_STAGE_NAME]: SYSTEM_STAGEDISPLAYNAME,
        [CI_JOB_NAME]: SYSTEM_JOBDISPLAYNAME,
        [CI_ENV_VARS]: JSON.stringify({ SYSTEM_TEAMPROJECTID, BUILD_BUILDID, SYSTEM_JOBID })
      }

      if (SYSTEM_TEAMFOUNDATIONSERVERURI && SYSTEM_TEAMPROJECTID && BUILD_BUILDID) {
        const baseUrl =
          `${SYSTEM_TEAMFOUNDATIONSERVERURI}${SYSTEM_TEAMPROJECTID}/_build/results?buildId=${BUILD_BUILDID}`
        const pipelineUrl = baseUrl
        const jobUrl = `${baseUrl}&view=logs&j=${SYSTEM_JOBID}&t=${SYSTEM_TASKINSTANCEID}`

        tags = {
          ...tags,
          [CI_PIPELINE_URL]: pipelineUrl,
          [CI_JOB_URL]: jobUrl
        }
      }
    }

    if (env.BITBUCKET_COMMIT) {
      const {
        BITBUCKET_REPO_FULL_NAME,
        BITBUCKET_BUILD_NUMBER,
        BITBUCKET_BRANCH,
        BITBUCKET_COMMIT,
        BITBUCKET_GIT_SSH_ORIGIN,
        BITBUCKET_GIT_HTTP_ORIGIN,
        BITBUCKET_TAG,
        BITBUCKET_PIPELINE_UUID,
        BITBUCKET_CLONE_DIR
      } = env

      const url =
        `https://bitbucket.org/${BITBUCKET_REPO_FULL_NAME}/addon/pipelines/home#!/results/${BITBUCKET_BUILD_NUMBER}`

      tags = {
        [CI_PROVIDER_NAME]: 'bitbucket',
        [GIT_COMMIT_SHA]: BITBUCKET_COMMIT,
        [CI_PIPELINE_NUMBER]: BITBUCKET_BUILD_NUMBER,
        [CI_PIPELINE_NAME]: BITBUCKET_REPO_FULL_NAME,
        [CI_JOB_URL]: url,
        [CI_PIPELINE_URL]: url,
        [GIT_BRANCH]: BITBUCKET_BRANCH,
        [GIT_TAG]: BITBUCKET_TAG,
        [GIT_REPOSITORY_URL]: BITBUCKET_GIT_SSH_ORIGIN || BITBUCKET_GIT_HTTP_ORIGIN,
        [CI_WORKSPACE_PATH]: BITBUCKET_CLONE_DIR,
        [CI_PIPELINE_ID]: BITBUCKET_PIPELINE_UUID && BITBUCKET_PIPELINE_UUID.replace(/{|}/gm, '')
      }
    }

    if (env.BITRISE_BUILD_SLUG) {
      const {
        BITRISE_GIT_COMMIT,
        GIT_CLONE_COMMIT_HASH,
        BITRISEIO_GIT_BRANCH_DEST,
        BITRISE_GIT_BRANCH,
        BITRISE_BUILD_SLUG,
        BITRISE_TRIGGERED_WORKFLOW_ID,
        BITRISE_BUILD_NUMBER,
        BITRISE_BUILD_URL,
        BITRISE_SOURCE_DIR,
        GIT_REPOSITORY_URL: BITRISE_GIT_REPOSITORY_URL,
        BITRISE_GIT_TAG,
        BITRISE_GIT_MESSAGE
      } = env

      tags = {
        [CI_PROVIDER_NAME]: 'bitrise',
        [CI_PIPELINE_ID]: BITRISE_BUILD_SLUG,
        [CI_PIPELINE_NAME]: BITRISE_TRIGGERED_WORKFLOW_ID,
        [CI_PIPELINE_NUMBER]: BITRISE_BUILD_NUMBER,
        [CI_PIPELINE_URL]: BITRISE_BUILD_URL,
        [GIT_COMMIT_SHA]: BITRISE_GIT_COMMIT || GIT_CLONE_COMMIT_HASH,
        [GIT_REPOSITORY_URL]: BITRISE_GIT_REPOSITORY_URL,
        [CI_WORKSPACE_PATH]: BITRISE_SOURCE_DIR,
        [GIT_TAG]: BITRISE_GIT_TAG,
        [GIT_BRANCH]: BITRISEIO_GIT_BRANCH_DEST || BITRISE_GIT_BRANCH,
        [GIT_COMMIT_MESSAGE]: BITRISE_GIT_MESSAGE
      }
    }

    if (env.BUILDKITE) {
      const {
        BUILDKITE_BRANCH,
        BUILDKITE_COMMIT,
        BUILDKITE_REPO,
        BUILDKITE_TAG,
        BUILDKITE_BUILD_ID,
        BUILDKITE_PIPELINE_SLUG,
        BUILDKITE_BUILD_NUMBER,
        BUILDKITE_BUILD_URL,
        BUILDKITE_JOB_ID,
        BUILDKITE_BUILD_CHECKOUT_PATH,
        BUILDKITE_BUILD_AUTHOR,
        BUILDKITE_BUILD_AUTHOR_EMAIL,
        BUILDKITE_MESSAGE,
        BUILDKITE_AGENT_ID
      } = env

      const extraTags = Object.keys(env).filter(envVar =>
        envVar.startsWith('BUILDKITE_AGENT_META_DATA_')
      ).map((metadataKey) => {
        const key = metadataKey.replace('BUILDKITE_AGENT_META_DATA_', '').toLowerCase()
        return `${key}:${env[metadataKey]}`
      })

      tags = {
        [CI_PROVIDER_NAME]: 'buildkite',
        [CI_PIPELINE_ID]: BUILDKITE_BUILD_ID,
        [CI_PIPELINE_NAME]: BUILDKITE_PIPELINE_SLUG,
        [CI_PIPELINE_NUMBER]: BUILDKITE_BUILD_NUMBER,
        [CI_PIPELINE_URL]: BUILDKITE_BUILD_URL,
        [CI_JOB_URL]: `${BUILDKITE_BUILD_URL}#${BUILDKITE_JOB_ID}`,
        [GIT_COMMIT_SHA]: BUILDKITE_COMMIT,
        [CI_WORKSPACE_PATH]: BUILDKITE_BUILD_CHECKOUT_PATH,
        [GIT_REPOSITORY_URL]: BUILDKITE_REPO,
        [GIT_TAG]: BUILDKITE_TAG,
        [GIT_BRANCH]: BUILDKITE_BRANCH,
        [GIT_COMMIT_AUTHOR_NAME]: BUILDKITE_BUILD_AUTHOR,
        [GIT_COMMIT_AUTHOR_EMAIL]: BUILDKITE_BUILD_AUTHOR_EMAIL,
        [GIT_COMMIT_MESSAGE]: BUILDKITE_MESSAGE,
        [CI_ENV_VARS]: JSON.stringify({
          BUILDKITE_BUILD_ID,
          BUILDKITE_JOB_ID
        }),
        [CI_NODE_NAME]: BUILDKITE_AGENT_ID,
        [CI_NODE_LABELS]: JSON.stringify(extraTags)
      }
    }

    if (env.TRAVIS) {
      const {
        TRAVIS_PULL_REQUEST_BRANCH,
        TRAVIS_BRANCH,
        TRAVIS_COMMIT,
        TRAVIS_REPO_SLUG,
        TRAVIS_TAG,
        TRAVIS_JOB_WEB_URL,
        TRAVIS_BUILD_ID,
        TRAVIS_BUILD_NUMBER,
        TRAVIS_BUILD_WEB_URL,
        TRAVIS_BUILD_DIR,
        TRAVIS_COMMIT_MESSAGE
      } = env

      tags = {
        [CI_PROVIDER_NAME]: 'travisci',
        [CI_JOB_URL]: TRAVIS_JOB_WEB_URL,
        [CI_PIPELINE_ID]: TRAVIS_BUILD_ID,
        [CI_PIPELINE_NAME]: TRAVIS_REPO_SLUG,
        [CI_PIPELINE_NUMBER]: TRAVIS_BUILD_NUMBER,
        [CI_PIPELINE_URL]: TRAVIS_BUILD_WEB_URL,
        [GIT_COMMIT_SHA]: TRAVIS_COMMIT,
        [GIT_REPOSITORY_URL]: `https://github.com/${TRAVIS_REPO_SLUG}.git`,
        [CI_WORKSPACE_PATH]: TRAVIS_BUILD_DIR,
        [GIT_TAG]: TRAVIS_TAG,
        [GIT_BRANCH]: TRAVIS_PULL_REQUEST_BRANCH || TRAVIS_BRANCH,
        [GIT_COMMIT_MESSAGE]: TRAVIS_COMMIT_MESSAGE
      }
    }

    if (env.BUDDY) {
      const {
        BUDDY_EXECUTION_BRANCH,
        BUDDY_EXECUTION_ID,
        BUDDY_EXECUTION_REVISION,
        BUDDY_EXECUTION_REVISION_COMMITTER_EMAIL,
        BUDDY_EXECUTION_REVISION_COMMITTER_NAME,
        BUDDY_EXECUTION_REVISION_MESSAGE,
        BUDDY_EXECUTION_TAG,
        BUDDY_EXECUTION_URL,
        BUDDY_PIPELINE_ID,
        BUDDY_PIPELINE_NAME,
        BUDDY_SCM_URL
      } = env
      tags = {
        [CI_PROVIDER_NAME]: 'buddy',
        [CI_PIPELINE_ID]: `${BUDDY_PIPELINE_ID}/${BUDDY_EXECUTION_ID}`,
        [CI_PIPELINE_NAME]: BUDDY_PIPELINE_NAME,
        [CI_PIPELINE_NUMBER]: BUDDY_EXECUTION_ID,
        [CI_PIPELINE_URL]: BUDDY_EXECUTION_URL,
        [GIT_COMMIT_SHA]: BUDDY_EXECUTION_REVISION,
        [GIT_REPOSITORY_URL]: BUDDY_SCM_URL,
        [GIT_BRANCH]: BUDDY_EXECUTION_BRANCH,
        [GIT_TAG]: BUDDY_EXECUTION_TAG,
        [GIT_COMMIT_MESSAGE]: BUDDY_EXECUTION_REVISION_MESSAGE,
        [GIT_COMMIT_COMMITTER_NAME]: BUDDY_EXECUTION_REVISION_COMMITTER_NAME,
        [GIT_COMMIT_COMMITTER_EMAIL]: BUDDY_EXECUTION_REVISION_COMMITTER_EMAIL
      }
    }

    if (env.TEAMCITY_VERSION) {
      const { BUILD_URL, TEAMCITY_BUILDCONF_NAME, DATADOG_BUILD_ID } = env
      tags = {
        [CI_PROVIDER_NAME]: 'teamcity',
        [CI_JOB_URL]: BUILD_URL,
        [CI_JOB_NAME]: TEAMCITY_BUILDCONF_NAME,
        [CI_ENV_VARS]: JSON.stringify({
          DATADOG_BUILD_ID
        })
      }
    }

    if (env.CF_BUILD_ID) {
      const {
        CF_BUILD_ID,
        CF_PIPELINE_NAME,
        CF_BUILD_URL,
        CF_STEP_NAME,
        CF_BRANCH
      } = env
      tags = {
        [CI_PROVIDER_NAME]: 'codefresh',
        [CI_PIPELINE_ID]: CF_BUILD_ID,
        [CI_PIPELINE_NAME]: CF_PIPELINE_NAME,
        [CI_PIPELINE_URL]: CF_BUILD_URL,
        [CI_JOB_NAME]: CF_STEP_NAME,
        [CI_ENV_VARS]: JSON.stringify({
          CF_BUILD_ID
        })
      }

      const isTag = CF_BRANCH && CF_BRANCH.includes('tags/')
      const refKey = isTag ? GIT_TAG : GIT_BRANCH
      const ref = normalizeRef(CF_BRANCH)

      tags[refKey] = ref
    }

    if (env.CODEBUILD_INITIATOR?.startsWith('codepipeline/')) {
      const {
        CODEBUILD_BUILD_ARN,
        DD_ACTION_EXECUTION_ID,
        DD_PIPELINE_EXECUTION_ID
      } = env
      tags = {
        [CI_PROVIDER_NAME]: 'awscodepipeline',
        [CI_PIPELINE_ID]: DD_PIPELINE_EXECUTION_ID,
        [CI_ENV_VARS]: JSON.stringify({
          CODEBUILD_BUILD_ARN,
          DD_PIPELINE_EXECUTION_ID,
          DD_ACTION_EXECUTION_ID
        })
      }
    }

    normalizeTag(tags, CI_WORKSPACE_PATH, resolveTilde)
    normalizeTag(tags, GIT_REPOSITORY_URL, filterSensitiveInfoFromRepository)
    normalizeTag(tags, GIT_BRANCH, normalizeRef)
    normalizeTag(tags, GIT_TAG, normalizeRef)

    return removeEmptyValues(tags)
  }
}
