'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const YAML = require('yaml')

/** @typedef {{ workflowFileName: string, workflowName: string, jobId: string, checkName: string }} JobRecord */
/** @typedef {{ workflowFileName: string, workflowName: string, jobId: string, message: string }} ValidationError */

const workflowsDirectory = path.join(__dirname, '..', '.github', 'workflows')
const githubWorkflowExpressionPattern = /\$\{\{\s*github\.workflow\s*\}\}/g
const githubWorkflowExpressionText = '$' + '{{ github.workflow }}'

/**
 * @param {string} checkName
 * @param {string} workflowName
 * @returns {string}
 */
function resolveWorkflowNameExpression (checkName, workflowName) {
  return checkName.replaceAll(githubWorkflowExpressionPattern, workflowName)
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace (value) {
  return String(value).trim().replaceAll(/\s+/g, ' ')
}

/**
 * @param {string} workflowFileName
 * @param {string} workflowName
 * @param {Record<string, unknown>} jobsDefinition
 * @returns {{ jobRecords: JobRecord[], validationErrors: ValidationError[] }}
 */
function extractJobRecords (workflowFileName, workflowName, jobsDefinition) {
  /** @type {JobRecord[]} */
  const jobRecords = []
  /** @type {ValidationError[]} */
  const validationErrors = []

  for (const [jobId, jobDefinition] of Object.entries(jobsDefinition)) {
    if (!jobDefinition || typeof jobDefinition !== 'object') continue
    /** @type {{ name?: string }} */
    const jobObject = /** @type {{ name?: string }} */ (jobDefinition)

    const rawCheckName = normalizeWhitespace(jobObject.name || jobId)
    const resolvedCheckName = normalizeWhitespace(resolveWorkflowNameExpression(rawCheckName, workflowName))

    if (!resolvedCheckName) {
      validationErrors.push({
        workflowFileName,
        workflowName,
        jobId,
        message: 'Resolved check name is empty. Set `jobs.' + jobId + '.name` to a non-empty string.',
      })
      continue
    }

    jobRecords.push({
      workflowFileName,
      workflowName,
      jobId,
      checkName: resolvedCheckName,
    })
  }

  return { jobRecords, validationErrors }
}

const workflowFileNames = fs.readdirSync(workflowsDirectory).filter((fileName) => {
  return fileName.endsWith('.yml') || fileName.endsWith('.yaml')
})
workflowFileNames.sort((first, second) => first.localeCompare(second))

/** @type {JobRecord[]} */
const allJobRecords = []
/** @type {ValidationError[]} */
const allValidationErrors = []

for (const workflowFileName of workflowFileNames) {
  const workflowFilePath = path.join(workflowsDirectory, workflowFileName)
  const workflowYamlText = fs.readFileSync(workflowFilePath, 'utf8')

  /** @type {unknown} */
  let workflowDefinition
  try {
    workflowDefinition = YAML.parse(workflowYamlText)
  } catch (error) {
    console.error('Failed to parse workflow YAML: .github/workflows/%s', workflowFileName)
    console.error(error)
    process.exit(1)
  }

  if (!workflowDefinition || typeof workflowDefinition !== 'object') continue

  /** @type {{ name?: string, jobs?: Record<string, unknown> }} */
  const workflowObject = /** @type {{ name?: string, jobs?: Record<string, unknown> }} */ (workflowDefinition)

  const workflowName = normalizeWhitespace(workflowObject.name || workflowFileName)
  const jobsDefinition = workflowObject.jobs

  if (!jobsDefinition || typeof jobsDefinition !== 'object') continue

  const extracted = extractJobRecords(workflowFileName, workflowName, jobsDefinition)
  allJobRecords.push(...extracted.jobRecords)
  allValidationErrors.push(...extracted.validationErrors)
}

let hasAnyErrors = false

if (allValidationErrors.length) {
  hasAnyErrors = true
  allValidationErrors.sort((first, second) => {
    const fileComparison = first.workflowFileName.localeCompare(second.workflowFileName)
    if (fileComparison !== 0) return fileComparison
    return first.jobId.localeCompare(second.jobId)
  })

  console.error('\nInvalid workflow job names:')
  for (const validationError of allValidationErrors) {
    console.error(
      '  - %s :: %s (file: .github/workflows/%s) - %s',
      validationError.workflowName,
      validationError.jobId,
      validationError.workflowFileName,
      validationError.message
    )
  }
}

/** @type {Map<string, Set<string>>} */
const workflowNameToWorkflowFiles = new Map()
for (const jobRecord of allJobRecords) {
  const workflowFileSet = workflowNameToWorkflowFiles.get(jobRecord.workflowName) || new Set()
  workflowFileSet.add(jobRecord.workflowFileName)
  workflowNameToWorkflowFiles.set(jobRecord.workflowName, workflowFileSet)
}

const workflowNameEntries = [...workflowNameToWorkflowFiles.entries()]
workflowNameEntries.sort((first, second) => first[0].localeCompare(second[0]))

for (const [workflowName, workflowFileSet] of workflowNameEntries) {
  if (workflowFileSet.size <= 1) continue

  hasAnyErrors = true
  console.error('\nDuplicate workflow `name:` found: "%s"', workflowName)
  const sortedWorkflowFileNames = [...workflowFileSet].sort((first, second) => first.localeCompare(second))
  for (const workflowFileName of sortedWorkflowFileNames) {
    console.error('  - .github/workflows/%s', workflowFileName)
  }
  console.error(
    'Tip: Workflow names must be unique if job names depend on `' +
      githubWorkflowExpressionText +
      '`.'
  )
}

/** @type {Map<string, JobRecord[]>} */
const checkNameToJobRecords = new Map()
for (const jobRecord of allJobRecords) {
  const jobRecordList = checkNameToJobRecords.get(jobRecord.checkName) || []
  jobRecordList.push(jobRecord)
  checkNameToJobRecords.set(jobRecord.checkName, jobRecordList)
}

const duplicateCheckNameGroups = [...checkNameToJobRecords.entries()].filter(([, jobRecordList]) => {
  return jobRecordList.length > 1
})
duplicateCheckNameGroups.sort((first, second) => {
  const sizeDifference = second[1].length - first[1].length
  if (sizeDifference !== 0) return sizeDifference
  return first[0].localeCompare(second[0])
})

for (const [checkName, jobRecordList] of duplicateCheckNameGroups) {
  hasAnyErrors = true
  console.error('\nDuplicate check name: "%s" (%d)', checkName, jobRecordList.length)
  jobRecordList.sort((first, second) => {
    const workflowNameComparison = first.workflowName.localeCompare(second.workflowName)
    if (workflowNameComparison !== 0) return workflowNameComparison
    const jobIdComparison = first.jobId.localeCompare(second.jobId)
    if (jobIdComparison !== 0) return jobIdComparison
    return first.workflowFileName.localeCompare(second.workflowFileName)
  })
  for (const jobRecord of jobRecordList) {
    console.error(
      '  - %s :: %s (file: .github/workflows/%s)',
      jobRecord.workflowName,
      jobRecord.jobId,
      jobRecord.workflowFileName
    )
  }
}

if (duplicateCheckNameGroups.length) {
  console.error('\nFix: adjust `jobs.<id>.name` to include context (workflow, suite, os, node version, etc.).')
}

if (hasAnyErrors) process.exit(1)

console.log('Workflow job and check names are unique across all workflows.')
