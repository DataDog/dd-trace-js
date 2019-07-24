'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const path = require('path')
const basename = require('path').basename

function cloneWithBranch (repo, branch, options) {
  const repoName = getRepoName(repo)
  const dir = branch ? `${repoName}@${branch}` : repoName
  const cwd = options.cwd || process.cwd()

  if (fs.existsSync(path.join(cwd, dir))) {
    return execSync(`git -C ${dir} pull`, options)
  }
  return execSync(`git clone -b ${branch} ${repo} '${repoName}@${branch}'`, options)
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
