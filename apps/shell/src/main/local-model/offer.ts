import { LFM_MANIFEST } from '@genoffice/local-llm/manifest'

/**
 * "Use Local AI now?" lifecycle: pure rules over the `localModelOffer` object persisted in
 * userData/app-settings.json.
 *
 * The offer is created by a download that just finished and by nothing else, so a model that was
 * already on disk never produces one. It stays open across restarts until it is answered, and one
 * answer is final for that model revision, even if the file is deleted and downloaded again.
 */

export const LOCAL_MODEL_OFFER_KEY = 'localModelOffer'

/** A new pinned revision is a new model: it may be offered once again. */
export const LOCAL_MODEL_REVISION = `${LFM_MANIFEST.id}@${LFM_MANIFEST.revision}`

export interface LocalModelOffer {
  model: string
  answered: boolean
}

/** tolerate missing/corrupt settings values; an offer about another revision counts as none */
export function asLocalModelOffer(
  value: unknown,
  model = LOCAL_MODEL_REVISION,
): LocalModelOffer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  return raw.model === model ? { model, answered: raw.answered === true } : undefined
}

/** a download finished while another provider was saved; an answer already given stands */
export function withDownloaded(
  offer: LocalModelOffer | undefined,
  model = LOCAL_MODEL_REVISION,
): LocalModelOffer {
  return offer ?? { model, answered: false }
}

/** "Use now", "Later", or Local chosen elsewhere while the offer was open */
export function withAnswered(model = LOCAL_MODEL_REVISION): LocalModelOffer {
  return { model, answered: true }
}

/** the file is gone, so an open question about it is too; an answer is remembered */
export function withDeleted(offer: LocalModelOffer | undefined): LocalModelOffer | undefined {
  return offer?.answered ? offer : undefined
}
