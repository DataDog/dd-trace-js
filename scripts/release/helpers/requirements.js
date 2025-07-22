'use strict'

const { join } = require('path')
const { existsSync } = require('fs')
const os = require('os')
const path = require('path')
const { fatal, run } = require('./terminal')

const { CI, HOME, LOCALAPPDATA, XDG_CONFIG_HOME, USERPROFILE } = process.env

function checkAll () {
  checkGit()
  checkBranchDiff()
  checkGitHub()
}

// Check that the `git` CLI is installed.
function checkGit () {
  try {
    run('git --version', false)
  } catch (e) {
    fatal(
      'The "git" CLI could not be found.',
      'Please visit https://git-scm.com/downloads for instructions to install.'
    )
  }
}

// Check that the `branch-diff` CLI is installed.
function checkBranchDiff () {
  try {
    run('branch-diff --version', false)
  } catch (e) {
    const link = [
      'https://datadoghq.atlassian.net/wiki/spaces/DL/pages/3125511269/Node.js+Tracer+Release+Process',
      '#Install-and-Configure-branch-diff-to-automate-some-operations'
    ].join('')
    fatal(
      'The "branch-diff" CLI could not be found.',
      `Please visit ${link} for instructions to install.`
    )
  }

  const branchDiffConfigPath = join(getApplicationConfigPath('changelog-maker'), 'config.json')

  if (!existsSync(branchDiffConfigPath)) {
    const link = 'https://github.com/nodejs/changelog-maker?tab=readme-ov-file#development'
    fatal(
      'The "branch-diff" configuration file is missing.',
      `Please visit ${link} for instructions to configure.`
    )
  }
}

// Check that the `gh` CLI is installed and authenticated.
function checkGitHub () {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

  if (!token) {
    const link = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic'

    fatal(
      'The GITHUB_TOKEN | GH_TOKEN environment variable is missing.',
      `Please visit ${link} for instructions to generate a personal access token.`,
    )
  }

  try {
    run('gh --version', false)
  } catch (e) {
    fatal(
      'The "gh" CLI could not be found.',
      'Please visit https://github.com/cli/cli#installation for instructions to install.'
    )
  }
}

function getApplicationConfigPath (name) {
  switch (os.platform()) {
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support', name)
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return path.join(XDG_CONFIG_HOME || path.join(HOME, '.config'), name)
    case 'win32':
      return path.join(LOCALAPPDATA || path.join(USERPROFILE, 'Local Settings', 'Application Data'), name)
    default:
      throw new Error('Platform not supported')
  }
}

module.exports = { checkAll, checkBranchDiff, checkGitHub, checkGit }
