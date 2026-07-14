'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const evidenceDirectory = __dirname
const inputFile = '07-merged-analysis.json'
const outputFile = '08-sample-app-context.json'

function readJson (file) {
  return JSON.parse(fs.readFileSync(path.join(evidenceDirectory, file), 'utf8'))
}

function hash (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(evidenceDirectory, file))).digest('hex')
}

const scenarioOverrides = {
  generation: {
    required_cases: [
      'non-streaming generation success through a registered model action',
      'streaming generation with every chunk consumed and the final response awaited',
      'model runner rejection with captured input, empty normalized output, and error fields',
      'tool-loop generation proving model -> tool -> model ordering',
    ],
    success_evidence: [
      'normalized input/output messages with model role represented as assistant',
      'normalized toolCalls/toolResults when present',
      'numeric input_tokens, output_tokens, and total_tokens when returned',
      'model/provider values only when proven by the registered action name',
      'no media URL, data/custom payload, raw provider response, or message metadata leakage',
    ],
  },
  workflow: {
    required_cases: [
      'defined flow invocation with nested model, tool, retrieval, and embedding operations',
      'named ai.run flow step with exact genkit:type=flowStep discriminator',
      'flow runner rejection with workflow error fields',
    ],
    success_evidence: [
      'workflow input/output appears only in LLMObs capture, not ordinary APM payload tags',
      'flow and flow-step spans have the expected child relationships',
    ],
  },
  tool: {
    required_cases: [
      'model-selected tool invocation inside a generation loop',
      'ordinary tool runner rejection',
      'Genkit 1.21.0 tool interrupt fixture that records observed completion semantics without assuming error or success',
    ],
    success_evidence: [
      'bounded LLMObs tool input/output and no ordinary APM payload tags',
      'tool span is parented between the requesting and follow-up model spans',
    ],
  },
  retrieval: {
    required_cases: [
      'retriever success returning at least one DocumentData value',
      'retriever runner rejection',
    ],
    success_evidence: [
      'query and result documents are tagger-valid text objects',
      'only reviewed scalar name/id/score metadata is present',
      'no raw DocumentData or arbitrary document metadata is captured',
    ],
  },
  embedding: {
    required_cases: [
      'embedding success with multiple input documents and known vector dimension',
      'embedder runner rejection',
    ],
    success_evidence: [
      'input documents are tagger-valid text objects',
      'output is a bounded count/dimension summary',
      'no numeric vectors or arbitrary embedding/document metadata is captured',
    ],
  },
}

function buildContext () {
  const merged = readJson(inputFile)
  assert.equal(merged.success, true)
  assert.equal(merged.package.name, 'genkit')
  assert.equal(merged.package.version, '1.21.0')
  assert.equal(merged.package.hook_package, '@genkit-ai/core')
  assert.equal(merged.package.hook_package_version, '1.21.0')
  assert.equal(merged.context_mapping.status, 'not_available_yet')
  assert.deepEqual(merged.context_mapping.mappings, [])

  const targets = merged.analysis.instrumentation_targets.map(target => {
    const scenarios = scenarioOverrides[target.operation_type]
    assert(scenarios, `missing sample scenarios for ${target.operation_type}`)
    return {
      target_name: target.target_name,
      operation: target.operation_type,
      expected_llmobs_kind: target.review.accepted_kind,
      hook_discriminator: target.target_name.slice(target.target_name.indexOf('[') + 1, -1),
      module_name: target.module_name,
      function_name: target.location,
      function_kind: target.function_kind,
      file_paths: target.file_paths,
      required_cases: scenarios.required_cases,
      success_evidence: scenarios.success_evidence,
      llmobs_contract: target.llmobs,
      review_required_changes: target.review.required_changes,
      limitations: target.limitations,
    }
  })

  const context = {
    schema_version: 1,
    stage: '08-load-analysis',
    success: true,
    source: {
      file: inputFile,
      sha256: hash(inputFile),
      merged_stage: merged.stage,
    },
    package: merged.package,
    module_constraints: {
      orchestrion_module_name: merged.hook.registration.orchestrion_module_name,
      exact_version_under_test: merged.hook.registration.orchestrion_version,
      function_query: merged.hook.registration.function_query,
      required_instrumentation_paths: merged.hook.registration.required_file_paths,
      commonjs_entry_obligation: 'Run a CommonJS sample that reaches lib/tracing/instrumentation.js.',
      esm_entry_obligation: 'Run a public ESM import sample; at 1.21.0 it also reaches lib/tracing/instrumentation.js.',
      esm_counterpart_note: 'lib/tracing/instrumentation.mjs exists and remains configured, but is not directly package-exported; do not claim direct Node reachability.',
      registration_requirement: merged.hook.registration.registration_requirement,
      version_range_constraint: 'Only exactly 1.21.0 is proven. Do not claim a broader supported range without cross-version evidence.',
    },
    runtime_context_mapping: {
      status: 'not_captured',
      source: null,
      mappings: [],
      requested_capture_fields: [
        'ctx.arguments length and overload-specific opts index',
        'opts.labels before execution',
        'opts.metadata before and after execution',
        'ctx.result on success',
        'ctx.error on failure',
        'ctx.currentStore span identity and parent identity',
      ],
      note: 'These fields are capture requirements, not inferred context mappings.',
    },
    targets,
    expected_nesting: {
      primary_trace: [
        'workflow(flow)',
        'workflow(flowStep)',
        'llm(model turn 1)',
        'tool(model-selected invocation)',
        'llm(model turn 2)',
      ],
      sibling_children_of_flow_or_step: [
        'retrieval(retriever action)',
        'embedding(embedder action)',
      ],
      assertions: [
        'Every child trace_id equals its parent trace_id.',
        'Every child parent_id equals the immediately enclosing expected span_id.',
        'No duplicate authoritative llm span or duplicated token metrics exist for one provider request.',
        'Native Genkit OpenTelemetry spans are counted and distinguished from Datadog integration spans.',
      ],
    },
    streaming_obligations: [
      'Record chunk count and ordered bounded chunk summaries.',
      'Consume the stream to completion and separately await the final response promise.',
      'Prove the llm span finishes after final provider response/chunk production, not when generateStream returns its container.',
      'Record stream error propagation and span error fields.',
      'Do not claim that span duration includes delayed or abandoned consumer drain time.',
    ],
    error_obligations: [
      'Exercise runner/provider rejection for model, workflow, tool, retrieval, and embedding targets.',
      'Capture error type, message, stack/error tags, span error flag, final output shape, and parent-child relationships.',
      'Record that invalid input/output schema parsing occurs outside the selected hook rather than claiming coverage.',
      'Exercise tool interrupt separately and preserve the observed result as unresolved until evidence establishes semantics.',
    ],
    required_evidence_fields: {
      environment: [
        'command',
        'working_directory',
        'exit_code',
        'node_version',
        'package_manager_version',
        'genkit_version',
        'hook_package_version',
        'module_format',
        'reproduction_steps',
      ],
      apm_span: [
        'trace_id',
        'span_id',
        'parent_id',
        'name',
        'resource',
        'service',
        'type',
        'kind',
        'start',
        'duration',
        'error',
        'error.type',
        'error.message',
        'component',
        'genkit.operation.type',
        'genkit.action.name',
      ],
      llmobs_span: [
        'trace_id',
        'span_id',
        'parent_id',
        'kind',
        'name',
        'input',
        'output',
        'model_name',
        'model_provider',
        'metadata',
        'metrics.input_tokens',
        'metrics.output_tokens',
        'metrics.total_tokens',
        'error',
      ],
      streaming: [
        'chunk_count',
        'chunk_order',
        'stream_completed',
        'final_response_awaited',
        'final_output',
        'completion_or_error_timestamp',
      ],
      privacy_and_duplication: [
        'raw_payload_absence_checks',
        'embedding_vector_absence_check',
        'native_otel_span_count',
        'datadog_integration_span_count',
        'authoritative_llm_span_count_per_request',
        'token_metric_owners',
      ],
    },
    rejected_operations: merged.analysis.rejected_targets,
    carried_findings: merged.analysis.review_findings,
    carried_blockers: merged.unresolved_blockers,
    completion_gate: {
      status: 'pending_real_sample',
      pass_condition: 'All target cases execute against real genkit@1.21.0 and stored APM plus LLMObs output proves fields, nesting, streaming completion, errors, privacy, and no double counting.',
      unit_tests_alone_sufficient: false,
      ordinary_apm_without_llmobs_sufficient: false,
    },
    validation: {
      source_target_count: merged.analysis.instrumentation_targets.length,
      loaded_target_count: targets.length,
      missing_targets: [],
      operations: targets.map(target => target.operation),
      context_mapping_count: 0,
      blocker_count: merged.unresolved_blockers.length,
    },
  }

  assert.equal(context.targets.length, 5)
  assert.deepEqual(new Set(context.targets.map(target => target.operation)), new Set(Object.keys(scenarioOverrides)))
  assert(context.targets.every(target => target.required_cases.length >= 2))
  assert(context.targets.every(target => target.file_paths.some(file => file.module_type === 'commonjs')))
  assert(context.targets.every(target => target.file_paths.some(file => file.module_type === 'esm')))
  assert.deepEqual(context.carried_blockers, merged.unresolved_blockers)
  assert.deepEqual(context.carried_findings, merged.analysis.review_findings)
  assert.deepEqual(context.rejected_operations, merged.analysis.rejected_targets)
  assert.equal(context.runtime_context_mapping.source, null)
  assert.deepEqual(context.runtime_context_mapping.mappings, [])
  assert.equal(context.completion_gate.status, 'pending_real_sample')
  assert.equal(context.completion_gate.unit_tests_alone_sufficient, false)
  assert.equal(context.completion_gate.ordinary_apm_without_llmobs_sufficient, false)

  return context
}

const context = buildContext()
const serialized = `${JSON.stringify(context, null, 2)}\n`
const outputPath = path.join(evidenceDirectory, outputFile)

if (process.argv.includes('--check')) {
  assert.equal(fs.readFileSync(outputPath, 'utf8'), serialized, 'sample-app context artifact is stale')
  console.log(JSON.stringify(context.validation))
} else {
  process.stdout.write(serialized)
}
