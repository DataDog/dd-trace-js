'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const { normalizeRequests } = require('./payload-normalizer')
const { buildValidationPayloads } = require('./validation-payload')

const CI_WIRING_SCENARIO = 'ci-wiring'

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
    ciDiscovery: manifest.ciDiscovery,
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

  appendMarkdownResultSection(lines, 'Basic Reporting', getBasicReportingResults(report.results))
  appendMarkdownResultSection(lines, 'CI Wiring', getCiWiringResults(report.results))
  appendMarkdownResultSection(lines, 'Advanced Features', getAdvancedFeatureResults(report.results))
  appendMarkdownCiDiscovery(lines, report.ciDiscovery)

  const diagnosticResults = getDiagnosticOnlyResults(report.results)
  if (diagnosticResults.length > 0) {
    lines.push('', '## Diagnostic-only and Blocked Frameworks', '')
    for (const result of diagnosticResults) {
      lines.push(`- ${result.status.toUpperCase()} ${result.frameworkId}: ${result.diagnosis}`)
    }
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
  const basicReportingSection = renderHtmlResultSection('Basic Reporting', getBasicReportingResults(report.results))
  const ciWiringSection = renderHtmlResultSection('CI Wiring', getCiWiringResults(report.results))
  const advancedFeaturesSection = renderHtmlResultSection(
    'Advanced Features',
    getAdvancedFeatureResults(report.results)
  )
  const ciDiscoverySection = renderHtmlCiDiscovery(report.ciDiscovery)
  const diagnosticItems = getDiagnosticOnlyResults(report.results).map(result => {
    return `<li><strong>${escapeHtml(result.status.toUpperCase())}</strong> ${escapeHtml(result.frameworkId)} - ` +
      `${escapeHtml(result.diagnosis)}</li>`
  }).join('\n')
  const diagnosticSection = diagnosticItems
    ? `<h2>Diagnostic-only and Blocked Frameworks</h2>
    <ul>
      ${diagnosticItems}
    </ul>`
    : ''
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
    ${basicReportingSection}
    ${ciWiringSection}
    ${advancedFeaturesSection}
    ${ciDiscoverySection}
    ${diagnosticSection}
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

function appendMarkdownCiDiscovery (lines, ciDiscovery) {
  if (!ciDiscovery) return

  lines.push(
    '## CI Discovery',
    '',
    `- Method: \`${ciDiscovery.method || 'unknown'}\``
  )
  appendMarkdownList(lines, 'Searched', ciDiscovery.searched)
  appendMarkdownList(lines, 'Found', ciDiscovery.found)
  appendMarkdownList(lines, 'Static diagnosis found', ciDiscovery.staticFound)
  appendMarkdownList(lines, 'Warnings', ciDiscovery.warnings)
  appendMarkdownList(lines, 'Contradictions', ciDiscovery.contradictions)
  appendMarkdownList(lines, 'Notes', ciDiscovery.notes)
  lines.push('')
}

function appendMarkdownList (lines, label, values) {
  if (!Array.isArray(values) || values.length === 0) return
  lines.push(`- ${label}: ${values.map(value => `\`${value}\``).join(', ')}`)
}

function renderHtmlCiDiscovery (ciDiscovery) {
  if (!ciDiscovery) return ''

  return `<h2>CI Discovery</h2>
    <ul>
      <li><strong>Method</strong>: <code>${escapeHtml(ciDiscovery.method || 'unknown')}</code></li>
      ${renderHtmlListItem('Searched', ciDiscovery.searched)}
      ${renderHtmlListItem('Found', ciDiscovery.found)}
      ${renderHtmlListItem('Static diagnosis found', ciDiscovery.staticFound)}
      ${renderHtmlListItem('Warnings', ciDiscovery.warnings)}
      ${renderHtmlListItem('Contradictions', ciDiscovery.contradictions)}
      ${renderHtmlListItem('Notes', ciDiscovery.notes)}
    </ul>`
}

function renderHtmlListItem (label, values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  const formatted = values.map(value => `<code>${escapeHtml(value)}</code>`).join(', ')
  return `<li><strong>${escapeHtml(label)}</strong>: ${formatted}</li>`
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
  const basicReportingResults = getBasicReportingResults(results)
  const ciWiringResults = getCiWiringResults(results)
  const advancedFeatureResults = getAdvancedFeatureResults(results)
  const diagnosticResults = getDiagnosticOnlyResults(results)

  if (basicReportingResults.length > 0) {
    lines.push('Basic Reporting:')
  }
  for (const result of basicReportingResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (ciWiringResults.length > 0) {
    lines.push('CI wiring validation:')
  }
  for (const result of ciWiringResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (advancedFeatureResults.length > 0) {
    lines.push('Advanced feature validation:')
  }
  for (const result of advancedFeatureResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (diagnosticResults.length > 0) {
    lines.push('Diagnostic-only or blocked frameworks:')
  }
  for (const result of diagnosticResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} - ${result.diagnosis}`)
    appendExecutionEnvironmentRemediation(lines, result)
  }

  lines.push(
    `Artifacts: ${out}`,
    `Validation URLs: ${path.join(out, 'validation-urls.txt')}`
  )
  return lines.join('\n')
}

function appendExecutionEnvironmentRemediation (lines, result) {
  const evidence = result.evidence || {}
  if (evidence.blockedByExecutionEnvironment !== true) return

  lines.push(
    'No Test Optimization conclusion was reached for this framework.',
    'This is not evidence that Test Optimization is misconfigured.',
    'The manifest and generated artifacts may still be useful for rerunning live validation.',
    'Rerun the validator outside the restricted sandbox.'
  )

  if (Array.isArray(evidence.remediation) && evidence.remediation.length > 0) {
    lines.push('Rerun live validation from one of:')
    for (const remediation of evidence.remediation) {
      lines.push(`- ${remediation}`)
    }
  }

  if (evidence.rerunCommand) {
    lines.push(`Command: ${evidence.rerunCommand}`)
  }
}

function getLiveValidationResults (results) {
  return results.filter(result => !isDiagnosticOnlyResult(result))
}

function getCiWiringResults (results) {
  return getLiveValidationResults(results).filter(result => result.scenario === CI_WIRING_SCENARIO)
}

function getBasicReportingResults (results) {
  return getLiveValidationResults(results).filter(result => result.scenario === 'basic-reporting')
}

function getAdvancedFeatureResults (results) {
  return getLiveValidationResults(results).filter(result => {
    return result.scenario !== CI_WIRING_SCENARIO && result.scenario !== 'basic-reporting'
  })
}

function getDiagnosticOnlyResults (results) {
  return results.filter(isDiagnosticOnlyResult)
}

function appendMarkdownResultSection (lines, title, results) {
  if (results.length === 0) return

  lines.push(`### ${title}`, '')
  for (const result of results) {
    lines.push(`- ${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario}: ${result.diagnosis}`)
  }
  lines.push('')
}

function renderHtmlResultSection (title, results) {
  if (results.length === 0) return ''

  const items = results.map(result => {
    return `<li><strong>${escapeHtml(result.status.toUpperCase())}</strong> ${escapeHtml(result.frameworkId)} ` +
      `${escapeHtml(result.scenario)} - ${escapeHtml(result.diagnosis)}</li>`
  }).join('\n')

  return `<h3>${escapeHtml(title)}</h3>
    <ul>
      ${items}
    </ul>`
}

function isDiagnosticOnlyResult (result) {
  if (result.scenario !== 'all') return false
  return result.evidence?.frameworkStatus ||
    result.evidence?.staticDiagnosis ||
    result.evidence?.intakeStarted === false
}

function stripPrivateFields (manifest) {
  const copy = { ...manifest }
  delete copy.__path
  return copy
}

function escapeHtml (value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

module.exports = { writeReport }
