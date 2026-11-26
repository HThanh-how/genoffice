import { useSyncExternalStore } from 'react'
import { getStreamStatus, subscribeStreamStatus } from '@genoffice/agent-core'

/** What the model service says it is doing right now, or null when it has not said. */
export function useStreamStatus(): string | null {
  return useSyncExternalStore(subscribeStreamStatus, getStreamStatus, getStreamStatus)
}
