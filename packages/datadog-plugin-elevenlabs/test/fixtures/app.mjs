import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
const { Conversation } = await import(pathToFileURL(/** @type {string} */ (process.env.SDK_CONVERSATION_PATH)).href)
class Socket extends EventEmitter {
  readyState = 1
  send () {}
  close () { this.emit('close', 1000, Buffer.alloc(0)) }
}
const socket = new Socket()
const conversation = new Conversation({
  agentId: 'test',
  requiresAuth: false,
  audioInterface: { start () {}, stop () {}, output () {}, interrupt () {} },
  webSocketFactory: { create: () => socket },
})
const started = conversation.startSession()
socket.emit('open')
started.then(() => {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'agent_response',
    agent_response_event: { event_id: 1, agent_response: 'Synthetic' },
  })))
  conversation.endSession()
})
