import assert from 'node:assert/strict'

export const assertExports = (module: Record<string, unknown>, names: readonly string[]) => {
  for (const name of names) assert.equal(typeof module[name], 'function', `${name} is exported as a function`)
}

export const assertStub = async (call: () => unknown, name: string) => {
  await assert.rejects(async () => call(), new RegExp(`not implemented: ${name.replace('.', '\\.')}`))
}
