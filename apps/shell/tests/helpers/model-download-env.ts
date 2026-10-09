/**
 * Keeps unit tests off the project mirrors and free of real backoff pauses: model downloads go
 * to the one injected source, and retries happen back to back. Tests that cover mirrors or
 * backoff pass explicit options instead.
 */
process.env.GENOFFICE_MODEL_MIRRORS = ''
process.env.GENOFFICE_MODEL_RETRY_DELAYS_MS = '0,0,0'
