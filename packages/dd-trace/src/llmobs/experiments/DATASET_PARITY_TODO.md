# LLMObs Experiments Dataset Parity Handoff

This document tracks dataset features present in `dd-trace-py` that are not yet implemented, or only partially implemented, in the Node.js LLMObs experiments SDK.

Python reference implementation:

- `/Users/mehul.sonowal/dd/dd-trace-py/ddtrace/llmobs/_llmobs.py`
- `/Users/mehul.sonowal/dd/dd-trace-py/ddtrace/llmobs/_experiment.py`
- `/Users/mehul.sonowal/dd/dd-trace-py/ddtrace/llmobs/_writer.py`
- `/Users/mehul.sonowal/dd/dd-trace-py/tests/llmobs/test_experiments.py`

Current Node implementation:

- `packages/dd-trace/src/llmobs/experiments/index.js`
- `packages/dd-trace/src/llmobs/experiments/dataset.js`
- `packages/dd-trace/test/llmobs/experiments/index.spec.js`
- `packages/dd-trace/test/llmobs/experiments/experiment.spec.js`

## Already covered in the first dataset-operations slice

- `createDataset(name, { description, records })`
- `createDatasetFromCsv(csvPath, name, options)`
- `pullDataset(name, { version })`
- pull pagination via `meta.after`
- dataset `version()` / `latestVersion()` accessors
- staging UI URL mapping from `datad0g.com` to `dd.datad0g.com`

These are a P0 subset, not full Python parity.

## Missing or partial dataset features

| Feature | Python behavior | Node status | Notes |
|---|---|---:|---|
| `create_dataset_from_csv` | Parses CSV into records with selected input, expected output, metadata columns, delimiter, and optional id column. | Implemented | Added as `createDatasetFromCsv`; current implementation creates a local dataset buffer instead of Python's immediate remote bulk upload. |
| Pull by tags | `pull_dataset(..., tags=["k:v"])` validates tags and sends repeated `filter[tags]` params. | Missing | Needed for record filtering/scoping. |
| Custom record IDs | New records can include `id`; duplicate IDs are rejected. | Partial | `createDataset` records and `createDatasetFromCsv` can send custom IDs with duplicate validation; direct `addRecord` ID ergonomics are still missing. |
| Record tags | Records support `tags`. | Missing | Needed before tag filters are useful. |
| Python-compatible append/extend names | `Dataset.append(record)` and `Dataset.extend(records)`. | Partial | JS has `addRecord`; may keep alias for ergonomics. |
| Record update | `Dataset.update(index, record)` updates input, expected output, metadata, or tags. | Missing | Requires local delta tracking and batch update endpoint. |
| Record delete | `Dataset.delete(index)` removes pending or pushed records. | Missing | Requires delete delta tracking. |
| Push options | `push(deduplicate=True, create_new_version=True, bulk_upload=None)`. | Missing | JS `push()` currently takes no options. |
| Deduplication | Batch/bulk payloads include `deduplicate`. | Missing | Decide naming: `deduplicate`. |
| Create new version | Batch update can choose whether to create a new dataset version. | Missing | Decide naming: `createNewVersion`. |
| Batch update endpoint | Uses `/batch_update` with inserts, updates, deletes, dedupe, versioning. | Missing | Needed for update/delete/tag parity. |
| Bulk upload endpoint | Multipart CSV upload for large initial/delta uploads. | Missing | Useful for large datasets; Python auto-selects above threshold. |
| Record tag operations | `add_tags`, `remove_tags`, `replace_tags`; operations accumulate before push. | Missing | JS names could be `addTags`, `removeTags`, `replaceTags`. |
| Version update after mutation push | Python updates `.version` / `.latest_version` from backend batch response. | Partial | JS sets versions on create/pull but not append push response. |
| Validation parity | Python validates tags, duplicate IDs, empty update, CSV headers, missing id column, etc. | Partial | Add with each feature. |
| `as_dataframe` | Python returns pandas DataFrame. | Missing / likely not applicable | Consider omitting or providing a JS-friendly export helper only if requested. |

## Suggested future implementation order

1. **Record schema parity**
   - Add support for `id`, `tags`, `canonicalId`/`canonical_id` where applicable.
   - Preserve current `{ inputData, expectedOutput, metadata }` ergonomics.
   - Add duplicate custom ID validation.

2. **Pull tags filter**
   - Add `pullDataset(name, { tags })`.
   - Validate `tags` is an array of strings.
   - Send repeated `filter[tags]` query params.

3. **Mutation tracking + batch update**
   - Add `append` / `extend` aliases.
   - Add `update`, `delete`.
   - Track inserts, updates, deletes, and pending tag operations separately.
   - Implement `/batch_update` payload and response parsing.

4. **Push options**
   - Add `push({ deduplicate = true, createNewVersion = true, bulkUpload })`.
   - Update version/latestVersion from backend responses.

5. **Tag operations**
   - Add `addTags`, `removeTags`, `replaceTags`.
   - Mirror Python merge/cancellation behavior for accumulated ops.

6. **Bulk upload**
   - Add explicit and threshold-based bulk upload behavior.

## Important Python details to preserve

- Python's `pull_dataset` uses `filter[version]` only when a version is provided.
- Python's `pull_dataset` appends one `filter[tags]` query param per tag.
- Python's `Dataset.append(record)` uses `record.id` or generates a UUID.
- Duplicate record IDs fail before push.
- `Dataset.update(index, record)` rejects empty updates.
- For pushed records, tag changes are accumulated as operations and folded into update records during `push()`.
- A `replace` tag operation overrides prior add/remove operations; later add/remove operations fold into the replacement set.
- Python batch update maps tag `replace` to backend `set`.
- Python bulk CSV upload serializes `input`, `expected_output`, `metadata`, and `id`; tags are not serialized in bulk CSV.

## Current PR note

The draft PR created from `feat/llmobs-node-experiments-p0` currently includes only the first dataset operations slice. The rest of this file is a backlog for follow-up work, not expected to be completed in that PR.
