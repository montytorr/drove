import type { Control, Delivery, DeliveryAdapter, Deps, Report, RunMeta, Seat } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: deliver.${name}`)
}

export const RETRY_MS = 3_000
export const BUSY_RETRY_MS = 45_000

export const codexQueueArgv = (thread: string, text: string): string[] => todo('codexQueueArgv')
export const herdrPromptAdapter = (deps: Deps): DeliveryAdapter => todo('herdrPromptAdapter')
export const codexQueueAdapter = (deps: Deps): DeliveryAdapter => todo('codexQueueAdapter')
export const registerAdapter = (adapter: DeliveryAdapter): void => todo('registerAdapter')
export const chooseAdapter = (seat: Seat, adapters: readonly DeliveryAdapter[]): DeliveryAdapter | undefined => todo('chooseAdapter')
export const isDeliverable = async (deps: Deps, seat: Seat): Promise<{ ok: true } | { ok: false; reason: string }> => todo('isDeliverable')
export const deliverControl = async (deps: Deps, run: RunMeta, control: Control): Promise<Delivery> => todo('deliverControl')
export const flushPending = async (deps: Deps, run: RunMeta, seat: string): Promise<Delivery[]> => todo('flushPending')
export const wakePlanner = async (deps: Deps, run: RunMeta, reports: readonly Report[]): Promise<Delivery> => todo('wakePlanner')
