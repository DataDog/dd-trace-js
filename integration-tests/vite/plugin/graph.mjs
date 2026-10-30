import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

const State = Annotation.Root({ step: Annotation({ default: () => 0, reducer: (_, next) => next }) })

export function runGraph () {
  const graph = new StateGraph(State)
    .addNode('one', () => ({ step: 1 }))
    .addEdge(START, 'one')
    .addEdge('one', END)
    .compile()
  return graph.invoke({})
}
