# Whole-document style template: design only

Status: item (c) uses the design-note fallback; no new tool or document mutation.

`DEFAULT_DOCUMENT_STYLES` in `packages/docx-engine/src/blank.ts` already defines
heading and title sizes, heading spacing, table margins/borders/header fill,
and code font/size/fill. Reuse it as the first named preset, not a second palette.

Existing building blocks:

- Docs `define_style` / `list_styles` in `renderer/ai/style-ops.ts` update the
  style catalog; `apply_ops` registers `applyStyle` for paragraphs.
- `packages/cli/src/op-catalog.ts` reuses Docs operations; keep any future
  template expansion in that shared operation path rather than a new XML writer.
- `applyStyle` deliberately retains paragraph attributes and inline formatting,
  preserves list numbering, and skips protected content.

Why this is not a cheap complete operation:

- An imported file can use custom style IDs and direct formatting. Updating
  Normal/Heading definitions alone cannot guarantee a whole-document result.
- Applying one style to every block would flatten the heading hierarchy.
  Clearing direct formatting indiscriminately could remove intentional emphasis.
- `define_style` exposes paragraph/run fields, not the full table-style
  margins/borders/header shading represented by the preset.
- Style catalog upserts and editor `apply_ops` transactions have separate
  mutation paths; a new batch needs an explicit rollback/undo contract.

Proposed action: `apply_document_template({ name, scope: "document" })` resolves
only registered presets. First inspect the document and return a preview of the
Normal/title/heading/code/table mapping, affected counts, retained overrides,
and unsupported/protected sections. Ask about ambiguous custom styles instead
of guessing. Explicitly distinguish inherited-style updates from normalization.

Only apply after the catalog and block/table changes can commit and undo as one
operation. Preserve numbering, links, revisions, notes, headers/footers, embedded
objects, and unsupported OOXML. Report skips or retained overrides accurately.
Never regenerate an open document from Markdown to simulate a style change.

Preset colors are authored document data, never chrome theme tokens. Validate
with import/save/reopen fixtures containing custom styles, direct formatting,
tables, lists, protected blocks and revisions; test undo/redo and identical
saved/printed/exported content under light and dark themes.
