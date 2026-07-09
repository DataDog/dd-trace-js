'use strict'

const DEFAULT_CI_SEARCHES = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  '.circleci/config.yml',
  '.circleci/config.yaml',
  '.buildkite/pipeline.yml',
  '.buildkite/pipeline.yaml',
  'bitbucket-pipelines.yml',
  'bitbucket-pipelines.yaml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.azure-pipelines/*.yml',
  '.azure-pipelines/*.yaml',
  'Jenkinsfile',
]

function annotateCiDiscovery ({ manifest, diagnosis }) {
  manifest.ciDiscovery = buildCiDiscovery({ manifest, diagnosis })

  if (manifest.ciDiscovery.contradictions.length === 0) return

  const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : []
  for (const contradiction of manifest.ciDiscovery.contradictions) {
    const warning = `CI discovery contradiction: ${contradiction}`
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  manifest.warnings = warnings
}

function buildCiDiscovery ({ manifest, diagnosis }) {
  const declared = isObject(manifest.ciDiscovery) ? manifest.ciDiscovery : {}
  const staticFound = getStaticWorkflowLocations(diagnosis)
  const declaredFound = normalizeStringArray(declared.found)
  const searched = normalizeStringArray(declared.searched)
  const method = typeof declared.method === 'string' && declared.method
    ? declared.method
    : declaredFound.length > 0
      ? 'manifest'
      : 'validator-static-diagnosis'
  const found = declaredFound.length > 0 ? declaredFound : staticFound
  const contradictions = getCiDiscoveryContradictions({ manifest, declaredFound, staticFound })

  return {
    searched: searched.length > 0 ? searched : DEFAULT_CI_SEARCHES,
    found,
    staticFound,
    method,
    warnings: normalizeStringArray(declared.warnings),
    notes: normalizeStringArray(declared.notes),
    contradictions,
  }
}

function getFrameworkCiDiscoveryContradiction (framework, manifest) {
  const ciDiscovery = manifest?.ciDiscovery
  if (!ciDiscovery || !Array.isArray(ciDiscovery.staticFound) || ciDiscovery.staticFound.length === 0) return null
  if (!frameworkClaimsNoCi(framework)) return null

  return {
    reason: 'CI workflow files were found by validator static diagnosis, but this manifest entry says no CI ' +
      'workflow was found. The manifest cannot support a "no CI workflow found" conclusion.',
    recommendation: 'Inspect the discovered CI files with hidden-directory-aware discovery, then update ciWiring, ' +
      'ciWiringCommand, omittedTestCommands, notes, or unresolved blockers before rerunning live validation.',
    ciDiscovery,
  }
}

function manifestHasCiDiscoveryContradiction (manifest) {
  return Array.isArray(manifest?.ciDiscovery?.contradictions) &&
    manifest.ciDiscovery.contradictions.length > 0
}

function getCiDiscoveryContradictions ({ manifest, declaredFound, staticFound }) {
  if (staticFound.length === 0) return []

  const contradictions = []
  if (isObject(manifest.ciDiscovery) && declaredFound.length === 0) {
    contradictions.push(
      `manifest ciDiscovery.found is empty, but static diagnosis found ${formatList(staticFound)}`
    )
  }

  for (const framework of manifest.frameworks || []) {
    if (!frameworkClaimsNoCi(framework)) continue
    contradictions.push(
      `framework ${framework.id || '<unknown>'} records no CI workflow, but static diagnosis found ` +
        formatList(staticFound)
    )
  }

  return contradictions
}

function frameworkClaimsNoCi (framework) {
  const ciWiring = framework?.ciWiring
  if (!isObject(ciWiring)) return false
  if (ciWiring.provider === 'none') return true

  return textClaimsNoCi([
    ciWiring.diagnosis,
    ...(Array.isArray(ciWiring.unresolved) ? ciWiring.unresolved : []),
    ...(Array.isArray(framework.notes) ? framework.notes : []),
  ])
}

function textClaimsNoCi (values) {
  return values.some(value => {
    if (typeof value !== 'string') return false
    return /no .*ci .*workflow/i.test(value) ||
      /no .*ci .*configuration/i.test(value) ||
      /no github actions.*gitlab.*circleci.*jenkins/i.test(value)
  })
}

function getStaticWorkflowLocations (diagnosis) {
  const results = Array.isArray(diagnosis?.results) ? diagnosis.results : []
  const locations = []
  const seen = new Set()

  for (const result of results) {
    if (result.title !== 'CI workflow files found' || !Array.isArray(result.locations)) continue
    for (const location of result.locations) {
      if (typeof location !== 'string' || seen.has(location)) continue
      seen.add(location)
      locations.push(location)
    }
  }

  return locations
}

function normalizeStringArray (value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string')
}

function formatList (values) {
  return values.map(value => `"${value}"`).join(', ')
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  annotateCiDiscovery,
  buildCiDiscovery,
  getFrameworkCiDiscoveryContradiction,
  getStaticWorkflowLocations,
  manifestHasCiDiscoveryContradiction,
}
