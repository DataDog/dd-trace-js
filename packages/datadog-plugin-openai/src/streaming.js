function addStreamedChunk (content, chunk) {
  content.usage = chunk.usage // add usage if it was specified to be returned
  for (const choice of chunk.choices) {
    const choiceIdx = choice.index
    const oldChoice = content.choices.find(choice => choice?.index === choiceIdx)
    if (!oldChoice) {
      // we don't know which choices arrive in which order
      content.choices[choiceIdx] = choice
    } else {
      if (!oldChoice.finish_reason) {
        oldChoice.finish_reason = choice.finish_reason
      }

      // delta exists on chat completions
      const delta = choice.delta

      if (delta) {
        const content = delta.content
        if (content) {
          if (oldChoice.delta.content) { // we don't want to append to undefined
            oldChoice.delta.content += content
          } else {
            oldChoice.delta.content = content
          }
        }
      } else {
        const text = choice.text
        if (text) {
          if (oldChoice.text) {
            oldChoice.text += text
          } else {
            oldChoice.text = text
          }
        }
      }

      // tools only exist on chat completions
      const tools = delta && choice.delta.tool_calls

      if (tools) {
        oldChoice.delta.tool_calls = tools.map((newTool, toolIdx) => {
          const oldTool = oldChoice.delta.tool_calls?.[toolIdx]

          if (oldTool) {
            oldTool.function.arguments += newTool.function.arguments
          } else {
            return newTool
          }

          return oldTool
        })
      }
    }
  }
}

function convertBuffersToObjects (chunks = []) {
  return Buffer
    .concat(chunks) // combine the buffers
    .toString() // stringify
    .split(/(?=data:)/) // split on "data:"
    .map(chunk => chunk.split('\n').join('')) // remove newlines
    .map(chunk => chunk.substring(6)) // remove 'data: ' from the front
    .slice(0, -1) // remove the last [DONE] message
    .map(JSON.parse) // parse all of the returned objects
}

module.exports = {
  addStreamedChunk,
  convertBuffersToObjects
}
