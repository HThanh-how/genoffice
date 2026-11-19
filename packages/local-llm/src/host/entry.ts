import { NativeHost } from './runtime'
import type { HostEvent, HostRequest } from '../protocol'

const parent = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage(message: HostEvent): void
      on(event: 'message', listener: (event: { data: HostRequest }) => void): void
    }
  }
).parentPort
const host = new NativeHost(
  (message) => (parent ? parent.postMessage(message) : process.send?.(message)),
  () => process.exit(0),
)
if (parent)
  parent.on('message', ({ data }) => {
    void host.receive(data)
  })
else {
  process.on('message', (message) => {
    void host.receive(message as HostRequest)
  })
  process.on('disconnect', () => {
    void host.receive({ id: 'disconnect', type: 'shutdown' })
  })
}
