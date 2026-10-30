const target = new URL(import.meta.url).searchParams.get('target')

export function resolve (specifier, context, nextResolve) {
  if (specifier === 'resolver-hook') return { shortCircuit: true, url: target }
  return nextResolve(specifier, context)
}
