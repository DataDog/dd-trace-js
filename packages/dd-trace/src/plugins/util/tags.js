'use strict'

const GIT_COMMIT_SHA = 'git.commit.sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'
const GIT_TAG = 'git.tag'
const GIT_COMMIT_MESSAGE = 'git.commit.message'
const GIT_COMMIT_COMMITTER_DATE = 'git.commit.committer.date'
const GIT_COMMIT_COMMITTER_EMAIL = 'git.commit.committer.email'
const GIT_COMMIT_COMMITTER_NAME = 'git.commit.committer.name'
const GIT_COMMIT_AUTHOR_DATE = 'git.commit.author.date'
const GIT_COMMIT_AUTHOR_EMAIL = 'git.commit.author.email'
const GIT_COMMIT_AUTHOR_NAME = 'git.commit.author.name'
const GIT_COMMIT_HEAD_SHA = 'git.commit.head.sha'
const GIT_COMMIT_HEAD_MESSAGE = 'git.commit.head.message'
const GIT_COMMIT_HEAD_AUTHOR_DATE = 'git.commit.head.author.date'
const GIT_COMMIT_HEAD_AUTHOR_EMAIL = 'git.commit.head.author.email'
const GIT_COMMIT_HEAD_AUTHOR_NAME = 'git.commit.head.author.name'
const GIT_COMMIT_HEAD_COMMITTER_DATE = 'git.commit.head.committer.date'
const GIT_COMMIT_HEAD_COMMITTER_EMAIL = 'git.commit.head.committer.email'
const GIT_COMMIT_HEAD_COMMITTER_NAME = 'git.commit.head.committer.name'

const GIT_PULL_REQUEST_BASE_BRANCH_SHA = 'git.pull_request.base_branch_sha'
const GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA = 'git.pull_request.base_branch_head_sha'
const GIT_PULL_REQUEST_BASE_BRANCH = 'git.pull_request.base_branch'

const CI_PIPELINE_ID = 'ci.pipeline.id'
const CI_PIPELINE_NAME = 'ci.pipeline.name'
const CI_PIPELINE_NUMBER = 'ci.pipeline.number'
const CI_PIPELINE_URL = 'ci.pipeline.url'
const CI_PROVIDER_NAME = 'ci.provider.name'
const CI_WORKSPACE_PATH = 'ci.workspace_path'
const CI_JOB_URL = 'ci.job.url'
const CI_JOB_NAME = 'ci.job.name'
const CI_JOB_ID = 'ci.job.id'
const CI_STAGE_NAME = 'ci.stage.name'
const CI_NODE_NAME = 'ci.node.name'
const CI_NODE_LABELS = 'ci.node.labels'

const CI_ENV_VARS = '_dd.ci.env_vars'

const PR_NUMBER = 'pr.number'

module.exports = {
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_REPOSITORY_URL,
  GIT_TAG,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_HEAD_SHA,
  GIT_COMMIT_HEAD_MESSAGE,
  GIT_COMMIT_HEAD_AUTHOR_DATE,
  GIT_COMMIT_HEAD_AUTHOR_EMAIL,
  GIT_COMMIT_HEAD_AUTHOR_NAME,
  GIT_COMMIT_HEAD_COMMITTER_DATE,
  GIT_COMMIT_HEAD_COMMITTER_EMAIL,
  GIT_COMMIT_HEAD_COMMITTER_NAME,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  CI_JOB_URL,
  CI_JOB_NAME,
  CI_JOB_ID,
  CI_STAGE_NAME,
  CI_ENV_VARS,
  CI_NODE_NAME,
  CI_NODE_LABELS,
  PR_NUMBER
}
