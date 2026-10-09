const todo = (name: string): never => {
  throw new Error(`not implemented: store.${name}`)
}

export type Cursor = { offset: number }

export const readJson = async <T>(path: string): Promise<T | undefined> => todo('readJson')
export const writeJsonAtomic = async (path: string, value: unknown, mode = 0o600): Promise<void> => todo('writeJsonAtomic')
export const withLock = async <T>(lockDir: string, body: () => Promise<T>, staleMs = 10_000): Promise<T> => todo('withLock')
export const appendJsonl = async (path: string, value: unknown): Promise<void> => todo('appendJsonl')
export const readJsonlFrom = async <T>(path: string, cursor: Cursor): Promise<{ items: T[]; cursor: Cursor }> => todo('readJsonlFrom')
export const mintToken = (): string => todo('mintToken')
export const writeToken = async (path: string, token: string): Promise<void> => todo('writeToken')
export const readToken = async (path: string): Promise<string | undefined> => todo('readToken')
