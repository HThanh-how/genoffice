# App actions: deferred integration

Status: item (b) is deferred; no `app_action` tool is exposed.

## Existing plumbing and blocker

- Docs uses `MenuCommand` in `apps/docs/src/shared/ipc.ts`,
  `sendCommand()` in `apps/docs/src/main/docs-main.ts`, and the
  `onMenuCommand` switch in its renderer `App.tsx`.
- Slides has its own `MenuCommand` and uses `slides:menu`.
- `apps/shell/src/main/tab-document-actions.ts` already routes print to a
  specific tab. It returns `void`; sending a command does not establish that
  the renderer received it, opened a dialog, or completed the operation.
- Home and the document editor live in different WebContents. A selector in
  Home cannot measure or spotlight an editor element. Native menus and native
  print/save dialogs also have no renderer DOM selector.

Adding a Home tool now would require new cross-renderer request/response and
target-lifetime handling. Reusing the active tab implicitly could act on a
different document after a tab switch. A delay cannot prove command completion.
That exceeds a small, safely verifiable menu adapter, so implementation stops here.

## Proposed boundary

Follow named, schema-validated tools as in MCP reference servers: an allowlist,
never model-supplied selectors, JavaScript, IPC channels, or arbitrary commands.
The registry stores `{ id, label, risk, run, highlightSelector, steps }`; labels
and step narration use locale keys. Bind each request to a document tab and
WebContents generation, and abort when the target closes or changes.

- `print`: confirm; reuse the editor's print handler and native print dialog.
- `export-pdf`: confirm; reuse the PDF export handler and native save dialog.
- `open-settings(pane)`: safe; validate pane against the existing settings panes.

Render the token-colored SVG spotlight in the target renderer with
`pointer-events: none`. Use actual `getBoundingClientRect()` viewport geometry;
recompute on scroll/resize and stop if the target disappears. Narration announces
the localized step number, total, and menu path before execution. Native UI needs
an explicit handoff message rather than an invented spotlight rectangle.

Reuse the shared ClarifyCard for explicit confirmation, with no auto-selected
approval. Teach mode only highlights: advance from observed user interaction
and the command handler's acknowledgement, never from synthetic clicks or timers.
Cancellation must remove the overlay, listeners, and pending request.

Before exposing the tool, test the registry allowlist and risk gate, sequencing
and cancellation, viewport clipping geometry, tab-switch races, and acknowledgement
versus actual export/print completion. No registry, sequencing, or geometry code
was added here, so those tests are deferred with the implementation.
