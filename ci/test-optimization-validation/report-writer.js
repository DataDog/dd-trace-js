'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const { normalizeRequests } = require('./payload-normalizer')
const { buildValidationPayloads } = require('./validation-payload')

function writeReport ({ manifest, results, out, intake, staticDiagnosis }) {
  const intakeArtifacts = intake.writeArtifacts()
  const normalizedEvents = normalizeRequests(intake.requests)
  const normalizedPath = path.join(out, 'intake', 'payloads.normalized.ndjson')
  fs.writeFileSync(
    normalizedPath,
    normalizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n'
  )

  const reportPath = path.join(out, 'report.md')
  const reportJsonPath = path.join(out, 'report.json')
  const reportHtmlPath = path.join(out, 'report.html')
  const validationPayloadsPath = path.join(out, 'validation-payloads.json')
  const validationUrlsPath = path.join(out, 'validation-urls.txt')
  const validationUrlPath = path.join(out, 'validation-url.txt')
  const baseArtifacts = {
    htmlFileUrl: pathToFileURL(reportHtmlPath).href,
    htmlPath: reportHtmlPath,
    manifest: manifest.__path,
    normalizedPayloads: normalizedPath,
    report: reportPath,
    reportJson: reportJsonPath,
    requests: intakeArtifacts.requestsPath,
    staticDiagnosis: staticDiagnosis && staticDiagnosis.reportPath,
  }
  const validationPayloads = buildValidationPayloads({
    manifest,
    results,
    artifacts: baseArtifacts,
  })

  fs.writeFileSync(validationPayloadsPath, `${JSON.stringify(validationPayloads, null, 2)}\n`)
  fs.writeFileSync(validationUrlsPath, validationPayloads.map(payload => {
    return `${payload.frameworkId}: ${payload.url}`
  }).join('\n') + '\n')
  fs.writeFileSync(validationUrlPath, validationPayloads[0] ? `${validationPayloads[0].url}\n` : '')

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    manifestPath: manifest.__path,
    results,
    artifacts: {
      ...baseArtifacts,
      validationPayloads: validationPayloadsPath,
      validationUrl: validationUrlPath,
      validationUrls: validationUrlsPath,
    },
    validation: validationPayloads.map(payload => ({
      frameworkId: payload.frameworkId,
      framework: payload.payload.framework,
      url: payload.url,
    })),
  }

  fs.writeFileSync(reportJsonPath, `${JSON.stringify(jsonReport, null, 2)}\n`)
  fs.writeFileSync(
    path.join(out, 'manifest.normalized.json'),
    `${JSON.stringify(stripPrivateFields(manifest), null, 2)}\n`
  )
  fs.writeFileSync(reportPath, renderMarkdown(jsonReport))
  fs.writeFileSync(reportHtmlPath, renderHtml(jsonReport))

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

  lines.push('', '## Framework Context', '')
  for (const validation of report.validation) {
    const context = formatFrameworkContext(validation.framework, { markdown: true })
    lines.push(`- ${validation.frameworkId}: ${context}`)
  }

  lines.push('', '## Key Artifacts', '')
  for (const [name, artifactPath] of getKeyArtifacts(report.artifacts)) {
    if (!artifactPath) continue
    lines.push(`- ${name}: \`${artifactPath}\``)
  }

  lines.push('', '## Validation UI', '')
  for (const validation of report.validation) {
    lines.push(`- ${validation.frameworkId}: ${validation.url}`)
  }
  lines.push('')

  return lines.join('\n')
}

function renderHtml (report) {
  const summaryItems = report.results.map(result => {
    return `<li><strong>${escapeHtml(result.status.toUpperCase())}</strong> ${escapeHtml(result.frameworkId)} ` +
      `${escapeHtml(result.scenario)} - ${escapeHtml(result.diagnosis)}</li>`
  }).join('\n')
  const contextItems = report.validation.map(validation => {
    return `<li><code>${escapeHtml(validation.frameworkId)}</code>: ` +
      `${escapeHtml(formatFrameworkContext(validation.framework))}</li>`
  }).join('\n')
  const validationItems = report.validation.map(validation => {
    return `<li><code>${escapeHtml(validation.frameworkId)}</code>: <code>${escapeHtml(validation.url)}</code></li>`
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Datadog Test Optimization Validation Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2933; }
    main { max-width: 960px; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h2 { font-size: 20px; margin-top: 32px; }
    li { margin: 8px 0; }
    code { background: #f4f6f8; border-radius: 4px; padding: 2px 4px; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Datadog Test Optimization Validation Report</h1>
    <p>Generated at: ${escapeHtml(report.generatedAt)}</p>
    <h2>Summary</h2>
    <ul>
      ${summaryItems}
    </ul>
    <h2>Framework Context</h2>
    <ul>
      ${contextItems}
    </ul>
    <h2>Validation UI</h2>
    <ul>
      ${validationItems}
    </ul>
  </main>
</body>
</html>
`
}

function getKeyArtifacts (artifacts) {
  return [
    ['HTML report', artifacts.htmlFileUrl],
    ['Validation URLs', artifacts.validationUrls],
    ['JSON report', artifacts.reportJson],
    ['Manifest', artifacts.manifest],
    ['Static diagnosis', artifacts.staticDiagnosis],
  ]
}

function formatFrameworkContext (framework, options = {}) {
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value

  if (!framework) return `language ${format('javascript')}`

  return [
    `language ${format(framework.language || 'javascript')}`,
    `package ${format(framework.packageName || 'unknown')}`,
    `working directory ${format(framework.workingDirectory || 'unknown')}`,
    `command cwd ${format(framework.commandWorkingDirectory || 'unknown')}`,
  ].join('; ')
}

function renderConsoleSummary (results, out) {
  const lines = ['', 'Datadog Test Optimization validation summary:']
  for (const result of results) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }
  lines.push(
    `Artifacts: ${out}`,
    `Validation URLs: ${path.join(out, 'validation-urls.txt')}`
  )
  return lines.join('\n')
}

function stripPrivateFields (manifest) {
  const copy = { ...manifest }
  delete copy.__path
  return copy
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

module.exports = { writeReport }
