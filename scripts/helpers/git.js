'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const path = require('path')
const basename = require('path').basename

function cloneWithBranch (repo, branch, options) {
  const cwd = options.cwd || process.cwd()

  const repoName = getRepoName(repo)
  let dir
  let branchArgs
  if (branch) {
    dir = `${repoName}@${branch}`
    branchArgs = `-b ${branch} '${repoName}@${branch}'`
  } else {
    dir = repoName
    branchArgs = ''
  }

  if (fs.existsSync(path.join(cwd, dir))) {
    return execSync(`git -C '${dir}' fetch --depth 1`, options)
  }
  return execSync(`git clone --depth 1 --single-branch ${repo} ${branchArgs}`, options)
}

function checkoutDefault (options) {
  const defaultBranch = execSync("git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'", options)
  return checkout(defaultBranch.toString().trim(), options)
}

function checkout (branch, options) {
  return execSync(`git checkout ${branch} --`, options)
}

function getRepoName (repo) {
  return basename(repo, '.git')
}

module.exports = {
  cloneWithBranch,
  checkoutDefault,
  checkout,
  getRepoName
}
