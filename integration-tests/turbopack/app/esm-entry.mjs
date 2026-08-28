import { generateText } from 'ai'
import model from './model.js'

export async function run () {
  const result = await generateText({
    model,
    prompt: 'Say ok',
    experimental_telemetry: { isEnabled: true },
  })
  return { dependency: typeof generateText === 'function' ? 'ai' : 'missing', text: result.text }
}
