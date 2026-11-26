import { followLocalModel } from '@genoffice/electron-utils/local-chat'
import type { AiStreamChunk } from '@genoffice/ai-provider'

/** The window a followed line is sent to (an Electron WebContents). */
interface NoticeWindow {
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

/** requests that ended with "the model is not there yet" and whose status line is still live */
const followed = new Map<string, () => void>()

/**
 * The request is over, but its status line stays true: keep sending that one line, updated in
 * place, until the model is ready or has failed. A standalone editor has nothing to follow.
 */
export function followLocalNotice(
  sender: NoticeWindow,
  requestId: string,
  send: (chunk: AiStreamChunk) => void,
  follow = followLocalModel,
): void {
  let ended = false
  const stop = () => {
    unfollow?.()
    end()
  }
  const end = () => {
    ended = true
    followed.delete(requestId)
    sender.removeListener('destroyed', stop)
  }
  const unfollow = follow(({ text, end: last }) => {
    if (last === 'failed') send({ requestId, type: 'error', error: text })
    else send({ requestId, type: 'status', text })
    if (last === 'ready') send({ requestId, type: 'done' })
    if (last) end()
  })
  // a model that was ready already has ended the line before `follow` returned
  if (!unfollow || ended) return
  followed.set(requestId, stop)
  sender.once('destroyed', stop)
}

/** Stops following `requestId`; true when it was a followed line, whose request is long over. */
export function stopLocalNotice(requestId: string): boolean {
  const stop = followed.get(requestId)
  stop?.()
  return stop !== undefined
}
