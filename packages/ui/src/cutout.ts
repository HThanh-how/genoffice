/**
 * Image cutout (background removal): the pure algorithm lives in @genoffice/electron-utils so the
 * renderer dialogs here and the main-process agy transparency step share one implementation.
 */
export * from '@genoffice/electron-utils/image-cutout-core'
