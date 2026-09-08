'use strict'

// Control-plane HTTP client for LLM Obs Experiments. Uses the global `fetch`,
// so this module adds no new dependency; credentials and site come from config.

const { Dataset, DatasetRecord } = require('./dataset')
const { ExperimentResult } = require('./result')
const { hasEntries } = require('./util')

const API_BASE_PATH = '/api/v2/llm-obs/v1'
// Endpoints that only exist under the unstable prefix (same as dd-trace-py).
const UNSTABLE_API_BASE_PATH = '/api/unstable/llm-obs/v1'

const BULK_UPLOAD_BOUNDARY = '----------boundary------'
const BULK_UPLOAD_TIMEOUT = 120_000

// Control-plane host for a Datadog site, e.g.
//   datadoghq.com        -> api.datadoghq.com
//   us3.datadoghq.com    -> api.us3.datadoghq.com
//   datad0g.com (staging)-> api.datad0g.com
function apiHost (site) {
  return `api.${site}`
}

// Web-app host for dashboard URLs. Single-level sites (datadoghq.com,
// ddog-gov.com) are served from the `app.` subdomain; staging uses
// dd.datad0g.com; regional sites (us3.datadoghq.com, ap1.datadoghq.com)
// are used as-is.
function appHost (site) {
  if (site === 'datad0g.com') return 'dd.datad0g.com'
  return site.split('.').length === 2 ? `app.${site}` : site
}

function datasetRecordFromResource (resource) {
  const attrs = resource?.attributes ?? resource ?? {}
  const id = String(resource?.id ?? attrs.id ?? '')
  if (id === '') throw new Error('Dataset record response is missing an id')
  return new DatasetRecord(
    attrs.input ?? null,
    attrs.expected_output ?? null,
    attrs.metadata ?? {},
    id,
    attrs.tags ?? []
  )
}

function datasetVersionFromResource (resource) {
  const attrs = resource?.attributes ?? resource ?? {}
  return attrs.valid_from_version ?? attrs.version ?? null
}

function datasetVersionFromResources (resources) {
  const versions = resources
    .map(datasetVersionFromResource)
    .filter(version => version != null)
    .map(Number)
    .filter(Number.isFinite)
  if (versions.length === 0) return null
  return Math.max(...versions)
}

function datasetMutationResultFromResources (resources) {
  return {
    records: resources.map(datasetRecordFromResource),
    version: datasetVersionFromResources(resources),
  }
}

function datasetFromResource (client, projectId, resource) {
  const attrs = resource?.attributes ?? resource ?? {}
  const version = attrs.current_version ?? null
  return Dataset.fromExisting(
    client,
    String(attrs.name ?? ''),
    String(attrs.description ?? ''),
    resource?.id ?? attrs.id ?? null,
    projectId,
    [],
    version,
    version
  )
}

// RFC 4180 quoting for a single CSV field (matches Python's csv.writer default dialect).
function csvField (value) {
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function experimentFromResource (client, resource) {
  const id = resource?.id
  return new ExperimentResult(id, [], id == null ? null : `${client.appBase}/llm/experiments/${id}`)
}

class ExperimentsClient {
  #apiKey
  #appKey
  #site
  #projectName
  #timeout
  apiBase
  #cachedProjectId

  constructor ({ apiKey, appKey, site, projectName, timeout = 30_000 } = {}) {
    this.#apiKey = apiKey
    this.#appKey = appKey
    this.#site = site
    this.#projectName = projectName
    this.#timeout = timeout
    this.apiBase = `https://${apiHost(this.#site)}`
    this.#cachedProjectId = null
  }

  // Whether the client has everything it needs to talk to the control plane.
  get configured () {
    return Boolean(this.#apiKey && this.#appKey && this.#site)
  }

  get site () {
    return this.#site
  }

  get projectName () {
    return this.#projectName
  }

  // Dashboard URL base for the configured site, e.g. https://app.datadoghq.com
  get appBase () {
    return `https://${appHost(this.#site)}`
  }

  // Resolve the configured project's id (get-or-create), cached.
  ensureProjectId () {
    return this.getOrCreateProject(this.#projectName)
  }

  // Low-level request. Builds https://api.<site><path>, attaches both keys, and
  // returns the parsed JSON body. Throws with status + body on a non-2xx.
  async request (method, path, body, { contentType, timeout = this.#timeout } = {}) {
    const url = `${this.apiBase}${path}`
    const headers = {
      'DD-API-KEY': this.#apiKey,
      'DD-APPLICATION-KEY': this.#appKey,
    }

    let payload
    if (contentType !== undefined) {
      payload = body
      headers['Content-Type'] = contentType
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeout),
      })
    } catch (err) {
      throw new Error(`${method} ${path} failed: ${err.message}`)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${response.status} ${text}`)
    }
    return text ? JSON.parse(text) : {}
  }

  jsonApiRequest (method, path, type, attributes) {
    return this.request(method, path, {
      data: { type, attributes },
    })
  }

  async createProject (name) {
    const response = await this.jsonApiRequest('POST', `${API_BASE_PATH}/projects`, 'projects', { name })
    return response?.data ?? null
  }

  async createDataset (projectId, attributes) {
    const response = await this.jsonApiRequest('POST', `${API_BASE_PATH}/${projectId}/datasets`, 'datasets', attributes)
    return datasetFromResource(this, projectId, response?.data ?? null)
  }

  deleteDataset (projectId, datasetId) {
    return this.jsonApiRequest('POST', `${API_BASE_PATH}/${projectId}/datasets/delete`, 'datasets', {
      type: 'soft',
      dataset_ids: [datasetId],
    })
  }

  async listDatasets (projectId, options = {}) {
    const query = new URLSearchParams()
    if (options.name !== undefined) query.set('filter[name]', options.name)
    const response = await this.request('GET', `${API_BASE_PATH}/${projectId}/datasets?${query.toString()}`)
    const resources = Array.isArray(response?.data) ? response.data : []
    return resources.map(resource => datasetFromResource(this, projectId, resource))
  }

  async appendDatasetRecords (projectId, datasetId, records) {
    const response = await this.jsonApiRequest(
      'POST',
      `${API_BASE_PATH}/${projectId}/datasets/${datasetId}/records`,
      'datasets',
      { records }
    )
    // The append-records response has used both a top-level `records` array
    // and JSON:API `data` resources. Accept either so generated/custom record
    // ids are preserved for experiment row tagging.
    const resources = Array.isArray(response?.records)
      ? response.records
      : (Array.isArray(response?.data) ? response.data : [])
    return datasetMutationResultFromResources(resources)
  }

  async batchUpdateDatasetRecords (projectId, datasetId, attributes) {
    const response = await this.request(
      'POST',
      `${API_BASE_PATH}/${projectId}/datasets/${datasetId}/batch_update`,
      {
        data: {
          type: 'datasets',
          id: datasetId,
          attributes: {
            insert_records: attributes.insert_records ?? [],
            update_records: attributes.update_records ?? [],
            delete_records: attributes.delete_records ?? [],
            deduplicate: attributes.deduplicate !== false,
            create_new_version: attributes.create_new_version !== false,
          },
        },
      }
    )
    const resources = Array.isArray(response?.records)
      ? response.records
      : (Array.isArray(response?.data) ? response.data : [])
    return datasetMutationResultFromResources(resources)
  }

  async listDatasetRecords (projectId, datasetId, options = {}) {
    const query = new URLSearchParams()
    if (options.cursor) query.set('page[cursor]', options.cursor)
    if (options.version !== undefined && options.version !== null) query.set('filter[version]', String(options.version))
    if (Array.isArray(options.tags)) {
      for (const tag of options.tags) query.append('filter[tags]', tag)
    }
    const response = await this.request(
      'GET',
      `${API_BASE_PATH}/${projectId}/datasets/${datasetId}/records?${query.toString()}`
    )
    const records = Array.isArray(response?.data) ? response.data.map(datasetRecordFromResource) : []
    return { records, after: response?.meta?.after ?? '' }
  }

  async createExperiment (attributes) {
    const response = await this.jsonApiRequest('POST', `${API_BASE_PATH}/experiments`, 'experiments', attributes)
    return experimentFromResource(this, response?.data ?? null)
  }

  postExperimentEvents (experimentId, attributes) {
    return this.jsonApiRequest(
      'POST',
      `${API_BASE_PATH}/experiments/${experimentId}/events`,
      'experiments',
      attributes
    )
  }

  updateExperiment (experimentId, attributes) {
    return this.jsonApiRequest('PATCH', `${API_BASE_PATH}/experiments/${experimentId}`, 'experiments', attributes)
  }

  /**
   * Publish a custom (BYOP) evaluator configuration.
   * @param {Record<string, unknown>} evaluation Payload built by `LLMJudge#buildPublishPayload`.
   * @returns {Promise<void>}
   */
  async publishCustomEvaluator (evaluation) {
    try {
      await this.jsonApiRequest(
        'PUT',
        `${UNSTABLE_API_BASE_PATH}/config/evaluators/custom`,
        'evaluator_config',
        { evaluation }
      )
    } catch (err) {
      throw new Error(`Failed to publish evaluator ${evaluation.eval_name}: ${err.message}`)
    }
  }

  /**
   * Fetch experiment metadata by id.
   * @param {string} experimentId
   * @returns {Promise<{ id: string, attributes: Record<string, unknown> }>}
   */
  async getExperiment (experimentId) {
    let response
    try {
      const path = `${API_BASE_PATH}/experiments?filter[id]=${encodeURIComponent(experimentId)}`
      response = await this.request('GET', path)
    } catch (err) {
      throw new Error(`Failed to get experiment with ID ${experimentId}: ${err.message}`)
    }
    const resources = Array.isArray(response?.data) ? response.data : []
    if (resources.length === 0) throw new Error(`No experiments found for ID ${experimentId}`)
    return { id: String(resources[0].id ?? experimentId), attributes: resources[0].attributes ?? {} }
  }

  /**
   * Fetch the span events (and optionally eval metrics) of a previous experiment run.
   * @param {string} experimentId
   * @param {{ includeEvalMetrics?: boolean }} [options]
   * @returns {Promise<Record<string, unknown>>} Raw JSON:API response.
   */
  async getExperimentEvents (experimentId, { includeEvalMetrics = true } = {}) {
    let path = `${UNSTABLE_API_BASE_PATH}/experiments/${experimentId}/events`
    if (includeEvalMetrics) path += '?include[eval_metrics]=true'
    try {
      return await this.request('GET', path)
    } catch (err) {
      throw new Error(`Failed to get experiment events: ${err.message}`)
    }
  }

  /**
   * List experiments, following `meta.after` cursors. Query encoding matches dd-trace-py.
   * @param {object} [options]
   * @param {string} [options.experimentName]
   * @param {Record<string, unknown>} [options.metadataFilter]
   * @param {string[]} [options.parentExperimentIds]
   * @param {string} [options.projectId]
   * @param {string} [options.datasetId]
   * @param {boolean} [options.isDeleted]
   * @param {number} [options.pageLimit]
   * @param {number} [options.maxResults]
   * @returns {Promise<Array<Record<string, unknown>>>} Raw JSON:API experiment resources.
   */
  async listExperiments ({
    experimentName,
    metadataFilter,
    parentExperimentIds,
    projectId,
    datasetId,
    isDeleted = false,
    pageLimit = 100,
    maxResults,
  } = {}) {
    if (maxResults !== undefined && maxResults !== null && maxResults < 1) {
      throw new Error(`max_results must be at least 1, got ${maxResults}`)
    }
    const limit = Math.max(1, Math.min(pageLimit, 5000))
    const baseParams = [['page[limit]', String(limit)]]
    if (experimentName) baseParams.push(['filter[experiment]', experimentName])
    if (hasEntries(metadataFilter)) {
      baseParams.push(['filter[metadata]', JSON.stringify(metadataFilter)])
    }
    if (Array.isArray(parentExperimentIds)) {
      for (const parentId of parentExperimentIds) baseParams.push(['filter[parent_experiment_id]', parentId])
    }
    if (projectId) baseParams.push(['filter[project_id]', projectId])
    if (datasetId) baseParams.push(['filter[dataset_id]', datasetId])
    if (isDeleted) baseParams.push(['filter[is_deleted]', 'true'])

    const results = []
    let cursor = null
    for (;;) {
      const params = cursor ? [...baseParams, ['page[cursor]', cursor]] : baseParams
      const query = new URLSearchParams(params).toString().replaceAll('%5B', '[').replaceAll('%5D', ']')
      let body
      try {
        // eslint-disable-next-line no-await-in-loop
        body = await this.request('GET', `${API_BASE_PATH}/experiments?${query}`)
      } catch (err) {
        throw new Error(`Failed to list experiments: ${err.message}`)
      }
      const resources = Array.isArray(body?.data) ? body.data : []
      for (const resource of resources) {
        results.push(resource)
        if (maxResults != null && results.length >= maxResults) return results
      }
      cursor = body?.meta?.after
      if (!cursor) break
    }
    return results
  }

  /**
   * Upload dataset records in one multipart CSV request (`input,expected_output,metadata,id`).
   * @param {string} datasetId
   * @param {Array<{ input: unknown, expectedOutput: unknown, metadata: unknown, id: string }>} records
   * @param {boolean} [deduplicate]
   * @returns {Promise<void>}
   */
  async bulkUploadDatasetRecords (datasetId, records, deduplicate = true) {
    let fileContent = 'input,expected_output,metadata,id\r\n'
    for (const record of records) {
      fileContent += csvField(JSON.stringify(record.input ?? '')) + ',' +
        csvField(JSON.stringify(record.expectedOutput ?? '')) + ',' +
        csvField(JSON.stringify(record.metadata ?? '')) + ',' +
        csvField(record.id) + '\r\n'
    }
    const body = `--${BULK_UPLOAD_BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="records.csv"\r\n' +
      'Content-Type: text/csv\r\n' +
      '\r\n' +
      fileContent + '\r\n' +
      `--${BULK_UPLOAD_BOUNDARY}--\r\n`

    const path = `${UNSTABLE_API_BASE_PATH}/datasets/${datasetId}/records/upload?deduplicate=${deduplicate}`
    try {
      await this.request('POST', path, body, {
        contentType: `multipart/form-data; boundary=${BULK_UPLOAD_BOUNDARY}`,
        timeout: BULK_UPLOAD_TIMEOUT,
      })
    } catch (err) {
      throw new Error(`Failed to upload dataset from file: ${err.message}`)
    }
  }

  // Resolve the project id for `name`, creating it if absent. The create
  // endpoint is get-or-create on name, so repeated calls return the same id.
  // Cached after the first resolution.
  async getOrCreateProject (name) {
    if (this.#cachedProjectId) return this.#cachedProjectId

    let response
    try {
      response = await this.createProject(name)
    } catch (err) {
      throw new Error(`Failed to create or get project '${name}': ${err.message}`)
    }

    this.#cachedProjectId = response?.id ?? null
    return this.#cachedProjectId
  }
}

module.exports = { ExperimentsClient, apiHost, appHost, API_BASE_PATH, UNSTABLE_API_BASE_PATH }
