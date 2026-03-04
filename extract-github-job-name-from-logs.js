#!/usr/bin/env node

'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

const githubWellKnownDiagnosticDirs = [
  '/home/runner/actions-runner/cached/_diag', // for SaaS
  '/home/runner/actions-runner/_diag', // for self-hosted
]

const githubJobDisplayNameRegex = /"jobDisplayName":\s*"([^"]+)"/

const shouldGetGithubJobDisplayName = () => {
  const isGithubActions = process.env.GITHUB_ACTIONS || process.env.GITHUB_ACTION
  process.stdout.write(
    `[DEBUG] Guard check: GITHUB_ACTIONS=${String(process.env.GITHUB_ACTIONS)} ` +
    `GITHUB_ACTION=${String(process.env.GITHUB_ACTION)} ` +
    `DD_GITHUB_JOB_NAME=${String(process.env.DD_GITHUB_JOB_NAME)}\n`
  )
  process.stdout.write(`[DEBUG] isGithubActions=${String(Boolean(isGithubActions))}\n`)
  return Boolean(isGithubActions) && process.env.DD_GITHUB_JOB_NAME === undefined
}

/**
 * Extracts the job display name from the GitHub Actions diagnostic log files.
 *
 * @returns {string|undefined} The job display name, or undefined if not found.
 */
const getGithubJobNameFromLogs = () => {
  if (!shouldGetGithubJobDisplayName()) {
    process.stdout.write('[DEBUG] Skipping extraction because guard condition failed\n')
    return
  }
  process.stdout.write('Determining GitHub job name\n')
  process.stdout.write(
    `[DEBUG] Diagnostic dirs to inspect: ${githubWellKnownDiagnosticDirs.join(', ')}\n`
  )

  let foundDiagDir = ''
  let workerLogFiles = []

  // 1. Iterate through well known directories to check for worker logs.
  for (const currentDir of githubWellKnownDiagnosticDirs) {
    process.stdout.write(`[DEBUG] Checking directory: ${currentDir}\n`)
    try {
      const files = fs.readdirSync(currentDir, { withFileTypes: true })
      process.stdout.write(`[DEBUG] Directory exists. Entries: ${files.length}\n`)
      const potentialLogs = files
        .filter((file) => file.isFile() && file.name.startsWith('Worker_') && file.name.endsWith('.log'))
        .map((file) => file.name)
      process.stdout.write(`[DEBUG] Found Worker logs in directory: ${potentialLogs.length}\n`)

      if (potentialLogs.length > 0) {
        foundDiagDir = currentDir
        workerLogFiles = potentialLogs
        process.stdout.write(
          `[DEBUG] Using diagnostic directory "${foundDiagDir}" with files: ${workerLogFiles.join(', ')}\n`
        )
        break
      }
    } catch (error) {
      // If the directory does not exist, just try the next one.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        process.stdout.write(`[DEBUG] Directory not found (ENOENT): ${currentDir}\n`)
        continue
      }
      let errMessage = 'error reading GitHub diagnostic log files'
      errMessage += error instanceof Error ? `: ${error.message}` : `: ${String(error)}`
      process.stderr.write(`[WARNING] ${errMessage}\n`)
      return
    }
  }

  if (workerLogFiles.length === 0 || foundDiagDir === '') {
    process.stderr.write('[WARNING] could not find GitHub diagnostic log files\n')
    process.stdout.write('[DEBUG] No worker logs found in any well-known diagnostic directory\n')
    return
  }

  // 2. Get the job display name via regex.
  for (const logFile of workerLogFiles) {
    const filePath = path.join(foundDiagDir, logFile)
    process.stdout.write(`[DEBUG] Reading log file: ${filePath}\n`)
    const content = fs.readFileSync(filePath, 'utf8')
    process.stdout.write(`[DEBUG] Log file size (bytes): ${Buffer.byteLength(content, 'utf8')}\n`)
    const match = content.match(githubJobDisplayNameRegex)
    process.stdout.write(`[DEBUG] Regex matched in ${logFile}: ${String(Boolean(match && match[1]))}\n`)

    if (match && match[1]) {
      // match[1] is the captured group with the display name.
      process.stdout.write(`Successfully extracted job name: ${match[1]}\n`)
      return match[1]
    }
  }

  process.stderr.write('[WARNING] could not find "jobDisplayName" attribute in GitHub diagnostic logs\n')
}

const extractedName = getGithubJobNameFromLogs()
process.stdout.write(`[DEBUG] Final extractedName=${String(extractedName)}\n`)
if (extractedName && process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `job_name=${extractedName}\n`, 'utf8')
  process.stdout.write(`[DEBUG] Wrote job_name to GITHUB_OUTPUT: ${process.env.GITHUB_OUTPUT}\n`)
} else if (extractedName && !process.env.GITHUB_OUTPUT) {
  process.stdout.write('[DEBUG] extractedName exists but GITHUB_OUTPUT is not set\n')
} else {
  process.stdout.write('[DEBUG] No extractedName to export\n')
}
