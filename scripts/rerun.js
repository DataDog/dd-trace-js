'use strict'

// Example to rerun the Serverless workflow 30 times on the current branch:
// GITHUB_TOKEN=$(ddtool auth github token) WORKFLOW=Serverless node scripts/rerun

const { execSync } = require('child_process')

const {
  ATTEMPTS = 30,
  BRANCH,
  INTERVAL = 600,
  WORKFLOW
} = process.env

function rerun (current = 1) {
  const branch = BRANCH || execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
  const result = execSync(`gh run ls -b ${branch} -w ${WORKFLOW}`).toString()
  const id = result.match(/\d{11}/)[0]

  execSync(`gh run rerun ${id} --repo DataDog/dd-trace-js || exit 0`)

  if (current >= ATTEMPTS) return

  setTimeout(() => rerun(current + 1), INTERVAL * 1000)
}

rerun()
