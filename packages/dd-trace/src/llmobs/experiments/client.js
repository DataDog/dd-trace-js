'use strict'

// Control-plane HTTP client for LLM Obs Experiments. Uses the global `fetch`,
// so this module adds no new dependency; credentials and site come from config.

const { Dataset, DatasetRecord } = require('./dataset')
const { ExperimentResult } = require('./result')

const API_BASE_PATH = '/api/v2/llm-obs/v1'

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
  async request (method, path, body) {
    const url = `${this.apiBase}${path}`
    const headers = {
      'DD-API-KEY': this.#apiKey,
      'DD-APPLICATION-KEY': this.#appKey,
    }

    let payload
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.#timeout),
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

module.exports = { ExperimentsClient, apiHost, appHost, API_BASE_PATH }
