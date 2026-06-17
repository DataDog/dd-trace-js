'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const { normalizeRequests } = require('./payload-normalizer')

function writeReport ({ manifest, results, out, intake }) {
  const intakeArtifacts = intake.writeArtifacts()
  const normalizedEvents = normalizeRequests(intake.requests)
  const normalizedPath = path.join(out, 'intake', 'payloads.normalized.ndjson')
  fs.writeFileSync(
    normalizedPath,
    normalizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n'
  )

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    manifestPath: manifest.__path,
    results,
    artifacts: {
      requests: intakeArtifacts.requestsPath,
      normalizedPayloads: normalizedPath,
    },
  }

  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(jsonReport, null, 2)}\n`)
  fs.writeFileSync(
    path.join(out, 'manifest.normalized.json'),
    `${JSON.stringify(stripPrivateFields(manifest), null, 2)}\n`
  )
  fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(jsonReport))

  console.log(renderConsoleSummary(results, out))
}

function renderMarkdown (report) {
  const lines = [
    '# Datadog Test Optimization Validation Report',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
  ]

  for (const result of report.results) {
    lines.push(`- ${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario}: ${result.diagnosis}`)
  }

  lines.push('', '## Artifacts', '')
  for (const [name, artifactPath] of Object.entries(report.artifacts)) {
    lines.push(`- ${name}: \`${artifactPath}\``)
  }
  lines.push('')

  return lines.join('\n')
}

function renderConsoleSummary (results, out) {
  const lines = ['', 'Datadog Test Optimization validation summary:']
  for (const result of results) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }
  lines.push(`Artifacts: ${out}`)
  return lines.join('\n')
}

function stripPrivateFields (manifest) {
  const copy = { ...manifest }
  delete copy.__path
  return copy
}

module.exports = { writeReport }
