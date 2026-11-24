'use strict'

const { EventEmitter } = require('node:events')
const { Conversation } = require(process.env.SDK_CONVERSATION_PATH)
const socket = new EventEmitter()
socket.readyState = 1
socket.send = () => {}
socket.close = () => socket.emit('close', 1000, Buffer.alloc(0))
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
