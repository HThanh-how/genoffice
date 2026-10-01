import type { ClipboardSuggestApi } from '../clipboard-suggest-api'
import type { ClipboardHistoryApi } from '../clipboard-history-api'
import type { AgyOcrApi } from './agy-ocr'
import type { DocumentIndexApi } from './document-index-api'
import type { HomeChatApi } from './home-chat-types'
import type { IndexingModeApi } from './indexing-mode'

/** Every fork-only method on window.aiOffice; HomeApi extends this so upstream stays untouched. */
export interface ForkHomeApi
  extends
    ClipboardSuggestApi,
    ClipboardHistoryApi,
    HomeChatApi,
    DocumentIndexApi,
    IndexingModeApi,
    AgyOcrApi {}
