'use strict'

const execSync = require('child_process').execSync
const basename = require('path').basename

function cloneOrPull (repo, options) {
  const repoName = getRepoName(repo)
  return execSync(`git -C ${repoName} pull || git clone ${repo}`, options)
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
  cloneOrPull,
  checkoutDefault,
  checkout,
  getRepoName
}
