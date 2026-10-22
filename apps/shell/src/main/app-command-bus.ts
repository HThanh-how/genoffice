import { randomUUID } from 'node:crypto'
import type {
  AppActionRequest,
  AppActionResult,
  AppControlInput,
} from '@genoffice/agent-core/app-control'

export interface CommandTarget {
  key: number
  valid(): boolean
  send(request: AppActionRequest): void
  cancel(id: string): void
}
interface Pending {
  owner: number
  target: CommandTarget
  input: AppControlInput
  timer: ReturnType<typeof setTimeout>
  resolve?: (result: AppActionResult) => void
}

/** One promise per command ID. An IPC send is never treated as completion. */
export class AppCommandBus {
  private pending = new Map<string, Pending>()
  constructor(
    private timeoutMs = 120_000,
    private approvalTimeoutMs = 300_000,
  ) {}

  prepare(owner: number, input: AppControlInput, target: CommandTarget): string {
    if (!target.valid()) throw new Error('Target renderer is unavailable')
    if ([...this.pending.values()].some((p) => p.owner === owner))
      throw new Error('An app command is already pending')
    const id = randomUUID()
    const timer = setTimeout(
      () => this.finish(id, { status: 'error', error: 'Approval expired' }),
      this.approvalTimeoutMs,
    )
    this.pending.set(id, { owner, input, target, timer })
    return id
  }

  execute(owner: number, id: string): Promise<AppActionResult> {
    const pending = this.pending.get(id)
    if (!pending || pending.owner !== owner || pending.resolve)
      throw new Error('Unknown or consumed command')
    clearTimeout(pending.timer)
    if (!pending.target.valid()) {
      this.finish(id, { status: 'error', error: 'Target changed before execution' })
      return Promise.resolve({ status: 'error', error: 'Target changed before execution' })
    }
    return new Promise((resolve) => {
      pending.resolve = resolve
      pending.timer = setTimeout(
        () =>
          this.finish(id, {
            status: 'error',
            error: 'Command acknowledgement timed out; completion is unknown',
          }),
        this.timeoutMs,
      )
      try {
        pending.target.send({ requestId: id, input: pending.input })
      } catch {
        this.finish(id, { status: 'error', error: 'Target renderer is unavailable' })
      }
    })
  }

  ack(sender: number, id: string, result: AppActionResult): void {
    const pending = this.pending.get(id)
    if (!pending?.resolve || pending.target.key !== sender) return
    this.finish(
      id,
      pending.target.valid()
        ? result
        : { status: 'error', error: 'Target changed during execution' },
    )
  }
  cancel(owner: number, id: string): void {
    if (this.pending.get(id)?.owner === owner) this.finish(id, { status: 'cancelled' })
  }
  invalidate(sender: number): void {
    for (const [id, p] of this.pending)
      if (p.owner === sender || p.target.key === sender) this.finish(id, { status: 'cancelled' })
  }
  validateTargets(): void {
    for (const [id, p] of this.pending)
      if (!p.target.valid()) this.finish(id, { status: 'error', error: 'Target changed' })
  }
  private finish(id: string, result: AppActionResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (result.status === 'error' || result.status === 'cancelled') pending.target.cancel(id)
    pending.resolve?.(result)
  }
}
