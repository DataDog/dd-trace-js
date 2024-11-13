'use strict'

/* eslint-disable max-len */

const { capture, fatal } = require('./terminal')

// Check that the `git` CLI is installed.
function checkGit () {
  try {
    capture('git --version')
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
    capture('branch-diff --version')
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
}

// Check that the `gh` CLI is installed and authenticated.
function checkGitHub () {
  if (!process.env.GITHUB_TOKEN) {
    const link = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic'

    fatal(
      'The GITHUB_TOKEN environment variable is missing.',
      `Please visit ${link} for instructions to generate a personal access token.`,
      'The following scopes are required when generating the token: '
    )
  }

  try {
    capture('gh --version')
  } catch (e) {
    fatal(
      'The "gh" CLI could not be found.',
      'Please visit https://github.com/cli/cli#installation for instructions to install.'
    )
  }

  checkGitHubScopes()
}

// Check that the active GITHUB_TOKEN has the required scopes.
function checkGitHubScopes () {
  const url = 'https://api.github.com'
  const headers = [
    'Accept: application/vnd.github.v3+json',
    `Authorization: Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`,
    'X-GitHub-Api-Version: 2022-11-28'
  ].map(h => `-H "${h}"`).join(' ')

  const lines = capture(`curl -sS -I ${headers} ${url}`).trim().split(/\r?\n/g)
  const scopeLine = lines.find(line => line.startsWith('x-oauth-scopes:')) || ''
  const scopes = scopeLine.replace('x-oauth-scopes:', '').trim().split(', ')
  const required = ['public_repo', 'read:org']
  const link = 'https://github.com/settings/tokens'

  for (const req of required) {
    if (!scopes.includes(req)) {
      fatal(
        `Missing "${req}" scope for GITHUB_TOKEN.`,
        `Please visit ${link} and make sure the following scopes are enabled: ${required.join(' ,')}.`
      )
    }
  }
}

module.exports = { checkBranchDiff, checkGitHub, checkGit }
