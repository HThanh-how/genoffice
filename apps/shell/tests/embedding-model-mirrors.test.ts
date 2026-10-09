import { describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import {
  mirrorAssetName,
  mirrorReleaseTag,
  mirrorTemplates,
  modelFileUrl,
  modelSources,
} from '../src/main/document-memory/embedding/model-mirrors'

const base = EMBEDDING_PROFILES.base
const onnx = base.files.find((f) => f.path === 'onnx/model.onnx')!

describe('model mirrors', () => {
  it('lists d2x, the GitHub release asset and Hugging Face (last, canonical) for a mirrorable profile', () => {
    const urls = modelSources(base, onnx, mirrorTemplates(undefined, {})).map((s) => s.url)
    expect(urls).toEqual([
      `https://d2x.clouds.io.vn/models/hotchpotch/bekko-embedding-v1-a8m/${base.revision}/onnx/model.onnx`,
      'https://github.com/HThanh-how/genoffice/releases/download/models-c721113d59-hotchpotch_bekko-embedding-v1-a8m/onnx-model.onnx',
      modelFileUrl(base, onnx),
    ])
    const sources = modelSources(base, onnx, mirrorTemplates(undefined, {}))
    expect(sources.map((s) => s.host)).toEqual(['d2x.clouds.io.vn', 'github.com', 'huggingface.co'])
    expect(sources.map((s) => s.canonical)).toEqual([false, false, true])
  })

  it('only the Bekko profiles are mirrorable; Gemma and the legacy repositories use their origin alone', () => {
    expect(
      Object.values(EMBEDDING_PROFILES)
        .filter((p) => p.mirrorable)
        .map((p) => p.id),
    ).toEqual(['base', 'balanced'])
    for (const id of ['standard', 'high', 'mid', 'plus'] as const) {
      const profile = EMBEDDING_PROFILES[id]
      const sources = modelSources(profile, profile.files[0]!, mirrorTemplates(undefined, {}))
      expect(sources.map((s) => s.url)).toEqual([modelFileUrl(profile, profile.files[0]!)])
    }
  })

  it('GENOFFICE_MODEL_MIRRORS replaces the defaults; an empty value means Hugging Face only', () => {
    const env = {
      GENOFFICE_MODEL_MIRRORS:
        ' https://mirror.example/{repo}/{rev10}/{path} , not-a-url,http://127.0.0.1:9/{asset} ',
    }
    expect(mirrorTemplates(undefined, env)).toEqual([
      'https://mirror.example/{repo}/{rev10}/{path}',
      'http://127.0.0.1:9/{asset}',
    ])
    expect(
      modelSources(base, onnx, mirrorTemplates(undefined, env))
        .map((s) => s.url)
        .slice(0, 2),
    ).toEqual([
      'https://mirror.example/hotchpotch/bekko-embedding-v1-a8m/c721113d59/onnx/model.onnx',
      'http://127.0.0.1:9/onnx-model.onnx',
    ])
    expect(
      modelSources(base, onnx, mirrorTemplates(undefined, { GENOFFICE_MODEL_MIRRORS: '' })).map(
        (s) => s.url,
      ),
    ).toEqual([modelFileUrl(base, onnx)])
  })

  it('names the release tag and flat assets the publish script uses', () => {
    expect(mirrorReleaseTag(base.repo, base.revision)).toBe(
      'models-c721113d59-hotchpotch_bekko-embedding-v1-a8m',
    )
    expect(mirrorAssetName('onnx/model.onnx')).toBe('onnx-model.onnx')
  })
})
