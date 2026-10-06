import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DocumentMemoryStore } from '../store'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from '../embedding-profiles'

export interface EmbeddingCoordinatorOptions {
  store: DocumentMemoryStore
  settingsPath: string
  initialProfileId?: EmbeddingProfileId
}

export class EmbeddingCoordinator {
  private profileId: EmbeddingProfileId
  private profile: EmbeddingProfile

  constructor(private readonly options: EmbeddingCoordinatorOptions) {
    this.profileId = options.initialProfileId ?? DEFAULT_EMBEDDING_PROFILE
    this.profile = EMBEDDING_PROFILES[this.profileId]
    this.options.store.ensureEmbeddingSpace(this.profile)
  }

  get currentProfile(): EmbeddingProfile {
    return this.profile
  }

  get currentProfileId(): EmbeddingProfileId {
    return this.profileId
  }

  getEmbeddingSettings(): {
    profile: EmbeddingProfileId
    available: EmbeddingProfile[]
  } {
    return {
      profile: this.profileId,
      available: Object.values(EMBEDDING_PROFILES),
    }
  }

  setEmbeddingProfile(nextId: EmbeddingProfileId): {
    changed: boolean
    requeued: number
  } {
    if (nextId === this.profileId || !(nextId in EMBEDDING_PROFILES)) {
      return { changed: false, requeued: 0 }
    }
    this.profileId = nextId
    this.profile = EMBEDDING_PROFILES[nextId]
    this.options.store.ensureEmbeddingSpace(this.profile)

    try {
      mkdirSync(dirname(this.options.settingsPath), { recursive: true })
      writeFileSync(
        this.options.settingsPath,
        JSON.stringify({ profile: nextId }),
        'utf8',
      )
    } catch {
      // ignore
    }

    const requeued = this.options.store.requeueForEmbeddingModel(this.profile.embeddingId)
    return { changed: true, requeued }
  }
}
