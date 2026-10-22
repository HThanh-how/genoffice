# App actions and preference tools

Home and Docs expose MCP-shaped `app_action({id,args?,teach?})`,
`get_setting({key})` and `set_setting({key,value})` tools. Inputs are validated
in the skill and at the IPC boundary. Selectors, IPC channels, code, paths,
credentials and arbitrary setting keys are never tool inputs.

## Commands and ownership

- Home owns `open-index-screen`, `open-settings` and `new-chat`.
- `open-settings.args.pane` accepts only the six existing Settings section IDs.
- The active, attached Docs tab owns `print` and `export-pdf`. Other document
  families and detached windows are intentionally unsupported. With Home active
  there is no current document; the tool does not guess a background tab.
- Each renderer registers named implementations with label, risk, teach support,
  steps, an optional highlight selector and a run function.

`AppCommandBus` creates a one-use ticket before displaying approval. It binds
the caller, target WebContents, renderer registration generation, tab and file
identity. A changed/closed/navigated target invalidates the ticket. Tab switches
are checked on tab-manager changes, before dispatch and at acknowledgement.
It never re-resolves the current tab after approval.

Execution resolves from an acknowledgement carrying the command ID and sent by
the bound target. Execution times out after 120 seconds; unused approval expires
after five minutes. Late/foreign acknowledgements are ignored. Stop, Escape,
unmount and invalidation release listeners and narration. One outstanding command
per caller and one executing command per renderer are allowed. A timed-out
operation must not be retried automatically.

Home uses `app-action:run`. Docs uses the existing `menu:command` path with a
request envelope. Ordinary menu events still use the existing menu switch;
enveloped requests call the same print/export functions through the registry,
without executing them twice.

## Completion and teaching

`completed` means an observed destination or successful preference write. For
PDF it means the existing export function returned that a file was written.
Print `handoff` means the Docs print dialog mounted, **not** that a printer
finished. Cancelled/failed PDF exports never report a saved file. The existing
export API combines some failure and cancellation returns into `false`; the
tool conservatively reports cancellation in that case.

The renderer owning a target renders its SVG spotlight. Geometry comes from
`getBoundingClientRect()` in that viewport, clipped and padded locally, and is
remeasured on scrolling, resizing and DOM/layout changes. The overlay uses theme
tokens, has `pointer-events: none`, contains no motion, respects reduced-motion
preferences and is excluded from printing. Narration and approval copy are in
every sibling locale shard. Document content and export colors are not themed.

With `teach:true`, the host does not invoke the command: it waits for trusted
user clicks and observed destination DOM, or an existing print/export handler's
completion event. Native menus/dialogs get narration without an invented DOM
rectangle. Escape cancels the guide. Automatic mode paints narration before
running the existing handler.

Abort signals reach the existing Docs print/PDF pipeline. Cancellation while
waiting for content, a pagination preview or PDF chunks prevents the next stage.
An already dispatched native save/print operation cannot be recalled; cancellation
or timeout is not proof its side effect was undone. New chat uses the existing
reset/history path and ends the originating Home chat run.

## Approval and settings

Print, PDF export and every settings write reuse ClarifyCard as explicit
Approve/Deny choices, without preselection or “decide for me”. Denial, skipping,
Stop and invalidation never execute a pending ticket. Reading preferences does
not navigate away from the current screen.

The whitelist is exactly `language`, `theme` and `default-model`. Language
uses supported locale IDs; theme is light/dark/system. Default model selects a
configured choice on the current provider through the existing model-picker
writer, preserving custom endpoint metadata. AGY uses its existing validated
model-selection handler; there is no generic-write fallback. Tests mock that
handler and never launch AGY or an LLM. Other providers use shipped model choices;
custom endpoints use their saved model list. The tool does not discover a live
catalog or switch providers/endpoints.

## Patterns and validation

The design follows [VS Code command IDs](https://github.com/microsoft/vscode/blob/main/src/vs/platform/commands/common/commands.ts),
MCP named tools with JSON schemas, and the driver.js/Shepherd spotlight and step
narration pattern. No runtime dependency is added. ClarifyCard, Settings writers,
model-selection helpers, print and PDF export are reused.

Unit/component tests cover registry validation, approval gating, trusted-event
sequencing, cancellation, renderer routing, ticket ownership, tab/reload races,
timeout/late acknowledgement, settings preservation and viewport geometry.
Native dialog/printer behavior and packaged cross-renderer operation still need
manual verification in a temporary Electron profile. No document-style template
mutation is included; `ai-document-style-template.md` remains design-only.
