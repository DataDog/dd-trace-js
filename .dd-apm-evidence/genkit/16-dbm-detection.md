# Stage 16 feature detection: DBM

Date: 2026-07-14 UTC

## Decision

```json
{
  "feature_id": "dbm",
  "applicable": false
}
```

Database Monitoring does not apply to the Genkit integration. The Stage 16 contract limits DBM to database clients
that execute SQL queries. Exact `genkit@1.21.0` is a provider-neutral generative-AI and workflow orchestration
framework, not a database client.

## Evidence

The Stage 12 final analysis selects one `@genkit-ai/core@1.21.0` `runInNewSpan` hook, filtered to model, flow,
flow-step, tool, retriever, and embedder actions. The three `client`-kind operations are generation, retrieval, and
embedding. Their span kind reflects request/response semantics; it does not make them database operations. Their
safe APM tags contain only the Genkit component, operation type, and action name. There is no database system,
database name, SQL statement, query text, host, or connection context.

The exact upstream action implementation in `@genkit-ai/core/src/action.ts` validates action input, calls the
user/provider runner inside `runInNewSpan`, records generic action metadata, and validates output. It has no SQL
execution or query injection point. The exact retriever implementation in `@genkit-ai/ai/src/retriever.ts` wraps a
user-provided `RetrieverFn` and passes it a `Document` query plus options. Genkit does not know whether that runner
uses a SQL database, vector database, in-memory array, network service, or another implementation.

The exact `1.21.0` manifests for `genkit`, `@genkit-ai/core`, and `@genkit-ai/ai` contain no dependencies matching
common SQL/database clients or ORMs. A bounded source scan found no SQL statement execution in their shipped
`src`/`lib` trees; the sole incidental match was the JavaScript keyword `delete` in a prompt bookkeeping comment.

The current APM plugin mirrors that contract: `packages/datadog-plugin-genkit/src/index.js` creates `genkit`
spans for the five operation families and emits no `db.*`, SQL, or DBM propagation fields. The Orchestrion hook
only wraps `runInNewSpan` in `@genkit-ai/core@1.21.0`.

If a user-supplied retriever executes SQL, the concrete database client integration owns the database span, DBM
tags, and SQL comment/trace-context injection. Adding DBM behavior to the enclosing Genkit retrieval span would
misclassify a generic abstraction and cannot safely modify an unknown downstream query.

## Feature-guide availability

No standalone DBM feature guide was found in the repository skill or pipeline trees. The decision therefore uses
the explicit Stage 16 DBM applicability rule, the Stage 12 contract, the current implementation, and exact-version
upstream source. This missing optional guide is not represented as a passed capability.

## Reproduction commands

Run from `/workspace/repo`:

```sh
node -e "const x=require('./.dd-apm-evidence/genkit/12-final-analysis.json'); console.log(x.package); console.log(x.analysis.instrumentation_targets.map(({ operation_type, span_kind, apm }) => ({ operation_type, span_kind, apm })))"

node - <<'NODE'
const fs = require('node:fs')
for (const name of ['genkit', '@genkit-ai/core', '@genkit-ai/ai']) {
  const manifest = `/tmp/dd-apm-genkit-1.21.0/node_modules/${name}/package.json`
  const packageData = JSON.parse(fs.readFileSync(manifest))
  const dependencies = {
    ...packageData.dependencies,
    ...packageData.optionalDependencies,
    ...packageData.peerDependencies,
  }
  const databaseDependencies = Object.entries(dependencies)
    .filter(([dependency]) => /(pg|postgres|mysql|mariadb|sqlite|sequelize|typeorm|knex|prisma|mongodb|cassandra|redis|database|sql)/i.test(dependency))
  console.log({ name: packageData.name, version: packageData.version, databaseDependencies })
}
NODE

rg -n -i --glob '!**/*.map' --glob '!**/*.d.ts' \
  '\b(select|insert|update|delete)\b.+\b(from|into|set)\b|\b(sql|query text|database connection|dbm)\b' \
  /tmp/dd-apm-genkit-1.21.0/node_modules/{genkit,@genkit-ai/core,@genkit-ai/ai}/{src,lib}

sed -n '110,205p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/ai/src/retriever.ts
sed -n '285,395p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/action.ts
rg -n 'db\.|sql|DBM|_dd\.dbm_trace_injected' packages/datadog-plugin-genkit packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/genkit.js
node -e "const x=require('./.dd-apm-evidence/genkit/16-dbm-decision.json'); if (x.feature_id !== 'dbm' || x.applicable !== false) process.exit(1); console.log('DBM decision valid')"
```

## Validation

- Target package: `genkit@1.21.0`.
- Hook package: `@genkit-ai/core@1.21.0`.
- Feature: `dbm`.
- Applicable: `false`.
- Production files modified by this detector: none.
- `PROGRESS.md` modified by this detector: no.
