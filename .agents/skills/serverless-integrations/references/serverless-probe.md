# Deployed Serverless Probe

Local tests cannot prove that a serverless integration works in the real provider lifecycle. A new or materially
changed platform integration needs an explicit deployed probe plan.

## Probe Modes

Use the narrowest mode that answers the risk:

- Manual: document commands for a maintainer to deploy, invoke, query, and clean up.
- Semi-automated: provide scripts that deploy and invoke, while the maintainer supplies credentials.
- CI-automated: run only when repository policy and provider credentials already support it.

Do not require permanent infrastructure for a probe unless the project already has that pattern.

## Probe App Requirements

The deployed app should:

- use the dd-trace-js version under test;
- enable the new serverless integration explicitly when needed;
- emit one deterministic child span inside the handler;
- support success and error invocations;
- include a unique probe id in tags, for example `dd.apm.probe_id:<uuid>`;
- keep resource names and payloads low-cardinality;
- clean up provider resources after the run.

## Datadog Assertions

The probe must verify traces reached Datadog, not only that invocation logs exist. Query by the unique probe id and
assert:

- one invocation root span exists per invocation;
- the root span has `type:serverless` and the expected service/resource;
- the deterministic child span is parented under the invocation span;
- errors are tagged on failing invocations;
- distributed context or span links appear for trigger types that carry upstream context;
- no duplicate root spans are emitted for one invocation.

If Datadog trace search is eventually consistent, poll with a bounded timeout and report the query window used.

## Evidence To Capture

Record the provider, region, runtime version, deployed app commit or package version, invocation ids, probe id, and
Datadog query used. When the probe is manual, include the expected trace shape and cleanup command in the workflow
output or PR description.

## Failure Diagnosis

Classify failures by layer:

- deployment failed: provider or packaging issue;
- invocation failed before user handler: runtime wrapper or bootstrap issue;
- logs show spans but Datadog has no trace: writer, flush, or mini-agent issue;
- root span exists without children: async context binding issue;
- children exist without root: invocation start or parent extraction issue;
- duplicate roots: handler wrapping or completion path issue.
