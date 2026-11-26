import { localProgressText } from '@genoffice/ai-provider/local-copy'
import type { LocalModelStartup } from '../../../shared/local-model'
import { useI18n } from '../locale'
import { localChatCopy } from '../i18n/strings-local-chat'
import type { LocalModelOfferState } from './useLocalModelOffer'
import '../star-prompt.css'

/**
 * "Use Local AI now?": shown over Home after a download finished while another provider is saved.
 * After "Use now" the same card follows the model until it is ready. Non-modal, with the look of
 * StarPromptCard; closing the question means "Later", closing the progress only hides it.
 */
export function LocalModelReadyCard({ offer }: { offer: LocalModelOfferState }) {
  const { lang } = useI18n()
  const c = localChatCopy(lang)
  const { startup } = offer
  return (
    <div className="star-prompt" role="dialog" aria-label={startup ? c.title : c.offerTitle}>
      <button
        type="button"
        className="star-prompt-close"
        aria-label={startup ? c.hide : c.offerLater}
        disabled={offer.busy}
        onClick={startup ? offer.dismissStartup : offer.later}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {startup ? <Startup startup={startup} c={c} /> : <Question offer={offer} c={c} />}
    </div>
  )
}

type Copy = ReturnType<typeof localChatCopy>

function Question({ offer, c }: { offer: LocalModelOfferState; c: Copy }) {
  return (
    <>
      <div className="star-prompt-head">
        <h3 className="star-prompt-title">{c.offerTitle}</h3>
      </div>
      <p className="star-prompt-body">{c.offerBody}</p>
      <div className="star-prompt-actions">
        <button
          type="button"
          className="star-prompt-go"
          disabled={offer.busy}
          onClick={offer.useNow}
        >
          {c.offerUse}
        </button>
        <button
          type="button"
          className="star-prompt-done"
          disabled={offer.busy}
          onClick={offer.later}
        >
          {c.offerLater}
        </button>
      </div>
    </>
  )
}

function Startup({ startup, c }: { startup: LocalModelStartup; c: Copy }) {
  if (startup.phase === 'failed')
    return (
      <div role="status">
        {/* a sentence, not a title: keep it clear of the close button */}
        <div className="star-prompt-head" style={{ paddingInlineEnd: 24 }}>
          <h3 className="star-prompt-title">{startup.error}</h3>
        </div>
        <p className="star-prompt-body">{c.startFailed}</p>
      </div>
    )
  if (startup.phase === 'ready' || startup.phase === 'skipped')
    return (
      <div className="star-prompt-head" role="status">
        <h3 className="star-prompt-title">{c.readyToChat}</h3>
      </div>
    )
  return (
    <div role="status" aria-live="polite">
      <div className="star-prompt-head">
        <h3 className="star-prompt-title">{localProgressText(startup, c)}</h3>
      </div>
      {/* a value only while the weights are read into memory, the one step that is measured */}
      <progress
        style={{ width: '100%' }}
        max={100}
        {...(startup.percent === undefined ? {} : { value: startup.percent })}
      />
    </div>
  )
}
