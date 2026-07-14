'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const evidenceDirectory = __dirname
const sourceFiles = {
  analysis: '04-target-selection.json',
  enrichment: '05-enrichments.json',
  review: '06-review-decisions.json',
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(path.join(evidenceDirectory, file), 'utf8'))
}

function hash (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(evidenceDirectory, file))).digest('hex')
}

function omit (value, excludedKeys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excludedKeys.has(key)))
}

const llmobsOverrides = {
  generation: {
    registration: {
      default_kind: 'llm',
      provider_integration_kind: 'workflow',
      name: 'opts.metadata.name',
      model_provider: 'Only a proven registered-action-name prefix; otherwise undefined.',
      model_name: 'Only a proven registered-action-name model component; otherwise undefined.',
    },
    input: {
      source: 'opts.metadata.input.messages',
      tagger: 'tagLLMIO',
      transform: [
        'Map Genkit role model to assistant.',
        'Join only string part.text values into bounded message content.',
        'Map toolRequest to toolCalls entries with name, arguments, toolId, and optional type.',
        'Map toolResponse to toolResults entries with bounded string result, toolId, name, and optional type.',
        'Drop media URLs, data parts, custom parts, raw provider values, and message metadata.',
      ],
    },
    output: {
      source: 'ctx.result.message, with parsed opts.metadata.output.message only as fallback',
      tagger: 'tagLLMIO',
      transform: 'Apply the same message normalization; use an empty normalized output message on error.',
    },
    metrics: {
      source: 'ctx.result.usage',
      mapping: {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        totalTokens: 'total_tokens',
      },
      constraint: 'Tag only values that are numeric; do not invent or relabel other usage fields.',
    },
    metadata: 'Explicit reviewed scalar generation-config allowlist only; exclude raw, custom, context, payloads, and secrets.',
  },
  workflow: {
    registration: { kind: 'workflow', name: 'opts.metadata.name' },
    input: {
      source: 'opts.metadata.input',
      tagger: 'tagTextIO',
      transform: 'Bounded LLMObs serialization subject to configured content capture and redaction.',
    },
    output: {
      source: 'ctx.result, with parsed opts.metadata.output only as fallback',
      tagger: 'tagTextIO',
      transform: 'Bounded LLMObs serialization; empty output on error.',
    },
    apm_payload_capture: false,
  },
  tool: {
    registration: { kind: 'tool', name: 'opts.metadata.name' },
    input: {
      source: 'opts.metadata.input',
      tagger: 'tagTextIO',
      transform: 'Bounded LLMObs serialization subject to configured content capture and redaction.',
    },
    output: {
      source: 'ctx.result, with parsed opts.metadata.output only as fallback',
      tagger: 'tagTextIO',
      transform: 'Bounded string output; interrupt error/success semantics remain blocked on an exact-version fixture.',
    },
    apm_payload_capture: false,
  },
  retrieval: {
    registration: { kind: 'retrieval', name: 'opts.metadata.name' },
    input: {
      source: 'opts.metadata.input.query',
      tagger: 'tagRetrievalIO',
      output_shape: [{ text: 'string' }],
      transform: 'Join only query.content part.text strings; never pass DocumentData directly.',
    },
    output: {
      source: 'ctx.result.documents',
      tagger: 'tagRetrievalIO',
      output_shape: [{ text: 'string', name: 'optional string', id: 'optional string', score: 'optional number' }],
      transform: 'Convert each DocumentData content array to text and copy only explicitly reviewed scalar name/id/score.',
      error_value: [],
    },
    excluded: ['arbitrary document metadata', 'non-text parts', 'raw DocumentData objects'],
  },
  embedding: {
    registration: { kind: 'embedding', name: 'opts.metadata.name' },
    input: {
      source: 'opts.metadata.input.input',
      tagger: 'tagEmbeddingIO',
      output_shape: [{ text: 'string', name: 'optional string', id: 'optional string' }],
      transform: 'Convert each DocumentData content array to text; never pass DocumentData directly.',
    },
    output: {
      source: 'ctx.result.embeddings',
      tagger: 'tagEmbeddingIO',
      output_shape: 'bounded summary string',
      transform: 'Emit [N embedding(s) returned with size D]; never serialize numeric vectors or embedding metadata.',
      error_value: '',
    },
    excluded: ['numeric embedding vectors', 'arbitrary document metadata', 'embedding metadata'],
  },
}

function buildMerged () {
  const analysis = readJson(sourceFiles.analysis)
  const enrichment = readJson(sourceFiles.enrichment)
  const review = readJson(sourceFiles.review)

  assert.equal(enrichment.success, true)
  assert.deepEqual(enrichment.missing_targets, [])
  assert.equal(analysis.package_name, review.package.name)
  assert.equal(analysis.package_version, review.package.version)

  const enrichments = new Map(enrichment.enrichments.targets.map(target => [target.target_name, target]))
  const decisions = new Map(review.target_decisions.map(target => [target.target, target]))
  const targets = analysis.analysis.instrumentation_targets.map(baseTarget => {
    const enriched = enrichments.get(baseTarget.method)
    const decision = decisions.get(baseTarget.method)
    assert(enriched, `missing enrichment for ${baseTarget.method}`)
    assert(decision, `missing review decision for ${baseTarget.method}`)
    assert(llmobsOverrides[decision.operation], `missing merge override for ${decision.operation}`)

    const target = omit(baseTarget, new Set([
      'file_path',
      'line_number',
      'module_name',
      'file_paths',
      'span_tags',
    ]))

    return {
      ...target,
      target_name: baseTarget.method,
      module_name: enriched.module_name,
      file_path: enriched.file_path,
      line_number: enriched.line_number,
      file_paths: enriched.file_paths,
      function_kind: enriched.kind,
      export_type: enriched.export_type,
      confirmed_in_library: enriched.confirmed_in_library,
      source: enriched.language_specific.javascript,
      review: {
        decision: decision.decision,
        accepted_kind: decision.accepted_kind,
        required_changes: decision.required_changes,
      },
      apm: {
        span_name: baseTarget.span_name,
        span_kind: baseTarget.span_kind,
        span_type: baseTarget.span_type,
        safe_tags: {
          component: 'genkit',
          'genkit.operation.type': decision.operation,
          'genkit.action.name': 'opts.metadata.name',
        },
        payload_tags_allowed: false,
      },
      llmobs: llmobsOverrides[decision.operation],
      limitations: [
        'Input schema parsing happens before the selected hook and output schema parsing happens after it.',
        ...(decision.operation === 'generation'
          ? ['Native OpenTelemetry and provider integration duplicate-span behavior remains a runtime blocker.']
          : []),
      ],
    }
  })

  assert.equal(targets.length, analysis.analysis.instrumentation_targets.length)
  assert.equal(targets.length, enrichment.total_targets)
  assert.equal(targets.length, review.target_decisions.length)
  assert.equal(enrichments.size, targets.length)
  assert.equal(decisions.size, targets.length)

  const merged = {
    schema_version: 1,
    stage: '07-merge-layers',
    success: true,
    package: {
      name: analysis.package_name,
      version: analysis.package_version,
      category: analysis.category,
      subcategory: analysis.subcategory,
      llmobs_category: review.category_decision.value,
      hook_package: review.package.hook_package,
      hook_package_version: review.package.hook_package_version,
    },
    source_layers: {
      analysis: sourceFiles.analysis,
      enrichment: sourceFiles.enrichment,
      review: sourceFiles.review,
      context_mapping: null,
    },
    context_mapping: {
      status: 'not_available_yet',
      mappings: [],
      note: 'This is the pre-sample-app merge. No runtime context mapping artifact exists yet.',
    },
    hook: {
      decision: review.hook_decision.decision,
      target: review.hook_decision.target,
      constraints: review.hook_decision.constraints,
      registration: enrichment.hook_registration,
      coverage_limit: 'Runner/provider errors and asynchronous work only; schema-validation failures outside runInNewSpan are not covered.',
    },
    analysis: {
      summary: analysis.analysis.summary,
      instrumentation_targets: targets,
      rejected_targets: review.rejected_targets,
      review_findings: review.findings,
    },
    review: {
      overall_decision: review.overall_decision,
      category_decision: review.category_decision,
      review_mode: review.review_mode,
    },
    unresolved_blockers: review.unresolved_blockers,
    provenance: {
      source_sha256: Object.fromEntries(Object.values(sourceFiles).map(file => [file, hash(file)])),
      override_policy: 'Stage 05 replaces Stage 04 hook metadata. Stage 06 replaces superseded Stage 04 tagger mappings and supplies final constraints, rejections, findings, and blockers.',
    },
    validation: {
      base_target_count: analysis.analysis.instrumentation_targets.length,
      enriched_target_count: enrichment.found_targets,
      review_target_count: review.target_decisions.length,
      merged_target_count: targets.length,
      missing_targets: [],
      context_mapping_count: 0,
      all_review_overrides_applied: true,
      superseded_span_tags_removed: targets.every(target => target.span_tags === undefined),
    },
  }

  for (const target of merged.analysis.instrumentation_targets) {
    assert.equal(target.span_tags, undefined)
    assert.equal(target.file_paths.length, 2)
    assert.deepEqual(new Set(target.file_paths.map(file => file.module_type)), new Set(['commonjs', 'esm']))
    assert.deepEqual(target.review.required_changes, decisions.get(target.target_name).required_changes)
    assert(target.llmobs.input.transform)
    assert(target.llmobs.output.transform)
  }
  const targetsByOperation = new Map(merged.analysis.instrumentation_targets.map(target => [
    target.operation_type,
    target,
  ]))
  assert.equal(targetsByOperation.get('generation').llmobs.registration.provider_integration_kind, 'workflow')
  assert(targetsByOperation.get('generation').llmobs.input.transform.includes('Map Genkit role model to assistant.'))
  assert.match(targetsByOperation.get('retrieval').llmobs.output.transform, /DocumentData content array to text/)
  assert.equal(targetsByOperation.get('retrieval').llmobs.output.output_shape[0].text, 'string')
  assert.equal(targetsByOperation.get('embedding').llmobs.output.output_shape, 'bounded summary string')
  assert.match(targetsByOperation.get('embedding').llmobs.output.transform, /never serialize numeric vectors/)
  assert.deepEqual(merged.unresolved_blockers, review.unresolved_blockers)
  assert.deepEqual(merged.analysis.review_findings, review.findings)
  assert.deepEqual(merged.analysis.rejected_targets, review.rejected_targets)
  assert.equal(merged.context_mapping.status, 'not_available_yet')
  assert.deepEqual(merged.context_mapping.mappings, [])

  return merged
}

const merged = buildMerged()
const serialized = `${JSON.stringify(merged, null, 2)}\n`
const outputPath = path.join(evidenceDirectory, '07-merged-analysis.json')

if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(outputPath, 'utf8'), serialized, 'merged artifact is stale')
  console.log(JSON.stringify(merged.validation))
} else {
  process.stdout.write(serialized)
}
