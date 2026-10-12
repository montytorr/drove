import { setImmediate } from 'node:timers/promises'

// Poll an observable condition; the deadline only bounds failures, never decides success.
export const waitFor = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`never reached: ${what}`)
    await setImmediate()
  }
}

export const deferred = () => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
