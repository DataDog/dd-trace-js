'use strict'

// Follows the work of a test into the worker threads it starts and posts messages to.
//
// A thread that collects lines gives the workers it starts a token, as environment data, and the
// workers that load the tracer collect too. A worker numbers the messages its parent posts to it in
// the order it receives them. The parent numbers them in the order it posts them, which is the same
// order, and remembers who owns the context each one was posted in. The worker handles each message
// in a context of its own, and reports what ran there, under the message's number, on a broadcast
// channel the parent always listens to. What a worker runs outside every message goes to the owner
// of the context that started the worker.
//
// A report is sent before every message the worker posts, on any port, soon after it handles a
// message, and when it exits. The parent takes the reports waiting on the channel before it handles
// a message from any port, and before a worker's 'exit' event. So it has the lines of a message
// before anything that answers the message, and all lines of a worker before anything learns that
// the worker stopped.
//
// When the worker posts while it handles a message, a marker sent just before on the same port
// names that message, and the parent handles the posted message in the context that posted the
// named one.

const { randomUUID } = require('node:crypto')
const workerThreads = require('node:worker_threads')

const shimmer = require('../../../../datadog-shimmer')
const log = require('../../log')

const KEY = 'dd-trace:line-coverage'
// Every event of a message port goes through this method, named with a registry symbol.
const DISPATCH = Symbol.for('nodejs.internal.kHybridDispatch')
// Runs of posted messages kept per worker before the oldest are forgotten.
const COMPACT_AT = 256
const KEEP_RUNS = 128

/**
 * @typedef {import('./collector').Owner} Owner
 * @typedef {Record<string, number[]>} PathLines lines by absolute filename
 * @typedef {{ owned: Array<[Owner, PathLines]>, unowned?: PathLines, init?: PathLines }} Pending
 * @typedef {object} Host what the collecting thread provides
 * @property {() => Owner} resolveOwner the owner of the running context
 * @property {() => Owner} createOwner
 * @property {() => Owner} unowned
 * @property {(owner: Owner, fn: () => unknown) => unknown} runAs runs `fn` in a context that `owner` owns
 * @property {(owner: Owner | undefined, files: PathLines | undefined) => void} receive lines a worker ran
 *   for `owner`, or for no known owner
 * @property {(files: PathLines | undefined) => void} receiveInit initialiser lines a worker ran
 * @property {() => Pending} takePending what ran here since it was last taken
 * @typedef {{ token: string, root: string, channel: string }} Settings what a worker gets from its parent
 * @typedef {{ threadId: number, owned: Array<[number, PathLines]>, unowned?: PathLines, init?: PathLines }} Report
 */

/**
 * The owners of the messages posted to one worker, as runs of consecutive message numbers.
 */
class PostedMessages {
  count = 0

  /** @type {number[]} the number of the first message of each run */
  starts = []

  /** @type {Owner[]} */
  owners = []

  /**
   * @param {Owner} owner the owner of the context the message was posted in
   * @param {Owner} unowned
   */
  add (owner, unowned) {
    const number = ++this.count
    if (this.owners.at(-1) === owner) return
    if (this.owners.length >= COMPACT_AT) this.#compact(unowned)
    this.starts.push(number)
    this.owners.push(owner)
  }

  /**
   * @param {number} number
   * @returns {Owner | undefined}
   */
  ownerOf (number) {
    const { starts } = this
    for (let i = starts.length - 1; i >= 0; i--) {
      if (starts[i] <= number) return this.owners[i]
    }
  }

  /**
   * Closed owners own nothing any more: their runs join the unowned runs around them. When that is
   * not enough, the oldest runs are forgotten, and their messages are owned by nobody.
   *
   * @param {Owner} unowned
   */
  #compact (unowned) {
    const starts = []
    const owners = []
    for (let i = 0; i < this.owners.length; i++) {
      const owner = this.owners[i].open ? this.owners[i] : unowned
      if (owners.at(-1) === owner) continue
      starts.push(this.starts[i])
      owners.push(owner)
    }
    const forget = owners.length >= COMPACT_AT ? owners.length - KEEP_RUNS : 0
    this.starts = starts.slice(forget)
    this.owners = owners.slice(forget)
  }
}

/** @type {Host | undefined} */
let host

/** @type {string | undefined} */
let token

const { receiveMessageOnPort } = workerThreads

let dispatchWrapped = false
let receiveWrapped = false

/** @type {import('node:worker_threads').BroadcastChannel | undefined} where this thread's workers report */
let reports

/** @type {Map<number, PostedMessages>} messages posted to each worker, by thread id */
const postedByThread = new Map()

/** @type {Map<number, Owner>} the owner of the context each worker was started in, by thread id */
const creatorByThread = new Map()

/** @type {WeakMap<object, number>} the thread id of each worker, which it no longer gives once it exits */
const threadIdByWorker = new WeakMap()

/** @type {WeakMap<object, Owner>} the owner of the next message a port receives from its worker */
const replyOwners = new WeakMap()
let pendingReplies = 0

/** @type {import('node:worker_threads').MessagePort | null} in a reporting worker, the port to its parent */
let parentPort = null

/** @type {import('node:worker_threads').BroadcastChannel | undefined} where this worker reports */
let parentReports
let received = 0

/** @type {WeakMap<Owner, number>} the number of the message each owner of this worker handles */
const numberByOwner = new WeakMap()
let sending = false
let reportScheduled = false

function canFollow () {
  return typeof workerThreads.MessagePort?.prototype?.[DISPATCH] === 'function' &&
    typeof workerThreads.setEnvironmentData === 'function' &&
    typeof workerThreads.getEnvironmentData === 'function' &&
    typeof workerThreads.BroadcastChannel === 'function' &&
    typeof receiveMessageOnPort === 'function'
}

/**
 * Makes the worker threads this thread starts from now on report what they run. Does nothing on
 * runtimes whose message ports cannot be followed.
 *
 * @param {Host} collectingHost
 * @param {string} root the directory under which workers instrument modules
 */
function followWorkers (collectingHost, root) {
  if (reports !== undefined || !canFollow()) return
  host = collectingHost
  token ??= randomUUID()
  const channel = `${KEY}:${token}:${workerThreads.threadId}`
  reports = new workerThreads.BroadcastChannel(channel)
  reports.unref?.()
  reports.addEventListener('message', ({ data }) => receiveReport(data))
  wrapDispatch()
  wrapReceive()
  shimmer.wrap(workerThreads.Worker.prototype, 'postMessage', postMessage => function () {
    const result = postMessage.apply(this, arguments)
    recordPost(this)
    return result
  })
  // A stopped worker's last report is on the channel, but its 'exit' event can come first.
  shimmer.wrap(workerThreads.Worker.prototype, 'emit', emit => function (event) {
    if (event === 'exit') {
      takeReports()
      forgetWorker(this)
    }
    return emit.apply(this, arguments)
  })
  // Emitted in the context the worker was started in.
  process.on('worker', recordCreator)
  workerThreads.setEnvironmentData(KEY, { token, root, channel })
}

/**
 * In a worker started by a thread that follows its workers, returns what that thread gave it.
 *
 * @returns {Settings | undefined}
 */
function getParentSettings () {
  if (workerThreads.isMainThread || !canFollow()) return
  const settings = workerThreads.getEnvironmentData(KEY)
  if (typeof settings?.token === 'string' && typeof settings.root === 'string' &&
      typeof settings.channel === 'string') {
    return settings
  }
}

/**
 * Makes this worker run each message of its parent in a context of its own, and report what runs
 * to its parent.
 *
 * @param {Host} collectingHost
 * @param {Settings} settings
 */
function reportToParent (collectingHost, settings) {
  if (parentPort !== null || workerThreads.parentPort === null) return
  host = collectingHost
  token = settings.token
  parentPort = workerThreads.parentPort
  parentReports = new workerThreads.BroadcastChannel(settings.channel)
  parentReports.unref?.()
  wrapDispatch()
  wrapReceive()
  shimmer.wrap(workerThreads.MessagePort.prototype, 'postMessage', postMessage => function () {
    if (sending) return postMessage.apply(this, arguments)
    if (this === parentPort) return postAfterReport(this, postMessage, arguments)
    // A pool's tasks and results can travel on ports of its own, and the pool may terminate the
    // worker as soon as it has the results.
    sendReport()
    return postMessage.apply(this, arguments)
  })
  process.once('exit', () => sendReport())
  // What the worker's main script runs as it loads.
  scheduleReport()
}

function wrapDispatch () {
  if (dispatchWrapped) return
  dispatchWrapped = true
  shimmer.wrap(workerThreads.MessagePort.prototype, DISPATCH, dispatch => function (data, type, event) {
    if (type !== 'message' && type !== 'messageerror') return dispatch.call(this, data, type, event)
    if (type === 'message' && data !== null && typeof data === 'object' && token !== undefined &&
        data[KEY] === token) {
      // A report goes on to the channel's handler; a marker is for this port only.
      if (data.reply === undefined) return dispatch.call(this, data, type, event)
      try {
        receiveMarker(this, data)
      } catch (error) {
        log.debug('Line coverage could not read a marker of a worker: %s', error.message)
      }
      return
    }
    if (this === parentPort) return dispatchFromParent(this, dispatch, data, type, event)
    takeReports()
    if (parentReports !== undefined) scheduleReport()
    if (pendingReplies > 0) {
      const owner = replyOwners.get(this)
      if (owner !== undefined) {
        replyOwners.delete(this)
        pendingReplies--
        return host.runAs(owner, () => dispatch.call(this, data, type, event))
      }
    }
    return dispatch.call(this, data, type, event)
  })
}

function wrapReceive () {
  if (receiveWrapped) return
  receiveWrapped = true
  shimmer.wrap(workerThreads, 'receiveMessageOnPort', receive => function (port) {
    if (port !== reports) takeReports()
    const message = receive.apply(this, arguments)
    // A message taken from the parent's port synchronously still has its number.
    if (port === parentPort && message !== undefined) received++
    return message
  })
}

/**
 * Handles the reports workers sent and this thread has not received yet.
 */
function takeReports () {
  if (reports === undefined) return
  try {
    let message = receiveMessageOnPort(reports)
    while (message !== undefined) {
      receiveReport(message.message)
      message = receiveMessageOnPort(reports)
    }
  } catch (error) {
    log.debug('Line coverage could not read the reports of workers: %s', error.message)
  }
}

/**
 * @param {import('node:worker_threads').Worker} worker
 */
function recordCreator (worker) {
  try {
    const { threadId } = worker
    if (!(threadId > 0)) return
    threadIdByWorker.set(worker, threadId)
    creatorByThread.set(threadId, host.resolveOwner())
  } catch (error) {
    log.debug('Line coverage could not follow a worker: %s', error.message)
  }
}

/**
 * Forgets a worker that exited, once its last reports are handled.
 *
 * @param {object} worker
 */
function forgetWorker (worker) {
  const threadId = threadIdByWorker.get(worker)
  if (threadId === undefined) return
  threadIdByWorker.delete(worker)
  creatorByThread.delete(threadId)
  postedByThread.delete(threadId)
}

/**
 * @param {import('node:worker_threads').Worker} worker
 */
function recordPost (worker) {
  try {
    const { threadId } = worker
    if (!(threadId > 0)) return
    let posted = postedByThread.get(threadId)
    if (posted === undefined) {
      posted = new PostedMessages()
      postedByThread.set(threadId, posted)
    }
    posted.add(host.resolveOwner(), host.unowned())
  } catch (error) {
    log.debug('Line coverage could not follow a message to a worker: %s', error.message)
  }
}

/**
 * @param {Report} report
 */
function receiveReport (report) {
  try {
    const { threadId } = report
    const posted = postedByThread.get(threadId)
    for (const [number, files] of report.owned) host.receive(posted?.ownerOf(number), files)
    host.receive(creatorByThread.get(threadId), report.unowned)
    host.receiveInit(report.init)
  } catch (error) {
    log.debug('Line coverage could not read the report of a worker: %s', error.message)
  }
}

/**
 * @param {object} port the port the worker posts its messages to
 * @param {{ reply: number, threadId: number }} marker `reply` names the message whose context posted
 *   the next message, or is -1 when that message could not be sent
 */
function receiveMarker (port, { reply, threadId }) {
  if (replyOwners.delete(port)) pendingReplies--
  if (reply > 0) {
    replyOwners.set(port, postedByThread.get(threadId)?.ownerOf(reply) ?? host.unowned())
    pendingReplies++
  }
}

/**
 * @param {object} port
 * @param {Function} dispatch
 * @param {unknown} data
 * @param {string} type
 * @param {unknown} event
 */
function dispatchFromParent (port, dispatch, data, type, event) {
  const owner = host.createOwner()
  numberByOwner.set(owner, ++received)
  scheduleReport()
  return host.runAs(owner, () => dispatch.call(port, data, type, event))
}

/**
 * Posts a message of this worker to its parent, after a report of what ran so far and, when it is
 * posted while a message of the parent is handled, a marker naming that message.
 *
 * @param {object} port
 * @param {Function} postMessage
 * @param {IArguments} args
 */
function postAfterReport (port, postMessage, args) {
  sendReport()
  let number = 0
  try {
    number = numberByOwner.get(host.resolveOwner()) ?? 0
    if (number !== 0) sendMarker(number)
  } catch (error) {
    log.debug('Line coverage could not mark a message to the parent thread: %s', error.message)
  }
  try {
    return postMessage.apply(port, args)
  } catch (error) {
    if (number !== 0) sendMarker(-1)
    throw error
  }
}

function scheduleReport () {
  if (reportScheduled) return
  reportScheduled = true
  setImmediate(() => {
    reportScheduled = false
    sendReport()
  }).unref?.()
}

/**
 * Sends the parent what ran here since the last report.
 */
function sendReport () {
  try {
    const pending = host.takePending()
    const owned = []
    for (const [owner, files] of pending.owned) {
      const number = numberByOwner.get(owner)
      if (number !== undefined) owned.push([number, files])
    }
    if (owned.length === 0 && pending.unowned === undefined && pending.init === undefined) return
    // The channel posts through a message port too.
    sending = true
    parentReports?.postMessage({
      [KEY]: token,
      threadId: workerThreads.threadId,
      owned,
      unowned: pending.unowned,
      init: pending.init,
    })
  } catch (error) {
    log.debug('Line coverage could not report to the parent thread: %s', error.message)
  } finally {
    sending = false
  }
}

/**
 * @param {number} reply
 */
function sendMarker (reply) {
  sending = true
  try {
    parentPort?.postMessage({ [KEY]: token, reply, threadId: workerThreads.threadId })
  } finally {
    sending = false
  }
}

module.exports = { followWorkers, getParentSettings, reportToParent }
