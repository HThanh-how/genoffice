/**
 * Placement for the fixed-position folder context menu.
 *
 * The menu opens to the RIGHT of its anchor (pointer x, or the "..." button's
 * right edge) and flips above the anchor when there is no room below. Both
 * axes are clamped to the viewport with a margin, so the menu is never cut off
 * at any edge.
 */

export interface FolderMenuAnchor {
  /** preferred left edge of the menu (viewport coords) */
  x: number
  /** preferred top edge of the menu (viewport coords) */
  y: number
  /** bottom edge of the anchor; used to flip the menu above when it does not fit below */
  above: number
}

export interface FolderMenuSize {
  width: number
  height: number
}

export interface FolderMenuViewport {
  width: number
  height: number
}

export interface FolderMenuPosition {
  left: number
  top: number
}

/** gap kept between the viewport edges and the menu */
export const FOLDER_MENU_MARGIN = 8

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function placeFolderMenu(
  anchor: FolderMenuAnchor,
  menu: FolderMenuSize,
  viewport: FolderMenuViewport,
  margin: number = FOLDER_MENU_MARGIN,
): FolderMenuPosition {
  const left = clamp(anchor.x, margin, viewport.width - menu.width - margin)
  const fitsBelow = anchor.y + menu.height <= viewport.height - margin
  const preferredTop = fitsBelow ? anchor.y : anchor.above - menu.height
  const top = clamp(preferredTop, margin, viewport.height - menu.height - margin)
  return { left, top }
}
