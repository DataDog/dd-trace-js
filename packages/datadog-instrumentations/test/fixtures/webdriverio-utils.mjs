const testFrameworkFnWrapper = async function (type, spec) {
  return spec(type)
}

export { testFrameworkFnWrapper }
