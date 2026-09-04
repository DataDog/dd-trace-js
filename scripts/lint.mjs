import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ESLint } from 'eslint'
import { glob } from 'glob'
import { minimatch } from 'minimatch'

import { carrierFieldsFilePatterns } from '../eslint-rules/carrier-fields-policy.mjs'
import { createCarrierFieldsEslint } from './verify-carrier-fields.mjs'

const carrierFieldsRuleId = 'eslint-rules/eslint-carrier-fields'
const inlineConfigPattern = /\/\*\s*eslint(?:\s|$)/

/**
 * @param {ESLint.LintResult} result
 * @param {ESLint.LintMessage[]} messages
 * @returns {void}
 */
function replaceCarrierFieldsMessages (result, messages) {
  let errorCount = 0
  let warningCount = 0

  result.messages = result.messages.filter(message => {
    if (message.ruleId !== carrierFieldsRuleId) return true

    if (message.severity === 2) {
      errorCount++
    } else if (message.severity === 1) {
      warningCount++
    }
    return false
  })
  result.suppressedMessages = result.suppressedMessages.filter(message => message.ruleId !== carrierFieldsRuleId)
  result.messages.push(...messages)
  result.messages.sort((first, second) => first.line - second.line || first.column - second.column)
  result.errorCount += messages.length - errorCount
  result.warningCount -= warningCount
}

/**
 * @param {ESLint.LintResult[]} results
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function enforceCarrierFields (results, cwd) {
  const resultsByFilePath = new Map()
  const authoritativeFilePaths = new Set()

  for (const result of results) {
    resultsByFilePath.set(result.filePath, result)
    const relativePath = path.relative(cwd, result.filePath).split(path.sep).join('/')

    if (!carrierFieldsFilePatterns.some(pattern => minimatch(relativePath, pattern))) continue

    const source = result.source ?? readFileSync(result.filePath, 'utf8')
    // Inline configuration accepts escaped rule names, so a literal rule-name search is not authoritative.
    if (source.includes(carrierFieldsRuleId) || inlineConfigPattern.test(source)) {
      authoritativeFilePaths.add(result.filePath)
    }
  }

  for (const relativePath of await glob(carrierFieldsFilePatterns, { cwd })) {
    const filePath = path.resolve(cwd, relativePath)
    if (!resultsByFilePath.has(filePath)) authoritativeFilePaths.add(filePath)
  }

  if (authoritativeFilePaths.size > 0) {
    const eslint = await createCarrierFieldsEslint(cwd)
    const authoritativeResults = await eslint.lintFiles([...authoritativeFilePaths])

    for (const authoritativeResult of authoritativeResults) {
      const result = resultsByFilePath.get(authoritativeResult.filePath)
      if (!result) {
        results.push(authoritativeResult)
        continue
      }

      const messages = authoritativeResult.messages.filter(message => message.ruleId === carrierFieldsRuleId)
      replaceCarrierFieldsMessages(result, messages)
    }
  }

  for (const result of results) {
    const messages = result.suppressedMessages.filter(message => message.ruleId === carrierFieldsRuleId)
    if (messages.length === 0) continue

    replaceCarrierFieldsMessages(result, messages)
  }
}

/**
 * @param {ESLint.LintResult[]} results
 * @returns {{ errorCount: number, warningCount: number }}
 */
function countMessages (results) {
  let errorCount = 0
  let warningCount = 0

  for (const result of results) {
    errorCount += result.errorCount
    warningCount += result.warningCount
  }

  return { errorCount, warningCount }
}

/**
 * @returns {Promise<number>}
 */
async function lint () {
  const cwd = process.cwd()
  const eslint = new ESLint({ concurrency: 'auto', cwd })
  const results = await eslint.lintFiles(['.'])
  await enforceCarrierFields(results, cwd)

  const { errorCount, warningCount } = countMessages(results)
  const formatter = await eslint.loadFormatter('stylish')
  const resultsMeta = warningCount === 0
    ? {}
    : { maxWarningsExceeded: { maxWarnings: 0, foundWarnings: warningCount } }
  const output = await formatter.format(results, resultsMeta)

  if (output) {
    // eslint-disable-next-line no-console
    console.log(output)
  }

  if (errorCount === 0 && warningCount > 0) {
    // eslint-disable-next-line no-console
    console.error('ESLint found too many warnings (maximum: 0).')
  }

  return errorCount > 0 || warningCount > 0 ? 1 : 0
}

process.exitCode = await lint()
