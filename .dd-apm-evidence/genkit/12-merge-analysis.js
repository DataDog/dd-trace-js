'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const evidenceDirectory = __dirname
const analysisFile = path.join(evidenceDirectory, '07-merged-analysis.json')
const contextFile = path.join(evidenceDirectory, '11-context-mappings.json')
const outputFile = path.join(evidenceDirectory, '12-final-analysis.json')

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256 (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function merge () {
  const analysis = readJson(analysisFile)
  const context = readJson(contextFile)

  assert.equal(analysis.success, true)
  assert.equal(analysis.package.name, context.package.name)
  assert.equal(analysis.package.version, context.package.version)
  assert.equal(analysis.package.hook_package, context.package.hook_package)
  assert.equal(analysis.package.hook_package_version, context.package.hook_package_version)
  assert.equal(context.runtime_contract.observed_argument_count, 2)
  assert.equal(context.runtime_contract.three_argument_overload_observed, false)

  const targets = clone(analysis.analysis.instrumentation_targets)
  const mappingsByMethod = new Map(context.mappings.map(mapping => [mapping.method, mapping]))
  const missingMappings = []

  for (const target of targets) {
    const mapping = mappingsByMethod.get(target.method)
    if (!mapping) {
      missingMappings.push(target.method)
      continue
    }

    target.runtime_context = clone(mapping)
  }

  assert.deepEqual(missingMappings, [])
  assert.equal(mappingsByMethod.size, targets.length)

  const toolTarget = targets.find(target => target.operation_type === 'tool')
  assert(toolTarget)
  toolTarget.error_handling = 'Record runner errors and ToolInterruptError. At this hook a beta tool interrupt rejects; Genkit catches it above the tool action and completes the outer generation successfully with finishReason=interrupted.'
  toolTarget.llmobs.output.transform = 'Use bounded output on success. On ToolInterruptError, tag the tool span as an error with empty output; do not represent the hook completion as successful merely because the outer generation later returns finishReason=interrupted.'
  toolTarget.runtime_resolution = {
    review_finding: 'GENKIT-REVIEW-006',
    status: 'resolved_by_exact_version_runtime_capture',
    hook_completion: 'error',
    error_name: 'ToolInterruptError',
    outer_generation_completion: 'success with finishReason=interrupted',
    evidence: '11-context-snapshot.json',
  }

  const originalBlockers = clone(analysis.unresolved_blockers)
  const interruptBlocker = 'Tool interrupt completion semantics require an executable 1.21.0 fixture.'
  assert(originalBlockers.includes(interruptBlocker))
  const unresolvedBlockers = originalBlockers.filter(blocker => blocker !== interruptBlocker)

  const finalAnalysis = {
    schema_version: 1,
    stage: '12-merge-layers',
    success: true,
    package: clone(analysis.package),
    source_layers: {
      reviewed_analysis: '07-merged-analysis.json',
      runtime_context_mapping: '11-context-mappings.json',
      runtime_snapshot: '11-context-snapshot.json',
    },
    context_mapping: {
      status: 'runtime_observed',
      source: '11-context-mappings.json',
      mapping_count: context.mappings.length,
      runtime_contract: clone(context.runtime_contract),
      overload_evidence: {
        two_argument: {
          status: 'runtime_observed',
          argument_count: 2,
          options_path: 'ctx.arguments[0]',
          callback_path: 'ctx.arguments[1]',
        },
        three_argument: {
          status: 'source_only_not_runtime_observed',
          argument_count: 3,
          registry_path: 'ctx.arguments[0]',
          options_path: 'ctx.arguments[1]',
          callback_path: 'ctx.arguments[2]',
        },
        implementation_rule: 'Select opts with ctx.arguments.length === 3 ? ctx.arguments[1] : ctx.arguments[0]. Do not describe the three-argument layout as runtime-proven by the sample.',
      },
      mappings: clone(context.mappings),
      nesting: clone(context.nesting_observations),
    },
    hook: clone(analysis.hook),
    analysis: {
      summary: `${analysis.analysis.summary} Stage 11 runtime capture confirms all five mappings on the two-argument overload and corrects selected-span nesting and tool-interrupt completion semantics.`,
      instrumentation_targets: targets,
      rejected_targets: clone(analysis.analysis.rejected_targets),
      review_findings: clone(analysis.analysis.review_findings),
    },
    review: clone(analysis.review),
    runtime_resolutions: {
      selected_span_nesting: {
        status: 'observed',
        correction: context.nesting_observations.important_correction,
        actual_selected_relationships: clone(context.nesting_observations.actual_selected_relationships),
        implementation_requirement: 'Preserve the full async context. Tests of selected spans must assert flow -> flowStep and flowStep as the nearest selected ancestor of retrieval, embedding, both model turns, and the model-selected tool; they must not assert model -> tool -> model parentage.',
      },
      tool_interrupt: clone(toolTarget.runtime_resolution),
    },
    blockers: {
      review_record: originalBlockers,
      resolved_after_review: [
        {
          blocker: interruptBlocker,
          resolution: 'The exact 1.21.0 fixture observed ToolInterruptError at the tool hook and successful interrupted completion only at the outer generation.',
          evidence: '11-context-snapshot.json',
        },
      ],
      unresolved: unresolvedBlockers,
    },
    unresolved_blockers: unresolvedBlockers,
    limitations: clone(context.limitations),
    provenance: {
      source_sha256: {
        '07-merged-analysis.json': sha256(analysisFile),
        '11-context-mappings.json': sha256(contextFile),
        '11-context-snapshot.json': sha256(path.join(evidenceDirectory, '11-context-snapshot.json')),
      },
      merge_policy: 'Stage 07 remains the authoritative reviewed target/path/privacy contract. Stage 11 replaces the absent context layer, adds observed field paths and nesting, and resolves tool-interrupt semantics. Original review findings, required changes, constraints, paths, rejected targets, and blocker history remain preserved.',
    },
    validation: {
      reviewed_target_count: targets.length,
      runtime_mapping_count: context.mappings.length,
      missing_mappings: missingMappings,
      observed_operation_count: new Set(context.mappings.map(mapping => mapping.operation)).size,
      all_review_overrides_preserved: true,
      all_cjs_esm_paths_preserved: true,
      two_argument_overload_runtime_observed: true,
      three_argument_overload_runtime_observed: false,
      selected_nesting_corrected: true,
      interrupt_semantics_resolved: true,
      unresolved_blocker_count: unresolvedBlockers.length,
    },
  }

  validate(finalAnalysis, analysis, context)
  return finalAnalysis
}

function validate (result, analysis, context) {
  assert.equal(result.analysis.instrumentation_targets.length, 5)
  assert.equal(result.context_mapping.mappings.length, 5)
  assert.deepEqual(result.analysis.rejected_targets, analysis.analysis.rejected_targets)
  assert.deepEqual(result.analysis.review_findings, analysis.analysis.review_findings)
  assert.deepEqual(result.hook, analysis.hook)
  assert.deepEqual(result.review, analysis.review)

  for (let index = 0; index < result.analysis.instrumentation_targets.length; index++) {
    const target = result.analysis.instrumentation_targets[index]
    const original = analysis.analysis.instrumentation_targets[index]
    const mapping = context.mappings[index]

    assert.equal(target.method, original.method)
    assert.deepEqual(target.file_paths, original.file_paths)
    assert.deepEqual(target.review, original.review)
    assert.deepEqual(target.runtime_context, mapping)
    assert(target.file_paths.some(file => file.module_type === 'commonjs'))
    assert(target.file_paths.some(file => file.module_type === 'esm'))
  }

  assert.equal(result.context_mapping.status, 'runtime_observed')
  assert.equal(result.context_mapping.overload_evidence.two_argument.status, 'runtime_observed')
  assert.equal(result.context_mapping.overload_evidence.three_argument.status, 'source_only_not_runtime_observed')
  assert.match(result.context_mapping.overload_evidence.implementation_rule, /arguments\.length === 3/)
  assert.match(result.runtime_resolutions.selected_span_nesting.correction, /not a direct parent-child chain/)
  assert.equal(result.runtime_resolutions.tool_interrupt.error_name, 'ToolInterruptError')
  assert.equal(result.runtime_resolutions.tool_interrupt.hook_completion, 'error')
  assert.equal(result.runtime_resolutions.tool_interrupt.outer_generation_completion, 'success with finishReason=interrupted')
  assert.equal(result.blockers.review_record.length, analysis.unresolved_blockers.length)
  assert.equal(result.blockers.resolved_after_review.length, 1)
  assert.equal(result.unresolved_blockers.length, analysis.unresolved_blockers.length - 1)
  assert(result.unresolved_blockers.some(blocker => blocker.includes('Duplicate native OpenTelemetry/provider spans')))
  assert(result.unresolved_blockers.some(blocker => blocker.includes('semver range')))
}

const result = merge()
const serialized = `${JSON.stringify(result, null, 2)}\n`

if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(outputFile, 'utf8'), serialized)
  process.stdout.write(`${JSON.stringify(result.validation)}\n`)
} else {
  process.stdout.write(serialized)
}
