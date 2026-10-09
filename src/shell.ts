const todo = (name: string): never => {
  throw new Error(`not implemented: shell.${name}`)
}

export type Segment = {
  words: string[]
  stdin: string[]
  stdinFile?: string
  stdoutFile?: string
  substitutions: string[]
}
export type Pipeline = Segment[]
export type Command = { words: string[]; env: Record<string, string> }

export const parseShell = (src: string): Pipeline[] => todo('parseShell')
export const unwrap = (words: readonly string[]): Command => todo('unwrap')
export const baseName = (word: string): string => todo('baseName')
