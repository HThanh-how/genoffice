import type { ChatLabels } from '../../src/renderer/src/home-chat/ChatMessage'
import { chatString } from '../../src/renderer/src/home-chat/strings'

/** Real Home chat labels for tests, in the given language. */
export const chatLabels = (lang: 'vi' | 'en' = 'en'): ChatLabels => ({
  loading: '…',
  retry: 'retry',
  locale: lang === 'vi' ? 'vi-VN' : 'en-US',
  filesInAnswer: (n) => chatString(lang, 'homeChatFilesInAnswer', { n }),
  relatedFiles: (n) => chatString(lang, 'homeChatRelatedFiles', { n }),
  open: chatString(lang, 'homeChatOpen'),
  openSource: (name) => `open ${name}`,
  showInFolder: chatString(lang, 'homeChatShowInFolder'),
  copyPath: chatString(lang, 'homeChatCopyPath'),
  pathCopied: chatString(lang, 'homeChatPathCopied'),
  fileActions: (name) => chatString(lang, 'homeChatFileActions', { name }),
  searchDetails: chatString(lang, 'homeChatSearchDetails'),
  statusOk: chatString(lang, 'homeChatStatusOk'),
  nameOnly: chatString(lang, 'homeChatNameOnly'),
  sourceMissing: chatString(lang, 'homeChatSourceMissing'),
  sourceStale: chatString(lang, 'homeChatSourceStale'),
  sourceMissingHint: chatString(lang, 'homeChatSourceMissingHint'),
  sourceStaleHint: chatString(lang, 'homeChatSourceStaleHint'),
  sourceSkeleton: chatString(lang, 'homeChatSourceSkeleton'),
  sourceSkeletonHint: chatString(lang, 'homeChatSourceSkeletonHint'),
  copy: 'copy',
  copied: 'copied',
})
