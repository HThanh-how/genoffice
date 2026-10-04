# Index list views (0.11.92)

The Todo list can be sorted by processing order, natural file name, folder, file type,
progress, issue status or source connectivity, in either direction. Grouping is independent:
issue, folder, file type or a flat list. These controls change the view, not the processing queue.
The app remembers the choices locally.

Folder groups combine files across issue categories. Group selection stays within that group;
Shift selection follows the order of visible rows across expanded groups. Large groups remain
paginated: coverage and load-more controls explain which files have been loaded. Sorting operates
on those loaded files, rather than silently claiming to order the entire database.

Offline source files are dimmed and explicitly labelled. Their details, cached progress, selection
and copy-path actions remain available. Starting a local/OCR read and opening the original file
are disabled until the source returns. Existing work can still be cancelled. Explicitly stopped
files are also dimmed and retain their retry action.

Source availability is checked per registered folder, using the most specific root when roots
overlap. UI waits are bounded and an OS lookup that is still pending is reused rather than
duplicated. Disconnected child shares cannot be pruned because their parent folder was scanned
successfully. A failed UI status request itself does not declare files deleted/offline.

Validation includes sorting/grouping/source-boundary tests, actual DOM tests for selection across
groups and offline actions, network timeout/reconnect tests, dark/light and narrow browser checks,
persisted view preferences, type checking, lint and the production Shell build.
