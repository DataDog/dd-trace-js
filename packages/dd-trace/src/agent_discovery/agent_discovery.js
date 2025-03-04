// DataDogAgent.js

const format = require('../format')
const log = require('../log')
const request = require('../exporters/common/request')


class DataDogAgentDiscovery {
  /**
   * Holds the single instance of the class.
   * @type {DataDogAgentDiscovery|null}
   */
  static instance = null

  /**
   * Constructs a new DataDogAgent instance.
   * @param {object} config - The tracer config object.
   * @param {number} interval - The fetch interval in milliseconds.
   */
  constructor(config, interval = 30000) {
    if (DataDogAgentDiscovery.instance) {
      // If an instance already exists, return it to enforce singleton
      return DataDogAgentDiscovery.instance
    }

    const { url, hostname, port } = config
    const agent_url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))

    if (!agent_url) {
      throw new Error('Error getting Datadog Agent URL via config object for Datadog Agent Discovery service.')
    }

    this.url = url
    this.interval = interval
    this.data = {}
    this.error = null
    this.timer = null
    this.callbacks = []

    if (config._fetchAgentInfo) {
      this._startFetching()
    }

    // Singleton pattern
    DataDogAgentDiscovery.instance = this
  }

  /**
   * Static method to get the singleton instance.
   * @param {object} config - The tracer config object.
   * @param {number} interval - The fetch interval in milliseconds.
   * @returns {DataDogAgentDiscovery} The singleton instance.
   */
  static getInstance(config, interval) {
    if (!DataDogAgentDiscovery.instance) {
      DataDogAgentDiscovery.instance = new DataDogAgentDiscovery(config, interval)
    }
    return DataDogAgentDiscovery.instance
  }

  /**
   * Registers a callback to be invoked on data or error.
   * @param {function} callback - The callback function with signature (error, data).
   */
  registerCallback(callback) {
    if (typeof callback === 'function') {
      this.callbacks.push(callback)
      callback(this.error, this.data) // also invoke the callback initially so we don't have to wait
    } else {
      throw new TypeError('Agent Discovery callback must be a function')
    }
  }

  /**
   * Unregisters a previously registered callback.
   * @param {function} callback - The callback function to remove.
   */
  unregisterCallback(callback) {
    this.callbacks = this.callbacks.filter(cb => cb !== callback)
  }

  /**
   * Invokes all registered callbacks with the current error and data.
   */
  _invokeCallbacks() {
    this.callbacks.forEach(callback => {
      try {
        callback(this.error, this.data)
      } catch (callbackError) {
        log.error('Error in callback:', callbackError.message)
      }
    })
  }

  /**
   * Starts the periodic fetching of DataDog Agent information.
   */
  _startFetching() {
    // Initial fetch
    this._fetchAgentInfo()

    // Set up interval for periodic fetching
    this.timer = setInterval(() => this._fetchAgentInfo(), this.interval)
  }

  /**
   * Fetches the DataDog Agent information and updates internal state.
   */
  _fetchAgentInfo() {
    const options = {
      url: this.url,
      path: '/info',
      method: 'GET',
      timeout: 5000,
    }

    request(options, (err, res) => {
      if (err) {
        this.error = err
        log.error('Error fetching DataDog Agent info:', err.message)
        this._invokeCallbacks()
        return
      }

      try {
        const parsedData = JSON.parse(res)
        this.data = parsedData
        this.error = null // Reset error on successful fetch
        this._invokeCallbacks()
      } catch (parseError) {
        this.error = parseError
        log.error('Error parsing DataDog Agent Discovery "/info" response:', parseError.message)
        this._invokeCallbacks()
      }
    })
  }

  /**
   * Retrieves the latest fetched DataDog Agent data.
   * @param {function|null} callback - Optional callback to run on returned data.
   * @returns {Object|null} The latest data or null if not available.
   */
  getData(callback) {
    if (callback) {
      callback(this.error, this.data)
    }
    if (this.error) {
      return this.error
    } else {
      return this.data
    }
  }

  /**
   * Stops the periodic fetching.
   */
  stopFetching() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}


module.exports = DataDogAgentDiscovery