// Initialize the tracer and channel subscriptions before the rewritten ESM dependency is evaluated.
import testGraph from './orchestrion-assertions.js'
// eslint-disable-next-line import/order
import * as langgraph from '@langchain/langgraph'

testGraph(langgraph)
