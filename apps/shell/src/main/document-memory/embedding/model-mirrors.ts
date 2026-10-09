import type { EmbeddingProfile, EmbeddingProfileFile } from '../embedding-profiles'

/**
 * Where a model file can be fetched from, best first. The mirrors are the project's own copies of
 * the pinned files; Hugging Face stays last as the canonical origin. Every source is untrusted:
 * only the sha256 and byte size of the manifest decide whether the bytes are accepted.
 *
 * Template placeholders: {repo} {revision} {path} plus the derived forms {rev10} (first 10 chars
 * of the revision), {repoSlug} (repo with "/" as "_") and {asset} (path with "/" as "-", the flat
 * name a GitHub release asset needs).
 */
export const DEFAULT_MIRROR_TEMPLATES: readonly string[] = [
  'https://d2x.clouds.io.vn/models/{repo}/{revision}/{path}',
  'https://github.com/HThanh-how/genoffice/releases/download/models-{rev10}-{repoSlug}/{asset}',
]

/** Comma-separated template list; an empty value disables the mirrors (Hugging Face only). */
export const MODEL_MIRRORS_ENV = 'GENOFFICE_MODEL_MIRRORS'

export interface ModelSource {
  url: string
  /** host name only: safe to show in status text and logs */
  host: string
  /** the original origin (Hugging Face), as opposed to a mirror */
  canonical: boolean
}

export function modelFileUrl(profile: EmbeddingProfile, file: EmbeddingProfileFile): string {
  return `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${file.path}`
}

/** Tag of the GitHub release that holds the files of one pinned revision. */
export function mirrorReleaseTag(repo: string, revision: string): string {
  return `models-${revision.slice(0, 10)}-${repo.replaceAll('/', '_')}`
}

/** Flat asset name of a manifest path inside that release. */
export function mirrorAssetName(path: string): string {
  return path.replaceAll('/', '-')
}

function expand(
  template: string,
  profile: Pick<EmbeddingProfile, 'repo' | 'revision'>,
  file: EmbeddingProfileFile,
): string {
  const segments = (value: string) => value.split('/').map(encodeURIComponent).join('/')
  const values: Record<string, string> = {
    repo: segments(profile.repo),
    revision: profile.revision,
    path: segments(file.path),
    rev10: profile.revision.slice(0, 10),
    repoSlug: encodeURIComponent(profile.repo.replaceAll('/', '_')),
    asset: encodeURIComponent(mirrorAssetName(file.path)),
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** Templates from the argument, else the environment, else the built-in defaults. */
export function mirrorTemplates(
  override?: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw =
    override ??
    (env[MODEL_MIRRORS_ENV] === undefined
      ? DEFAULT_MIRROR_TEMPLATES
      : env[MODEL_MIRRORS_ENV]!.split(','))
  return raw.map((template) => template.trim()).filter((template) => /^https?:\/\//.test(template))
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown host'
  }
}

/** Ordered, de-duplicated sources of one file. Profiles that are not mirrorable only get the origin. */
export function modelSources(
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
  templates?: readonly string[],
): ModelSource[] {
  const origin = modelFileUrl(profile, file)
  const urls = profile.mirrorable
    ? mirrorTemplates(templates).map((t) => expand(t, profile, file))
    : []
  return [...new Set([...urls.filter((url) => url !== origin), origin])].map((url) => ({
    url,
    host: hostOf(url),
    canonical: url === origin,
  }))
}
