# Automatic Mindmap Layouting

## Status

Draft specification for the ExcalidrawAutomate script. This document describes
the implemented workbench (floating UI, parsing, indicators, backups, and the
integrated nikogenia v1 layout algorithm) and the contracts that further
algorithms, persistence, and evaluation code must satisfy.

## 1. Goal and Scope

The script automatically lays out an existing Excalidraw mindmap. It must
discover a tree from existing node and line elements, represent it as a
`TreeEdgeGraph`, run one of the layout algorithms from the linked `core` folder,
and write the resulting node positions and edge lines back to the drawing.

The project is the practical TypeScript implementation of the research project
**Automatisierte Zeichnung von Mindmaps**. The long-term objective is a
combined layout approach that remains readable for many differently shaped
elements while using a bounded drawing area efficiently. The first release is
an interactive workbench: users configure the map, inspect graph metrics, and
control layout execution step by step.

This script operates on the current Excalidraw view and existing elements. It
does not create a mindmap from Markdown and it must not change unrelated canvas
elements.

## 2. Repository Structure

```text
src/scripts/automatic-mindmap-layouting/
  main.ts                         Executable Script Engine bootstrap
  ui.ts                           Main modal, Border Settings, UI actions
  session.ts                      View binding, hook server, listeners, teardown
  indicators.ts                   Indicator model, sync, selection mapping
  scene.ts                        Transaction queue and scene write helpers
  groups.ts                       Logical element (group/bound text) resolution
  metadata.ts                     Metadata defaults, validation, shape rule
  parser.ts                       Line parser (pure traversal), graph name, metadata hydration
  edges.ts                        Line <-> anchored edge geometry
  layout.ts                       Writes a graph back to the canvas, reparse check
  algorithm.ts                    Algorithm options, parameter table, Start/Reset setup
  runner.ts                       Time-sliced layout run (start, stop, continue, step)
  textfit.ts                      Fit Selected Text Widths helper
  dom.ts                          DOM builders for the modals
  backup.ts                       Vault backups and rollback
  preview.svg                     Script preview asset
  README.md                       Script-facing documentation
  spec.md                         This implementation specification
  core/                            Symbolic link to the research engine
    graph/types.ts                TreeNode (incl. fixed), TreeEdge, TreeGraph
    graph/TreeEdgeGraph.ts        TreeGraph subclass with movable edge anchors
    graph/shapes.ts               Shape geometry (ray casting, anchor clamping)
    graph/evaluation.ts           Graph metrics and formatted metrics string
    graph/evaluationEdge.ts       Metrics measured on anchored edges
    graph/generators.ts            Reproducible test graphs
    algorithms/types.ts           LayoutAlgorithm contract
    algorithms/nikogenia/         NikogeniaAlgorithmV1 and RadialAlgorithmArea (used)
    algorithms/...                 Random, radial, Eades, Fruchterman-Reingold,
                                   Harel-Koren, and Tunkelang implementations
```

`main.ts` remains a thin entrypoint. UI controllers, parsing, metadata,
workbench/indicator operations, backup handling, and algorithm orchestration
belong in import-safe modules beside `main.ts`. Executable `main.ts` must not be
imported by automated tests.

## 3. Runtime and API Rules

- Open the primary interface immediately with `new ea.FloatingModal(ea.plugin.app)`.
  Configure `onOpen` and `onClose` directly; do not subclass `FloatingModal`.
- Use `ea.obsidian.Modal` for confirmation dialogs, including rollback
  confirmation. Never use browser `alert`, `confirm`, or `prompt`.
- Treat scene elements as immutable. For a persistent edit, call
  `ea.clear()`, copy the required elements with
  `ea.copyViewElementsToEAforEditing(...)`, modify the workbench copies, and
  commit one transaction with `await ea.addElementsToView(false, false)`.
- Copy elements into the workbench **immediately** before the edit, re-read by
  ID from the current scene (`scene.ts: saveMetadata`). Copying a snapshot taken
  earlier (for example when the user clicked "Use Selected") writes the old
  geometry back and silently reverts moves made in the meantime.
- All workbench transactions run through one `TransactionQueue`
  (`session.run(...)`). The EA workbench is shared state; an `ea.clear()` from a
  second transaction while the first awaits `addElementsToView` drops elements.
- UI metadata changes and temporary indicator transactions pass `save = false`.
  This does **not** keep them out of the file: `save = false` only marks the
  view dirty and the plugin autosave (default every 60 s on desktop, 30 s on
  mobile) writes the whole scene, indicators included (see 3.2.3). The only
  explicitly save-enabled transaction is the save immediately before creating a
  backup.
- Undo capture: workbench-owned changes (indicators, metadata) use
  `captureUpdate: "NEVER"` so Ctrl+Z neither resurrects indicators nor silently
  removes root/border flags behind the runtime state. Content moves caused by
  dragging an indicator and Fit Selected Text Widths use `"IMMEDIATELY"` and are
  undoable like a native edit. Layout writes (Start, Step, Reset) use `"NEVER"`;
  their undo is Rollback.
- Merge metadata with `ea.addAppendUpdateCustomData(id, patch)` so plugin or
  user metadata is preserved. A patch value of `undefined` removes the key.
- Temporary indicators are scene elements only while the main modal is open.
  Every temporary element is marked with `isMindmapTemporary: true` and is
  deleted when the session ends (section 11). Leftovers from a session that
  could not clean up are deleted by the next session's first sync.
- Use the current view's document/window for DOM work. External listeners,
  timers, and subscriptions are owned by the `WorkbenchSession` and released in
  its teardown; the session additionally registers its teardown with
  `ea.registerCleanup` as a last resort.

### 3.1 Group handling

EA represents a group as several individual elements. Group members share one
or more `groupIds`; there is no single scene element containing the group's
geometry. The script therefore treats a group as one logical node:

1. Reject a selection when `ea.getMaximumGroups(selection)` contains more than
  one maximum group. A selection containing one element or one complete group
  is unambiguous.
2. Resolve the full group with
  `ea.getElementsInTheSameGroupWithElement(anchor, scene)` and calculate its
  bounds with `ea.getBoundingBox(elements)`.
3. Use `ea.getLargestElement(elements)` as the stable anchor. Persist only that
  anchor ID in border/root metadata; resolve the current group members again
  whenever an indicator or node representation is rendered.
4. `ea.getCommonGroupForElements(selection)` may be used as an additional
  common-group check, but the selection must still be validated against the
  current scene because group membership can change after metadata is saved.

The anchor represents the group's node geometry while the full member list is
used for bounds and later movement. Group layout must move or update all group
members together and must preserve their IDs and unrelated metadata.

Container-bound text (`text.containerId`) needs special handling because it is
linked by `containerId`, not by `groupIds`:

- `ea.getViewSelectedElements()` adds the bound text of every selected
  container, and `getMaximumGroups` treats an ungrouped bound text as a group
  of its own. A plain labelled rectangle therefore used to be rejected as an
  "ambiguous" selection. `normalizeBoundText` folds bound text into its
  container (and maps a lone selected label to its container) before grouping.
- `getElementsInTheSameGroupWithElement(container)` does not return the bound
  text of an ungrouped container. `LogicalElement.elements` adds it explicitly,
  so moving a logical element moves its label too.
- Bound text is never an anchor and never a parser candidate.

### 3.2 Obsidian and Excalidraw plugin runtime model

Findings from the Obsidian 1.14.5 and 1.15.0 app bundles and the Excalidraw plugin 2.27.3
bundle (`main.js`). They explain the close, save, and rollback behavior and
must be rechecked when either is upgraded.

#### 3.2.1 Script EA instances

The Script Engine creates one EA per script run, bound to the active view
(`ea.targetView`) and registered in `scriptEngine.eaInstances`. The instance
outlives `main()`: the floating modal keeps using it. It is destroyed by
`scriptEngine.removeViewEAs(view)` when its view closes; `destroy()` runs the
`registerCleanup` callbacks first and then clears its state (`targetView`,
`plugin`, ...). Code that continues after the view closed must not touch `ea`
any more; the workbench captures `app`, `file`, `leaf`, the imperative API, and
`ea.obsidian.Notice` up front.

#### 3.2.2 View close order

Obsidian's `WorkspaceLeaf.open` awaits the old view's `View.close()` (it skips
the await only for two built-in view classes that `ExcalidrawView`, a
`TextFileView`, is not), which is
`containerEl.detach(); this.unload(); await this.onClose()`:

1. `Component.unload()` sets `_loaded = false` **first**, unloads children and
   events, then calls `ExcalidrawView.onunload()`. That calls
   `getHookServer().onViewUnloadHook(view)` synchronously. The React editor is
   still mounted at this point.
2. `ExcalidrawView.onClose()` calls `forceSaveIfRequired()` (the final save),
   unmounts the React root, and only then calls `removeViewEAs(view)`, which
   destroys the script EA and runs its `registerCleanup` callbacks.
3. **The final save is not written yet when `close()` resolves.** While
   `semaphores.viewunload` is set, `performSave` captures the file content and
   schedules `window.setTimeout(() => vault.modify(file, data), 200)`. This
   happens whenever the view is dirty at close, and removing the indicators
   makes it dirty.

Consequences:

- `registerCleanup` runs after the final save, so it can never keep indicators
  out of the file.
- Inside `onViewUnloadHook`, every EA view method guarded by
  `targetView._loaded` (`getExcalidrawAPI`, `getViewElements`,
  `deleteViewElements`, `addElementsToView`, ...) fails and logs
  **"targetView not set"**. The imperative API captured at startup still works,
  and `api.updateScene` applies synchronously, so a removal there is part of
  the scene that `forceSaveIfRequired` saves next.
- Anything that writes the file right after closing its view is overwritten
  about 200 ms later by the old view's content (section 10).

#### 3.2.3 Saving

`addElementsToView(..., save)` ends in `save ? await view.save(false) :
view.setDirty()`. With autosave enabled, a dirty view is saved on the next
autosave tick, on `onUnloadFile` (switching files in the same tab), and on
close. `forceSaveIfRequired` compares the current scene version with the last
saved one, so removing indicators that were never saved does not trigger an
extra save.

The plugin's BAK cache (`getImageCache().addBAKToCache`, in IndexedDB) stores the
last saved file content, but it is read only when loading a drawing fails or
yields an empty scene, and then only after a prompt. It does not reapply changes
to a drawing that loads normally, and clearing it would not affect rollback.

#### 3.2.4 Hook server

Hooks (`onViewUnloadHook`, `onSceneChangeHook`, `onLinkClickHook`, `onDropHook`,
...) are only read from the view's *hook server*: `view.getHookServer()`
returns `view.hookServer ?? plugin.ea` (= `window.ExcalidrawAutomate`).
Assigning `ea.onViewUnloadHook` on the script's EA has no effect until the
script calls `ea.registerThisAsViewEA()`. The view keeps one hook server, so a
registered script shadows hooks set on `window.ExcalidrawAutomate` (for example
by a startup script) for that view. `deregisterThisAsViewEA()` in 2.27.x calls
`setHookServer(this)` again instead of resetting it; the session therefore
resets with the view's own `setHookServer()` (no argument = plugin EA) when that
method exists. Sidepanel EAs additionally receive `onSceneChangeHook`.

#### 3.2.5 External file modification

`FileManager.modifyEventHandler` reacts to a vault `modify` of a file that is
open in an Excalidraw view:

- If the view's `lastSaveTimestamp` is older than five minutes, it fully
  reloads the view from disk.
- Otherwise it calls `view.synchronizeWithData(...)`, a **merge**: an incoming
  element replaces the live one only if its `version` is higher (or equal with
  different content); live elements missing from the file are kept; live
  tombstones stay deleted. If the view is dirty afterwards, it autosaves the
  merged scene immediately.

A backup is always older than the live scene, so restoring it into an open view
loses this merge on every element that changed since the backup. This is why
the original rollback recovered nodes "only sometimes" and lost position
changes, and why the merged autosave then overwrote the restored file.
Rollback must close every view of the file before writing it (section 10).

#### 3.2.6 Imperative API events

`ea.getExcalidrawAPI()` exposes `onChange`, `onPointerDown`, `onPointerUp`
(each returns an unsubscribe function), `selectElements`, `refreshAllArrows`,
`updateScene({ elements, captureUpdate })`, `getSceneElementsIncludingDeleted`,
and `isDestroyed`. These do not depend on the hook server and are the
workbench's scene-change source. `onChange` fires for every app-state change
(selection, scroll, zoom, every pointer move during a drag), so the session
debounces it, ignores it while the pointer is down, and compares a cheap scene
version (element count + sum of element versions) before doing any work.

## 4. Persistent Metadata Contract

Metadata is stored on the relevant persistent element using merged
`customData`. IDs are always Excalidraw element IDs.

### Border Element

```ts
{
  isMindmapBorder: true,
  mindmapPadding: {
    top: number,
    left: number,
    bottom: number,
    right: number
  }
}
```

Padding values are integers in `[-120, 120]`. A new border starts with
`DEFAULT_PADDING` (top `90`, left `100`, bottom `110`, right `100`), and a
malformed persisted side falls back to its default. On startup, scan the current scene
for `isMindmapBorder === true`, load the element and valid padding into runtime
state, and silently continue without a preview if none exists. If multiple
elements are marked, the first match in scene order is used. Removing the
other border flags with a warning (as is done for roots) is not implemented yet.

### Root element

```ts
{
  isMindmapRoot: true,
  mindmapShape: "ellipse" | "rectangle",
  mindmapConnectionDistance: number,           // Parsing Connection Distance
  mindmapRenderingConnectionDistance?: number, // Rendering Connection Distance
  mindmapChildren: string[],
  mindmapAlgorithmSettings?: {      // stored mindmap parameters (section 5.2)
    algorithm: "nikogenia1",
    stepsPerRender: number,         // 1..1000, 1001 = Finished
    parameters: Record<string, number | boolean>
  }
}
```

`mindmapConnectionDistance` (shown as **Parsing Connection Distance**; the key
keeps its old name for existing drawings) is an integer in `[1, 300]`. The
default is `20`, also for a malformed persisted value. Elsewhere in this spec,
"Connection Distance" on its own means the Parsing Connection Distance.

`mindmapRenderingConnectionDistance` is an integer in `[0, 50]`. The default is
`15`, also for a missing or malformed value. It is the gap that written lines
keep from nodes without a visible outline (section 7.2).

`mindmapAlgorithmSettings` holds the mindmap parameters saved with **Save
Mindmap Parameters**: the algorithm, Steps Per Render, and every parameter of
the parameter table (primary, advanced, and Reset parameters). Reset Before
Start and the open state of Advanced Parameters are workbench state and are not
stored. `algorithm.ts: readStoredSettings` validates the value: an unknown
algorithm, missing or malformed values fall back to the defaults, numbers are
clamped to the parameter ranges and rounded to the step (the core helper
`parseParameterValue(parameter, value, true)`, ranges from the core tables, see
5.2), and unknown keys are ignored. A value of the wrong JSON type (for example
the string `"7"` for a number) counts as malformed. Selecting another root moves the stored parameters to it unless the new
root already has its own. Clear All Metadata removes them; Clear Mindmap keeps
them.
`mindmapShape` is the normalized `TreeNode.shape` value. The UI may label the
rectangle option `rect`, but graph data must use `rectangle`, matching the core
types and evaluation functions.

The effective shape of any anchor is `metadata.ts: shapeOf(element)`: persisted
`mindmapShape` wins; otherwise `ellipse` elements are ellipses and every other
element type is a rectangle. Parser, indicators, root selection, and hydration
all use this one rule. (`normalizeShape` must only be applied to persisted or UI
values: it maps unknown inputs such as `"diamond"` to `ellipse`.)

### Node elements

```ts
{
  isMindmapNode: true,
  mindmapShape: "ellipse" | "rectangle",
  mindmapParent: string,
  mindmapChildren?: string[]
}
```

The root is also a node and has `mindmapParent` omitted. Parsing may update
existing mindmap metadata, but must preserve unrelated `customData` keys.

### Edge elements

Each line or arrow that draws a parsed edge carries:

```ts
{
  isMindmapEdge: true,
  mindmapEdge: {
    parentId: string,           // parent anchor ID
    childId: string,            // child anchor ID, equal to the core's edge ID
    parentEnd: "start" | "end", // which line end attaches to the parent
    parentOffset: { x, y },     // anchor relative to the parent center
    childOffset: { x, y },      // anchor relative to the child center
    parentGap: number,          // line end to parent outline (negative: inside), 0 after a write
    childGap: number            // line end to child outline (negative: inside), 0 after a write
  }
}
```

The metadata lives on the line because the line is the element it describes:
deleting the line removes the binding, and undo restores it. Node elements store
no line IDs. `readEdgeMetadata` validates the value; malformed metadata counts as
no binding.

### Fixed elements

```ts
{
  isMindmapFixed: true
}
```

Stored on the anchor of a logical element (element or group) that layout
algorithms must not move (`TreeNode.fixed` in the core, for example a logo that
reserves its corner). Other nodes are still repelled by it and must not overlap
it. The element may be a parsed tree node (it keeps its parent and children) or
any other element (it becomes an isolated node without parent edge). Lines,
arrows, and the border cannot be fixed; a stale flag on them is ignored.
`isFixedFlagged` reads the flag. Clear Mindmap keeps it, Clear All Metadata
removes it. Selecting a root writes the flag on the new root (section 5.1).

## 5. Primary Floating Modal

The main modal title is **Automatic Mindmap Layouting**. It is opened as soon
as the script runs. If no element is selected, the script still opens the UI;
selection-dependent actions explain their missing selection in the UI and do
not mutate the scene.

**Selections through indicators.** Indicators lie on top of their content, so
a click usually selects the indicator. Every selection-driven action (Use
Selected Element/Group, Select Root Element/Group, Apply Shape To Selection,
Fix/Unfix Selection, Fit Selected Text Widths) first maps selected indicators
to their owner via
`customData.mindmapIndicatorOwner` (`resolveIndicatorOwners`) and folds bound
text into its container. Selecting an indicator is therefore equivalent to
selecting its node; selecting both the node and its indicator is not
ambiguous.

**Notices.** Each user action reports its result with an Obsidian notice, shown
for 8 s (`NOTICE_MS`; the reparse warning 12 s, `WARNING_NOTICE_MS`) so that it
can be read while working on the canvas: root saved and fixed, graph copied to
the clipboard, border saved, parse result (node and edge counts), shape applied, elements
fixed or unfixed, text widths fitted (narrowed / already minimal / skipped),
metadata cleared, backup created (file name), layout run started, continued,
stopped (with the step), or completed, initial layout applied, mindmap
parameters saved or restored, algorithm defaults restored, backup restored
(file name), backups deleted (count), a warning when a written layout would
not parse back to the same tree (section 7.2), and every failed precondition
or error. Restarting the script while a workbench is open, or
opening another file in its tab, also shows a notice. Continuous input (sliders)
and automatic refreshes stay silent.

The modal is rendered from runtime state. A scene change re-renders it only
when border/root/graph presence or the number of fixed elements changed (for
example the root was deleted or restored with undo); otherwise only the graph
statistics text is updated, so sliders are not rebuilt while the user drags
them. While Start, Step, or Reset owns the scene (`busy`, section 7.3), every
control of Mindmap Data, Step, Reset, Rollback, and Clear Backups is disabled;
the algorithm controls stay enabled and apply to the next run (Steps Per Render
applies immediately).

### 5.1 Mindmap Data

#### Border

- Show the current Border Element's type and ID, or `Not Configured`.
- Provide **Configure Border**, opening a second floating modal titled
  **Border Settings**.
- Border Settings shows the current candidate's type and ID and allows the
  user to choose a new Border Element from the current canvas selection. A
  selection must be unambiguous; otherwise the prior border remains unchanged.
- Provide four numeric controls: Top, Left, Bottom, and Right Padding. Each
  control has a synchronized range slider and number field, constrained to
  `-120..120`.
- Update the border preview live while either slider or text field changes.
  **Save** writes the border flag and padding metadata in one persistent scene
  transaction. **Cancel** discards both element and padding changes.
- Border Settings displays exactly one logical candidate: the current Border
  anchor or `Not Configured`. **Use Selected Element/Group** replaces it only
  when the current selection resolves to one logical element/group. An
  ambiguous selection shows a notice and leaves the candidate unchanged.
- Selecting a valid new candidate refreshes the preview immediately. Padding
  changes use a short debounce so rapid slider input does not start one EA scene
  transaction per input event.
- The preview is a red dashed rectangle at the padded Border bounds. Negative
  padding expands the bounds and positive padding contracts them according to
  the named side. No-Border startup is silent and has no preview.

#### Root and Parser Settings

- Show the configured Root Element's type and ID. If absent, show **Select Root
  Element/Group**.
- Root selection uses the current canvas selection (indicators mapped to their
  owners) and must be unambiguous.
- An ambiguous Root selection shows a notice and does not mutate metadata.
- The Root's shape is `shapeOf(anchor)` of the group's largest element, so an
  existing `mindmapShape` (for example one set with Apply Shape) is kept.
  Persist the normalized shape with the Root metadata.
- Selecting a Root also marks it as fixed (`isMindmapFixed: true`, in the same
  transaction as the root flags). The core no longer keeps the root in place by
  itself (the former `fixRoot`/"Fix Root" setting is removed, see section 7), so
  without the flag Start and Reset would move it. The user can release it with
  **Unfix Selection**; that choice is kept until a root is selected again
  (selecting the same root again fixes it again). The fixed flag of a previous
  root is left untouched: it cannot be told apart from a flag the user set, so
  an old root stays fixed until it is unfixed by hand.
- Selecting or saving a Root immediately starts automatic parsing from that
  Root.
- Show a shape dropdown (`ellipse` / `rect`) and **Apply Shape To Selection**. The
  action resolves the selection (content or indicators) to logical anchors and
  updates those already marked `isMindmapNode` (the root included), both in
  metadata and in their temporary indicators.
- Show **Fixed Nodes: N** with **Fix Selection** and **Unfix Selection**. Both
  resolve every selected element (content or indicator) to its logical element,
  so several elements and groups can be fixed at once. Fix writes
  `isMindmapFixed` on the anchors; Unfix removes the flag from every member of
  the selected logical elements. The border and lines are rejected with a notice.
  Fixed elements get an orange indicator (section 9) and are loaded into the
  graph (section 7). No root, border, or parse is needed to fix an element.
- A `0.5em` spacer separates the Fix/Unfix row from **Fit Selected Text
  Widths**, like the other control groups of Mindmap Data.
- Provide **Fit Selected Text Widths**: every selected free-standing text element
  (not container-bound text, whose width follows its container) is narrowed to
  the minimum width that keeps its line breaks, in one undoable transaction:
  - Excalidraw re-wraps `originalText` at the element width whenever a
    fixed-width text (`autoResize: false`) is edited or refreshed. The lower
    bound is the widest current line (`ExcalidrawLib.measureText` with the
    element's font string and line height). Greedy wrapping at any width between
    that line and the old width yields the same lines, so the measured width
    normally fits immediately.
  - Each candidate width (rounded up, then up to 4 px more) is verified with
    Excalidraw's own `ExcalidrawLib.wrapText(originalText, font, width) ===
    text`. A text whose lines cannot be reproduced (for example an old manual
    wrap inside a word) is skipped and keeps its width.
  - Centered and right-aligned text is shifted by half or all of the removed
    width, so the lines stay where they are. Auto-resizing text is already
    minimal and stays unchanged.
- Show Graph Statistics after parsing or successful startup graph loading, using
  `calculateTreeEdgeGraphMetricsString(graph)`. Statistics follow moved and deleted
  content (the graph is re-hydrated after every scene change).
- Provide a **Parsing Connection Distance** input (formerly Connection
  Distance) with slider and number field, constrained to `1..300`, defaulting
  to `20`. Save it in Root metadata and use it during line-endpoint matching.
- Below it, provide a **Rendering Connection Distance** input with slider and
  number field, constrained to `0..50`, defaulting to `15`, saved in Root
  metadata (`mindmapRenderingConnectionDistance`) in the same way. Write-backs
  use it as the gap between line ends and nodes without a visible outline
  (section 7.2). Selecting a root writes both values to the root.
- Slider and number input changes of both distances use the same short
  debounce as Border Settings (one timer per setting) and must not rebuild the
  modal while the control is being dragged.
- Below Parse Mindmap, provide **Export And Copy To Clipboard**
  (`exportGraphToClipboard`): copies `graph.serialize()` of the current graph,
  the same JSON that Parse Mindmap logs to the console (nodes with positions,
  sizes, shapes, and `fixed` flags, anchored edges with offsets, graph name), to
  the clipboard through the view window's `navigator.clipboard`, for example to
  add the map to the research repository's `examples`. It exports the hydrated
  graph (metadata plus the live scene, section 7), or the run's live graph while
  a run owns the scene; no parse is needed. Disabled without a graph. A notice
  reports the graph name, node count, and size; a clipboard failure is reported
  as an error.
- Provide **Parse Mindmap** to discard the current parsed graph and parse again
  from the configured Root. Parsing needs a Root and a Border (the Border
  defines the graph coordinate space); a missing one is reported with a notice.
- Provide **Clear Mindmap** to remove all Mindmap Node and Edge metadata from the
  current scene and discard the current parsed graph. This action does not remove
  the Border or Root flags, but it does remove node flags, parent/children
  metadata, and edge metadata while preserving normalized shape metadata. Ask for
  confirmation in an Obsidian modal before clearing.
- Provide **Clear All Metadata** to remove all Mindmap metadata from the current
  scene, including Border and Root flags, and reset padding and Connection
  Distance to their defaults. Ask for confirmation in an Obsidian modal before
  clearing.

### 5.2 Algorithm

- An algorithm dropdown with the single option **Default (nikogenia v1)**
  (`ALGORITHM_OPTIONS` in `algorithm.ts`, value `nikogenia1`). More algorithms
  are added there.
- **Steps Per Render**: slider and number field, `1..1000`, default `50`. The
  slider's last position means **Finished**: the run renders only once, when it
  completes (or is stopped); the number field is then empty and shows
  `Finished` as placeholder. A changed value applies to a running run at its next
  slice.
- Always visible below: **Gap Constant** and **Max Anchor Offset Ratio**.
- Collapsed **Advanced Parameters** (`<details>`, open state kept across
  re-renders): every other parameter of `NikogeniaAlgorithmV1`, then the three
  Reset parameters of `RadialAlgorithmArea` (level gap, area exponent, and
  **Radial Randomize Order (Reset)**, `randomizeOrder`, default on). With
  random order every Reset tries a different arrangement of the branches, instead
  of the same start layout up to rotation. On average it is worse than the
  mindmap order, but a few Resets can find a better start (measurements in the
  research `spec.md`, RadialAlgorithmArea). Rollback undoes an unwanted Reset.
  The default comes from the core class, so stored mindmap parameters without
  the key now get random order; drawings saved with the toggle off keep it off. Sliders
  come first and checkboxes last; within each group the order of the core
  table is kept.
- **Parameter source.** All parameter controls come from the core parameter tables
  `NIKOGENIA1_PARAMETERS` (`NikogeniaAlgorithm1.ts`) and `RADIAL_AREA_PARAMETERS`
  (`RadialAlgorithmArea.ts`). These tables are the single source of truth shared
  with the research web UI. They hold the label, a short description, and min, max,
  and step; the format is in `core/algorithms/parameters.ts`, see the research
  `spec.md`. `algorithm.ts` only decides what is shown where:
  - `PRIMARY_KEYS`: the always visible parameters.
  - `HIDDEN_KEYS`: `borderPadding`, always `1` (section 7.1). `keepInitialLayout`
    is not part of the core table (Start/Reset decide it, section 7.3).
  - `RESET_KEYS`: `initialRotations` and `fitToCanvas` get the label suffix
    `(Reset)`. The radial parameters are labelled `Radial … (Reset)`.

  Select parameters would be skipped (Nikogenia has none). Defaults are still read
  from fresh core instances, so they follow core changes. A new core parameter
  appears in Advanced Parameters automatically, for example `longRangeStrength`
  (Long Range Strength) and `lockEscape` (Lock Escape) were added this way.
  Before, the script kept its own copy of the parameter table with the ranges of
  `Nikogenia1Sim.ts`.
- **Tooltips.** Every parameter row (slider row or checkbox label) has a `title`
  with the core description and the core default
  (`algorithm.ts: parameterTooltipText`, core `parameterTooltip`). Example: "Weak
  repulsion c · g² / gap between all node pairs. Pushes crowded clusters outwards
  into empty canvas areas (0 = off). Default: 0.3." `dom.ts: addRangePair` takes
  `tooltip` in its options; `addCheckbox` is unchanged (the lint limit of four
  parameters), and the title is set on the returned checkbox's label.
- **New core defaults (long-range repulsion 0.3, lock escape 0.9).** Mindmap
  parameters stored before these parameters existed lack both keys, so
  `readStoredSettings` fills in the new defaults. Start on such a drawing
  therefore uses both techniques too. Set them to 0 and save to get the
  previous behavior. Details and measurements: research `nikogenia1.md` § 6.5
  and § 8.
- The initiation mode is not selectable: Reset always uses the radial area
  weighted layout, Start always uses none (the current layout).
- Below the parameters, always visible:
  - **Restore Algorithm Defaults** sets algorithm, Steps Per Render, and all
    parameters to the core defaults (not to the stored mindmap parameters).
  - **Restore Mindmap Parameters** loads the parameters stored on the root
    (`mindmapAlgorithmSettings`, section 4). Enabled only when parameters are
    stored and differ from the current settings.
  - **Save Mindmap Parameters** stores the current settings on the root. Enabled
    only when a root exists and the current settings differ from the stored ones
    (or nothing is stored). It writes only the root's metadata (`"NEVER"`, not
    saved), so a stopped run stays resumable.
- On startup the workbench uses the stored mindmap parameters when the root has
  them, otherwise the core defaults. Changes are workbench-only until saved.
  Changing an algorithm parameter (also by a restore) discards a stopped run, so
  the next Start uses the new values; Steps Per Render does not.
- Both buttons and the Start label (section 5.3) update on every setting change
  and after every refresh without rebuilding the modal (`ui.ts: updateControls`).
  The stored parameters are re-read from the root on every hydration, so undo
  and redo of a save are reflected.

### 5.3 Control

**Start**, **Step**, **Reset** in the first row, **Rollback** and **Clear
Backups** in the second, a **Reset Before Start** checkbox below, then the run
statistics. Semantics in detail: section 7.3.

- **Start** runs nikogenia v1 directly on the current layout (initiation mode
  `none`) until it completes or is stopped, rendering after every Steps Per
  Render steps. While it runs, the button is **Stop** (like the research web
  UI). After Stop, it is **Resume** as long as the stopped run can be continued
  (section 7.3: not completed, drawing unchanged, parameters unchanged, Reset
  Before Start unchecked). As soon as anything changes that would make Start
  begin a new run, the label returns to **Start**.
- **Step** performs one algorithm step of the stopped run, or of a new run on the
  current layout, and renders it.
- **Reset** applies the initial layout (radial area weighted, rotated and fitted
  to the border area) and discards a stopped run.
- **Reset Before Start**: when checked, every Start first applies Reset and then
  runs on the new initial layout (one backup for both).
- Start, Step, and Reset create a backup before they change anything (section
  10). They are disabled without a parsed graph with at least one non-root node.
- **Rollback** opens the rollback dialog (section 10): it shows the newest
  backup's file name and creation date and time, and offers **Restore**,
  **Choose Previous Backup** (enabled when an older backup exists), and
  **Cancel**. The workbench ends with the closed view; the user starts the
  script again on the reopened drawing.
- **Clear Backups** asks `Delete all N backups of this drawing?` and removes them.
  If the backup folder is empty afterward, the folder is removed as well.

Run statistics replace the earlier placeholders and update after every render:

```text
Current Step / Total Steps: 120 / 600 (layout | legalization)
Milliseconds Per Step: Now 1.2 | Min 0.8 | Average 1.1 | Max 3.4
Status: Running | Gap 31.4 | Step Length 2.10 | Max Move 0.85 | Anchor Repairs 3
```

The status is `Idle`, `Preparing...`, `Running`, `Stopped at step i / n`,
`Paused at step i / n` (after Step), `Completed`, `Initial layout applied`, or
`Failed`. The Graph Statistics of section 5.1 show the run's live graph while it
runs.

The modal content uses the current view's document, a compact `0.9em` base
font, flex column layout, consistent gaps and margins, and a smaller credit
line. The repository link in the credit line is a clickable link.

At the bottom, show exactly:

> Nikolas Beyer | W-Seminar Informatik 2027 (Bodensee-Gymnasium Lindau) |
> [BOGYLI/simulierte-wirklichkeit](https://github.com/BOGYLI/simulierte-wirklichkeit/tree/nikolas/projects/nikolas)

## 6. Mindmap Parsing

Parsing is breadth-first and uses a queue plus a read pointer. Existing
Mindmap metadata on node elements shall be cleared while unrelated `customData`
and any existing `mindmapShape` are preserved, to ensure a clean starting state.
The Root is
inserted first; nodes are never removed from the queue. For each queued node:

1. Inspect line/arrow elements whose start or end is within the configured
  Connection Distance of the node boundary **and** has the node as its nearest
  eligible element (the same nearest search as step 3). The start is checked
  first; the end that passes is the parent end. The configured Border Element
  and every member of its group are excluded from candidates.
  The nearest-owner condition is new. Before, the first queued node with an
  end within reach claimed the line, even if the end lay directly on another
  node's boundary. In packed layouts (gaps between nodes below the Connection
  Distance) this attached a node's child to a neighbour processed earlier, or
  took the child end of a short edge for the parent end, so the line resolved
  back to the already queued parent and the edge was lost. If the node itself
  is no eligible element (an unusual root), the old reach-only rule applies.
2. For nodes whose effective shape (`shapeOf`) is ellipse, use the ellipse
   boundary geometry rather than only an axis-aligned rectangle. A shape set
   with Apply Shape therefore also changes connection matching.
3. Resolve the opposite line endpoint to the nearest eligible canvas element.
   Distances within `TIE_EPSILON` (1e-6 px) count as equal. Ties are broken by
   the depth inside a rectangle (`insideDepth`: distance to its nearest side),
   smaller first, then by scene order. Every point inside a rectangle has
   distance 0, so before this tie-break a line end inside several overlapping
   boxes went to the first box in scene order. That happened after layouts in
   which a node's box covers a whole edge (node-edge overlap): both ends of the
   line lay inside the covering box, and no position along the line could win
   the tie. Now an end on its node's outline (depth 0) beats any box that only
   contains it. A single deep end inside one node still has distance 0 and
   is unaffected. The epsilon absorbs rounding: an end computed on an outline
   lies up to about 1e-14 px off it.
   Eligible elements (logical anchors that are not lines, arrows, or bound
   text) are resolved once per parse, not once per line.
4. Ignore the candidate if it is the current node, already queued, or would
   introduce a loop. A loop must not abort parsing of other branches.
   Already queued elements stay **in** the nearest-candidate search and are
   rejected afterwards. Excluding them from the search (the earlier behavior)
   made the line back to a node's own parent resolve to the next-nearest
   unrelated element near the parent, which was then wrongly attached as a
   child; a container's own bound label could be attached the same way.
5. Mark a newly accepted element as a node, infer `ellipse` or `rectangle`
   (but only if no shape data is already present in customData),
   store parent/children metadata, and append its ID to the parent's
   `mindmapChildren` array.
6. Add a `TreeNode` containing ID, center position, normalized shape, width,
   height, parent ID, and children IDs to the `TreeEdgeGraph`, which creates the
   node's parent edge.
7. Bind the line that produced the node to this edge (section 7.2) and store
   `mindmapEdge` on it. Lines that were tracked before and no longer draw an edge
   lose their edge metadata. A second line between the same two nodes is not
   tracked.
8. Add a temporary node indicator and a temporary small arrow toward its
   parent.

Continue until the queue pointer reaches its end and no new lines produce
nodes. Steps 1 to 4 are the pure function `traverseLines(root, candidates,
lines, connectionDistance)` on plain geometry (targets with ID, bounds, and
effective shape; lines as end points). `parseMindmap` collects the inputs from
the scene (`parseScene`, `nodeCandidates`, `parseLines`), and the layout
write-back runs the same function on the geometry it is about to write
(section 7.2). Both must keep using this one function, otherwise the reparse
check stops predicting the parser. Parsing must be deterministic: stable scene order and distance tie
breaks are preferred. It must never convert a line into a node or select a
temporary indicator as a candidate.

## 7. Graph and Algorithm Integration

Construct `TreeEdgeGraph(name, rootId, width, height, 0.5)` using the padded border as
the available layout area. Use the root and every parsed node as `TreeNode`
instances; preserve actual element dimensions because mixed shapes are a core
research requirement. Positions are `p5.Vector` centers as required by the
core.

**Graph name** (`parser.ts: mindmapName`, used by parsing and hydration): the
drawing's file name without `.md` (`TFile.basename`; Excalidraw drawings in
this vault are plain `.md` files such as `M12.1 Test.md`). If the name starts
with a short code, the graph is called `Mindmap <code>`. A short code is one or
more letters (upper or lower case) immediately followed by a digit, then any
further letters, digits, and dots, up to the first whitespace or the end of the
name (`SHORT_CODE = /^(\p{L}+\d[\p{L}\p{N}.]*)(?=\s|$)/u`). Examples:
`M12.1 Test` and `M12.1 Stammfunktion, Produkt- und Kettenregel` →
`Mindmap M12.1`; `M12 Jahrgangsstufe 12` → `Mindmap M12`; `M12.1b Test` →
`Mindmap M12.1b`; `m12a` → `Mindmap m12a`; `Ph10.4 Optik` → `Mindmap Ph10.4`;
`Test2 xyz` → `Mindmap Test2`. No code (the file name is kept): `Mathe Mindmap`
(no digit after the letters), `12 Test` (no letter first), `MM 12` (whitespace
before the digit), `M12.1, Test` and `Inf11.2.3_notes` (another character before
the first whitespace). An empty name falls back to `Mindmap`. The first version
required a dot (`M12` was no code) and stopped at any non-letter/digit/dot
character; this was relaxed. The name appears in the console export and the
clipboard export, matching the research repository's example
`example-m12_1.json` ("Mindmap M12.1").

When a configured root and border are present, the graph is reconstructed
from persisted `mindmapChildren` and `mindmapParent` metadata in breadth-first,
parent-first order. This is a read-only hydration path: it does not discover
new connections or rewrite metadata. Root selection and the explicit Parse
Mindmap action remain the only operations that run the line-based parser.

Metadata is the single source of truth for the parsed structure. Hydration
runs on startup, after every parse or metadata change, and after every
debounced scene change; the resulting node list (IDs, parent IDs, shapes) feeds
the indicators and the graph feeds the metrics. The runtime never keeps
`LogicalElement` snapshots across scene changes (the earlier `parsedNodes`
snapshot froze bounds at parse time, so indicators and metrics did not follow
moved content). A node whose content was deleted is skipped, which also drops
its subtree from the graph until the content is restored (for example with
undo) or the map is parsed again; the parent's `mindmapChildren` metadata is
left untouched for that reason.

Fixed elements are loaded after the tree (`parser.ts: resolveFixedElements`,
`addFixedNodes`): a flagged tree node gets `fixed: true` (`graph.setFixed`), any
other flagged logical element is added as an isolated `TreeNode` with
`fixed: true`, no `parentId`, and therefore no edge, using the same center,
shape (`shapeOf`), and size rules as parsed nodes. Members of the border and
lines are skipped. `ParsedMindmap.fixedIds` lists them for the indicators;
without root and border, hydration still resolves them for the indicators.
Isolated fixed nodes count in the graph statistics (node count, overlaps).
`parseMindmap` adds them the same way before it logs the serialized graph, so
the console export contains the `fixed` flags and the isolated fixed nodes
(previously it skipped them and returned empty `fixedIds`). The core no longer
fixes the root implicitly (the former "Fix Root" setting is gone); the
workbench therefore fixes the root when it is selected (section 5.1), and the
user can unfix it.

### 7.1 Core interaction contract

The core is a mutable graph model. The parser must add nodes in parent-first
order:

1. Create the graph with the root ID and the available width and height.
2. Add the root node first.
3. Add each child only after its parent has been added.

`TreeGraph.addNode(node)` stores the node in `graph.nodes`. If `node.parentId`
is set and the parent is already present, it also appends the child ID to the
parent's `children` array. It does not resolve a parent added later, reject
duplicate child IDs, or clone the node. Parser-created nodes should therefore
start with an empty `children` array; the graph builds the parent-to-child
links as nodes are added. `TreeGraph.getChildren`, `getParent`,
`getNeighbors`, `getRoot`, `getAllNodes`, and `getEdges` read this same graph
state. `getCenter()` returns a new `p5.Vector(width / 2, height / 2)`.

Each `TreeNode` must contain an ID, a mutable `p5.Vector` center position, a
shape, and an empty or already-established children array. `parentId` is
omitted only for the root. `width` and `height` are optional in the type but
must be supplied for parsed ellipse and rectangle elements so the evaluation
and rendering code can account for their actual dimensions. The core accepts
the shape strings `point`, `circle`, `rectangle`, and `ellipse`; the parser's
normalized persistent values remain `rectangle` and `ellipse` for the first
UI slice.

The selected implementation must satisfy `LayoutAlgorithm`:

```ts
initialize(graph): void
step(dt): boolean
isCompleted(): boolean
getGraph(): TreeGraph
```

The reference simulation uses the following interaction sequence:

1. Create a fresh `TreeGraph` with the requested drawing dimensions.
2. Create or select an algorithm instance and configure its public parameters.
3. Optionally initialize a separate algorithm on the same graph to provide an
  initial layout, then initialize the selected algorithm with that graph.
4. Render from `algorithm.getGraph()`.
5. For each render, call `algorithm.step(dt)` up to the configured batch size,
  stopping early when `algorithm.isCompleted()` becomes true.
6. Render the graph returned by `getGraph()` and update the UI metrics.

`getGraph()` returns the algorithm's live graph, not a snapshot. Algorithm
steps mutate the `TreeNode.pos` vectors in that graph, so the adapter reads
positions after each step and maps them to the corresponding Excalidraw IDs.
It must preserve element shape, dimensions, metadata, and IDs while applying
only the position change.

`step(dt)` returns `true` while the algorithm has not completed and `false`
after the step that reaches completion, matching the current
`LayoutAlgorithm` documentation. Callers should still check
`isCompleted()` before starting another step. `dt` is supplied by the caller;
the p5 example passes `p.deltaTime`, but our algorithms currently
does not use it. An adapter must not invent time scaling, the parameter can be omitted
(`NikogeniaAlgorithmV1.step()` declares no parameter at all).

The UI's steps-per-render value is only an outer loop around `step(dt)`. It
must not change the algorithm's iteration count or other algorithm semantics.
For our algorithms, `iterations` is the completion limit and `currentIteration` is
incremented once per `step` call; every node except the fixed ones is moved (the
root only stays in place if it is fixed, which root selection does by default,
section 5.1), and positive `borderPadding` clamps positions to the graph bounds,
in this use case it should be always set to `1` cause padding is already applied to the graph dimensions.

Initialization and reset are not universally interchangeable. The current
`Algorithm.initialize(graph)` assigns the graph but does not reset
`currentIteration`. Reset behavior must therefore create a fresh algorithm
instance or explicitly reset the concrete algorithm's run state before
calling `initialize`. Do not assume that `initialize` resets parameters,
positions, or progress unless the selected implementation documents that
behavior.

The default algorithm is `NikogeniaAlgorithmV1` ("Default (nikogenia v1)").
`algorithm.ts` creates a fresh instance for every run and copies all workbench
parameters onto it before `initialize`, so no run state leaks between runs. It
must not be presented as universally best; other core algorithms can be added to
`ALGORITHM_OPTIONS`.

### 7.2 TreeEdgeGraph and edge lines

The script uses `TreeEdgeGraph` exclusively. It extends `TreeGraph`, so everything
in 7.1 still applies, and is accepted by every `LayoutAlgorithm` (only
`NikogeniaAlgorithmV1` moves anchors; the others leave them where they are). The
graph holds one `AnchoredTreeEdge` per non-root node, keyed by child ID and
created by `addNode`. Its `parentOffset` and `childOffset` are relative to the
node centers. Offsets are always written through `graph.setOffset`, which projects
them into the anchor region (the node shape scaled by `maxOffsetRatio`, here
`0.5`). Conceptually an edge runs anchor to anchor below opaque nodes, so its
visible part starts at the node boundaries.

`ParsedMindmap.edges` (`Map<childId, EdgeBinding>`) links each edge to its line.
`edges.ts` converts in both directions:

**Line to edge (`bindLineToEdge`, while parsing).** The line is modelled by its
chord. Each anchor is the point on the chord's extension closest to the node
center, so a line aiming at the center has offset 0 and an off-center line keeps
its position. The gap is the signed distance between the drawn line end and the
node's visible outline (`outlineExit`, below) along the anchor-to-anchor
direction. It is stored in `mindmapEdge` for information only; the write-back
no longer reproduces it.

**Edge to line (`edgeEndpoints`, after a layout).** With `u` the unit direction
from anchor `a` to anchor `b`:

```text
parent end = a + u * (outlineExit(parent, parentOffset,  u) + parentGap)
child end  = b - u * (outlineExit(child,  childOffset,  -u) + childGap)
```

The write-back uses the preferred gaps of `layout.ts: restGaps`, per end:

- **Node with a visible outline: `OUTLINE_GAP` = 1 px** outside the outline. A
  tiny gap outside reads better than a line tip poking into the node (rounding,
  stroke width).
- **Node without a visible outline: the Rendering Connection Distance**
  (default 15 px) outside the node box, so lines do not run right up to a plain
  text.

A node has a visible outline (`ParsedMindmap.outlinedIds`, `parser.ts:
hasVisibleOutline`) if its anchor is an Excalidraw `rectangle` (node shape
rectangle) or `ellipse` (node shape ellipse) that fills the node's logical
bounds within 1 px and shows a stroke (non-transparent stroke colour, stroke
width > 0) or a fill, with opacity > 0. Texts, images, transparent shapes,
shapes that do not match the node shape (also diamonds), and groups with content
outside the shape count as without outline; their node box is the bounding box
(or the ellipse inscribed in it for ellipse nodes).

Positive gaps shrink when they would leave less than half of the free space
between the two outlines visible (`edges.ts: fitGaps`), so close nodes still get
a short line instead of none. `outlineExit` (`edges.ts`) is the ray cast from an
inner point to the outline Excalidraw draws:

- **Ellipse and sharp rectangle:** the core's `exitDistance` (exact for both).
- **Rounded rectangle:** Excalidraw draws each corner as a quadratic Bézier
  curve from `(hw − r, hh)` over the control point `(hw, hh)` to `(hw, hh − r)`
  (path `M r 0 L w−r 0 Q w 0, w r …`), not as a circular arc. In the corner's
  quadrant the curve is `x = hw − r(1 − s)², y = hh − r s²`. If the box exit
  lies in a corner region, the ray is intersected with that curve (a quadratic
  in `s`, `cornerExit`). The radius follows Excalidraw's `getCornerRadius`
  (`excalidrawCornerRadius`): legacy and proportional roundness `0.25 ×
  min(w, h)`; adaptive roundness the same up to `min(w, h) = value / 0.25`, then
  the fixed `roundness.value` (default 32).
- `ParsedMindmap.cornerRadii` holds the radius per tree node
  (`parser.ts: cornerRadiusOf`). The radius applies only if the node's anchor is
  a rounded Excalidraw `rectangle` with node shape `rectangle` and fills the
  node's logical bounds (within 1 px). A group with content outside its
  rectangle, a text, or an image has no visible rounded outline; its node box
  is the bounding box, and the line ends there.

If nothing would remain visible (overlapping nodes), the line spans the anchors.

Previously the write-back reproduced the gaps recorded at parse time, so that an
unchanged layout left every line where it was drawn. This was dropped because
the lines then did not cleanly touch the nodes. Hand-drawn lines often stop
short of a node or reach into it (the M12.1 drawing in the vault has recorded
gaps from −55 px to +31 px, and 17 of its node rectangles use adaptive
rounding), and lines also stopped short of rounded corners because the exit was
computed on the sharp box. Now the first write snaps every tracked line onto
the outlines, also with an unchanged layout. The anchor offsets still come from
the drawn line (and from the anchor clamp, see `bindLineToEdge`).

**Hydration (`hydrateEdges`)** reads offsets and gaps from the line metadata rather
than the line's current geometry. A node moved by hand therefore keeps a valid
offset instead of turning the old line position into a large one. A line edited by
hand takes effect at the next parse. The first line in scene order wins when
several claim one edge (a copied line). An edge without a line stays centered and
is not redrawn.

**Writing back (`layout.ts: writeGraphToScene`).** One transaction that:

- moves every node's logical element by `target center - current center`, with
  the target from `graphToScenePoint`; size, IDs, and metadata are preserved;
- redraws every tracked line with `edgeEndpoints`, honoring `parentEnd`; bends and
  curves of multi-point lines keep their form because all points go through the
  rotation and scaling that maps the old chord onto the new one (`reshapeLine`);
- shifts a line's label (bound text) by the moved midpoint;
- stores the current offsets and the gaps of the drawn line (the preferred
  gaps, or the fallback gaps of the reparse check) in `mindmapEdge`;
- before writing, makes sure that parsing the result gives back the same tree
  (reparse check below) and adjusts line ends where it would not.

`writeGraphToScene(ea, mindmap, distances, captureUpdate?)` takes
`WriteDistances { parsing, rendering }` (the Parsing Connection Distance a
later parse will use, and the Rendering Connection Distance) and returns a
`ReparseCheck` (`expected` edge count, `adjusted` child IDs whose ends left the
preferred gaps, and `failed` child IDs).
`ParsedMindmap.borderIds` (border element and group members) lets it rebuild the
parser's view of the scene.

**Reparse check (`layout.ts: ensureReparsable`).** Problem: after a layout,
Parse Mindmap sometimes found fewer nodes. Some line ends ended up too far from
their nodes, or nearer to another node, so the connection was no longer
detected. Causes:

1. The parser measures the **Euclidean** distance from a line end to the node
   boundary, but the gap was recorded and re-applied **along the anchor
   direction** (re-applying gaps is gone since lines end on the outlines). A gap recorded on a line that leaves a node at a grazing angle
   is much longer along the line than perpendicular to the boundary. After the
   layout turns the edge, the same gap puts the end far beyond the Connection
   Distance.
2. For ellipses the parser uses the radial distance along the ray from the
   center, also inside the ellipse. A negative gap (end inside the node) is
   therefore "far" from an ellipse when the direction changes.
3. Layouts pack nodes closer than the Connection Distance. A line end was then
   within reach of a neighbour that the breadth-first parse processes earlier,
   which attached the child to the neighbour, or both ends of a short edge were
   within reach of the parent. The parser change in section 6 (nearest owner)
   removes most of this; the check removes the rest.
4. A node whose box covers a whole edge (node-edge overlap) contains both line
   ends, which then tie at distance 0. The outline tie-break of section 6
   (step 3) resolves this.

Solution: the write-back runs the parser's own `traverseLines` on the scene as
it will look after the write: node candidates moved by their shifts, every
tracked line at its planned position, untracked lines unchanged (or moved with
the node group they belong to), border and temporary elements excluded as in
`parseScene`. *Expected* are the bound edges whose whole path to the root
consists of bound edges between existing nodes (edges without a line cannot be
parsed anyway). An expected edge counts as recovered only if the traversal
accepts it with the same parent, child, line, and parent end. The check runs at
the Connection Distance minus and plus a margin (`min(1, distance / 4)`), so
floating point noise cannot change the parse result.

Lines are planned with their preferred gaps. While an expected edge is not
recovered, the ends of the *failing* lines are moved: lines of unrecovered edges
whose parent the traversal reached, and tracked lines the traversal used for a
wrong connection. For each end, the gaps tried in order of preference are the
preferred gap, half the Connection Distance outside (only if the preferred gap
is larger), `0` (on the outline), a quarter of the Connection Distance outside,
halfway to the anchor, half the Connection Distance outside, and the anchor
(`gapLevels`). They are needed where nodes touch or overlap a neighbour (an end
at the outline then also lies on or inside the neighbour, and moving it out
into the free space or deeper into its own node makes its owner unique again),
and where the Rendering Connection Distance is larger than what the parse
accepts: such an end shrinks to half the Parsing Connection Distance, which
always parses. Gap pairs are tried by increasing departure from the preferred
pair (`gapCandidates`). The
first pair that strictly improves the score (more recovered edges, then fewer
wrong connections) is kept, and the failing set is recomputed (`improveOnce`),
at most `4 × lines` rounds. The line stays on the anchor-to-anchor segment and
only gets shorter or longer. The check uses the end point exactly as the element
stores it (`x + (end − start)` from `reshapeLine`), not the computed end, so
rounding cannot make the real parse differ from the check.

Every write starts again from the preferred gaps, so writing the same layout
again gives the same lines (deterministic). An edge that cannot be recovered is
logged with `console.warn`; after Start/Stop, Step, and Reset the workbench shows
a warning notice with the number of such edges. Adjusted lines alone stay silent.

Verified with a throwaway fake-EA smoke script (scene built from the research
example `example-m12_1.json`: 64 rectangles, 75 % of them with adaptive
rounding, plus one ellipse; lines with gaps from −4 px to 0.9 × Connection
Distance, 30 % bent, random directions; parse, then no layout, Reset + Start, or
Start only with nikogenia v1 until completion, write, parse again; Connection
Distance 8, 15, 30; 4 seeds each, 36 runs). Line ends were measured against an
outline sampled independently from Excalidraw's path definition (sides plus
quadratic corner curves, or the ellipse):

| Write-back | Edges lost on reparse | Line ends more than 0.5 px off the outline |
| --- | --- | --- |
| first version (recorded gaps, sharp box, old parser rule) | 236 | 4149 of about 4400 |
| outline ends + nearest owner + outline tie-break + reparse check | **0** | 2 (fallback gaps) |

All other ends were within 0.0004 px of the drawn outline. The check's
prediction equalled the real reparse in every run, and a second write of the
same layout stayed reparsable. The same scenes with sharp rectangles: 0
structural losses; once (Connection Distance 30) a child was reparsed with the
right parent but through an untracked line that comes first in scene order (see
section 16). This was correctly predicted and warned about. A write took
2–18 ms for this 65-node graph (about 1–2 ms when no line needs a fallback).

Rendering distance and the 1 px outline gap (same smoke script, 25 % of the
rectangle nodes replaced by plain texts without outline, all other shapes with
a visible stroke; Rendering Connection Distance 5, 0, 20, 50 by seed; 36 runs):
0 edges lost on reparse. Ends at outlined nodes lay 0.04–1.0 px outside the
drawn outline (exactly 1 px along the line, less perpendicular for slanted
lines), never inside. Ends at text nodes lay up to the Rendering Connection
Distance from the box, less where `fitGaps` shrank the gap for close nodes or
where the distance (20 or 50) exceeded the Parsing Connection Distance and the
check pulled the end in. Writes took up to 41 ms when many lines needed that
fallback.

Intermediate result, kept for reference (first smoke version with recorded
gaps and sharp boxes, 24 runs): previous write-back with the previous parser
lost 187 edges, the reparse check alone 18, the nearest-owner rule alone 119,
both together 0. With outline ends, the same scenes then lost up to 5 edges per
run, all caused by boxes covering whole edges (cause 4). The outline tie-break
fixed this.

Undo capture defaults to `"NEVER"`, because Rollback is the undo of a layout run.
Lines grouped with a node are placed by the edge logic, not moved with the group.

The layout runner calls `writeGraphToScene` after each render inside
`session.run(...)`. It keeps its own `ParsedMindmap` and `refresh`/`hydrate` are
skipped during a run (section 7.3), because hydration creates a new graph after
every scene change, and that includes the runner's own writes. Fixed nodes keep
their positions, so their elements are not touched.

### 7.3 Layout runs

**Graph of a run.** Start, Step, and Reset load a new `ParsedMindmap` from
metadata and the live scene (`loadMindmapFromMetadata`), with positions, edge
offsets from the line metadata, and fixed nodes. The run owns it until it ends.

**Start (initiation mode `none`).** `createLayoutAlgorithm` sets
`keepInitialLayout = true`: no rotation search and no canvas fit, the current
drawing is optimized as it is, like the research web UI with initiation mode
`none`. `borderPadding` is `1`. `initialize` re-projects the stored anchor
offsets for the configured Max Anchor Offset Ratio.

**Reset (initiation mode `radial-area`).** `applyInitialLayout` centers all
anchors (`resetOffsets`), runs `RadialAlgorithmArea` (root at the canvas center,
wedges proportional to subtree area, random start angle, fixed nodes restored to
their positions), then initializes a throwaway `NikogeniaAlgorithmV1` with
`keepInitialLayout = false`. Its structure preserving start rotates and fits the
radial layout to the border area (Fit To Canvas, Initial Rotations); fixed nodes
are excluded from both. No layout step runs. This is exactly what the web UI does
before its first Nikogenia step, so Reset followed by Start equals one web UI run
with initiation mode `radial-area`. The result is written once.

**Reset Before Start** runs the Reset computation on the run's graph right before
`createLayoutAlgorithm`, without writing the intermediate layout and with one
backup. Step never resets.

**Continuing.** Stop keeps the run (`wb.run`). The next Start or Step continues
it if it is not completed and the drawing's content version
(`runner.ts: contentVersion`, element count plus version sum without temporary
elements) equals the version recorded after the run's last write. Any edit,
metadata change, or parse in between starts a new run (with a new backup). A
changed algorithm parameter discards the stopped run; Reset discards it too.

**Execution model.** The run executes cooperatively on the main thread
(`LayoutRun.run`): steps run for at most 12 ms or until Steps Per Render is
reached, then control returns to Obsidian through a `MessageChannel` message
(not clamped like nested `setTimeout(0)`, and the browser can paint and handle
input before it is delivered). After every Steps Per Render steps, and once at
the end, the graph is written with `writeGraphToScene` (`"NEVER"`, not saved; the
drawing becomes dirty and autosave persists it). Steps per render is re-read
every slice. User Timing marks that `NikogeniaAlgorithmV1.step` records per step
are cleared after the run.

A Web Worker was considered and rejected for now:

- The script ships as one Script Engine bundle, and the template-managed
  `esbuild.config.mjs` has no way to emit and inline a second worker bundle.
- A worker needs its own copy of the core including p5 (the bundle is about 7 MB
  because of p5), and p5 v2 needs a DOM to install `p5.Vector` math (the
  benchmark worker in the research repository works around this).
- Every render still has to go through EA on the main thread.

The steps themselves are short (milliseconds for mindmap sizes), so slicing keeps
Obsidian responsive. A single step or the initial rotation search of a very large
graph can still block for its own duration.

**Stopping.** `LayoutRun.stop()` sets a flag that is checked before every step,
after every slice, and before every render. Stop renders the last computed steps
and keeps the run. Session teardown (closing the workbench, closing the drawing,
switching files, restarting the script, rollback) calls `stop()` first, and every
render returns `false` once the session is no longer alive (queued transactions
are skipped), so the loop ends within one step. Nothing survives the workbench:
there is no worker or timer outside the loop.

**Scene ownership.** While Start, Step, or Reset runs (`wb.busy`), indicators are
removed (the backup removes them anyway), `refresh` is skipped, and conflicting
controls are disabled (section 5). Afterwards the workbench re-hydrates from
metadata and restores the indicators. Elements the user moves during a run are
moved back to the algorithm's positions by the next render; deleted elements are
skipped.

## 8. Evaluation and Best Layout

After parsing and after each rendered layout, calculate and display
`calculateTreeEdgeGraphMetricsString(graph)`. This reports node count and
overlaps, edge count and crossings, node-edge overlaps, minimum angular
resolution, anchor offset statistics, edge-length statistics, and node-distance
statistics. Edge metrics are measured on the anchor-to-anchor segments, and
crossings of edges sharing a node are not counted, because they are hidden inside
that node.

The core does not define an aggregate score. Until a weighting study is
approved, “best” means a Pareto improvement: fewer node overlaps, edge
crossings, and node-edge overlaps; higher minimum angular resolution; and an
edge/node-distance distribution appropriate to the available border area.
No automatic winner selection should be implemented in the first UI slice.
Future scoring must be explicit, configurable, and evaluated against the
research test graphs.

## 9. Temporary Indicators and Scene Transactions

Indicators use the same coordinates as the current scene, are created on top
of the scene (`newElementsOnTop`), and are clearly distinguishable from user
content: red dashed padded Border, blue dashed Root, green per-node
indicators/arrows, and orange (`#f08c00`) fixed elements. Their `customData` is:

```ts
{
  isMindmapTemporary: true,
  mindmapIndicatorKind: "border" | "root" | "node" | "fixed" | "arrow",
  mindmapIndicatorOwner: string  // anchor ID of the represented content
}
```

Root, node, and fixed indicators are drawn 2 px outside the owner's bounds on
every side (`INDICATOR_OUTSET`), so they stay visible even where they would
coincide with the outline of a node's own border element. The border indicator
marks the padded layout area exactly and is not inflated. A fixed tree node
shows the orange indicator instead of the green one (its parent arrow stays);
a fixed root shows both, the orange ring 6 px outside so it encloses the blue
one.

Their IDs are held in runtime state (`IndicatorState.records`), not in
root/node metadata. Each record stores its key (`border`, `root`,
`node:<id>`, `fixed:<id>`, `arrow:<childId>`), element ID, kind, owner, element
type, the geometry the indicator was last placed at, and the owner's bounds at
that time. Dragging an orange indicator moves its content like any other.

### 9.1 Indicator sync

`syncIndicators(ea, state, model)` is the only way indicators change. The model
holds border ID, padding, root ID, the hydrated node list, and the fixed element
IDs; everything else is resolved from the live scene on every call. One sync:

1. **Indicator drags.** For each border/root/node record whose owner still has
   the recorded bounds while the indicator element moved (and was not
   resized), the owner's logical elements (group members and bound text) are
   moved by the same offset in one undoable transaction, followed by
   `api.refreshAllArrows()` for bound connectors. Moving an indicator thus moves
   its content.
2. **Reconcile.** Desired indicators are derived from the current content:
   - moved content: its indicator and the parent/child arrows follow;
   - content and indicator moved together (box selection): nothing to do;
   - resized or dragged arrow indicators: snapped back;
   - deleted content: its indicator and arrows are deleted;
   - deleted indicator: recreated;
   - unknown temporary elements (for example a crashed or file-switched
     session's leftovers that autosave persisted): deleted.

   Indicators with an unchanged type are updated in place (`x`, `y`, `width`,
   `height`, arrow `points`), so IDs and the user's selection survive; only a
   type change (ellipse/rectangle) recreates one. All changes form one unsaved
   transaction with `captureUpdate: "NEVER"`; an unchanged sync performs no
   transaction.

The session calls a refresh (hydrate, sync, re-hydrate if content moved) after
every debounced scene change, after every metadata action, and on startup.
Border Settings temporarily replaces the model's border/padding with its
uncommitted candidate; closing or cancelling it restores the committed state.

Persistent metadata changes from the UI use
`addElementsToView(false, false, false, false, "NEVER")` with freshly copied
elements. Before Start, Step (new run), and Reset change the layout, the current
drawing is explicitly saved as part of backup preparation; that is the sole
explicitly save-enabled scene transaction. A failed transaction must leave runtime state
consistent and must not leave the EA workbench dirty (`ea.clear()` in
`finally`).

## 10. Backups and Rollback

Before any algorithm changes the layout (every Start that does not continue a
stopped run, every Step that starts a new run, and every Reset; Reset Before
Start creates one backup for both), remove the indicators, save the drawing, and
copy the complete saved file through the Obsidian vault API into a folder named
`mindmap-backup` beside the current mindmap file (`ui.ts: createRunBackup`). If
the backup fails, the layout is not changed. The folder is a
normal vault folder (a dot-folder would not be indexed by the vault API); the
`.backup` files are hidden from the file explorer only because Obsidian does not
show unknown extensions by default. The backup name is:

```text
<current-file-name>.run<incrementing-number>.backup
```

The counter is the highest existing number for this file plus one, so the
number order is the creation order even after an older backup was restored and
consumed (reusing the first free number would sort a new backup before older
ones). Creation is collision-safe (`Vault.create` fails instead of
overwriting). Backups contain the whole original file, not only the selected
elements. The creation time shown in the dialog is `TFile.stat.ctime`.

**Rollback dialog.** Shows the newest backup's file name and creation date and
time with three buttons:

- **Restore** restores the newest backup.
- **Choose Previous Backup** (only enabled when more than one backup exists)
  switches the dialog to a dropdown of all older backups (`name (date time)`),
  with **Restore**, **Back**, and **Cancel**.
- **Cancel** closes the dialog.

Only the restored backup is consumed; newer backups are kept, so a rollback
to an older state can itself be undone by restoring a newer backup.

Rollback restores the chosen backup in this order
(`backup.ts: rollbackMindmapBackup`):

1. Wait for queued transactions, check that the backup still exists, then read
   it. A missing backup or a read failure changes nothing.
2. End the workbench session (indicators removed, hook server released).
3. Close every leaf that shows the drawing (`closeViewsOfFile`:
   `leaf.setViewState({ type: "empty" })`, which awaits the view's close and the
   destruction of the script EA).
4. Wait until the file received no `modify` event for 750 ms (at most 5 s), so
   the old view's deferred final save (section 3.2.2) has landed.
5. Write the backup content with `Vault.modify`. No editor is open, so the
   plugin's merge (section 3.2.5) cannot interfere.
6. Wait for quiet again and read the file back. If the content differs, repeat
   from step 5, up to three attempts; then fail.
7. Reopen the drawing in all closed leaves, activating the original, with
   `leaf.openFile`. This also happens after a failed write. The plugin loads the
   restored file from disk with full fidelity (elements, deletions, text,
   embedded files).
8. Delete the consumed backup and the then-empty `mindmap-backup` folder.

If any step before 8 fails, the backup is kept and an error is logged and
shown. Rollback takes about 1.5 s because of the two quiet periods. Clear Backups
shows the number of backups it will delete, matches the current file exactly,
and leaves backups belonging to other drawings untouched.

Without step 4, the restored drawing is visible for a moment and is then replaced:
the old view's write lands about 200 ms after the close, on top of the restored
file, and the reopened view picks it up through its `modify` handler. This looked
like a cache reapplying changes, but no cache is involved.

The earlier approach (write the file while the view is open, then
`leaf.openFile` on the same file) could not work: `openFile` for the file
already loaded in the leaf is a no-op (`FileView.loadFile` returns early), and
the write was merged into the live scene instead of replacing it (section
3.2.5). Restoring into the live view with `updateScene` was rejected as well:
it would also need the plugin's text-element, link, and embedded-file state to
be rebuilt, which only a full load does.

The import-safe `backup.ts` helper implements collision-safe creation, exact
per-file matching, the rollback order above, and cleanup of the empty
`mindmap-backup` folder.

## 11. Lifecycle and Failure Behavior

- Verify the required Excalidraw plugin version before opening the modal.
- If the Excalidraw API, the active target view, or its file is unavailable,
  stop cleanly with the existing notice pattern.
- One `WorkbenchSession` per view (`session.ts`). Starting the script again on
  the same view ends the previous session (`replaced`) first, so two sessions
  never compete for the hook server. A notice reports the restart.
- On start the session calls `ea.registerThisAsViewEA()` and sets
  `ea.onViewUnloadHook`, subscribes to `api.onChange`, `api.onPointerDown`,
  `api.onPointerUp`, and the workspace `file-open` event, and registers its
  teardown with `ea.registerCleanup`.
- Teardown is idempotent and synchronous. It stops timers, unsubscribes all
  listeners, removes every temporary element through the captured imperative
  API, releases the hook server, closes the main modal and all child modals,
  and leaves the last committed persistent state intact. Every async
  continuation checks `session.alive`, and queued transactions are skipped
  after teardown. Teardown reasons:

  | Reason | Trigger | Indicators |
  | --- | --- | --- |
  | `modal-close` | user closes the main modal | removed (view alive) |
  | `view-unload` | `onViewUnloadHook`, before the final save | removed via captured API |
  | `ea-destroy` | `registerCleanup`, after the final save | removed if still mounted |
  | `file-switch` | other file opened in the same leaf | not touched (other drawing) |
  | `rollback` | before the drawing is closed and restored | removed |
  | `replaced` | script started again on the same view | removed |

- Every teardown stops a running layout run first (`LayoutRun.stop()`, section
  7.3), then removes listeners/timers, clears all temporary elements, and leaves
  the last committed persistent state (including the last rendered layout)
  intact.
- Parsing with no root, no border, or no matching lines is valid; show an empty
  or explanatory state without throwing.
- Malformed metadata is ignored or replaced with validated defaults, although a
  warning should be displayed; unrelated custom data is retained.
- Long-running Start execution yields to the UI every 12 ms and is cancelled by
  Stop and by every teardown path (section 7.3).

## 12. Implementation Order

1. Create import-safe state, metadata validation, and indicator/workbench
   helpers.
2. Implement the primary `FloatingModal` and Border Settings modal with live
   previews, cancellation, cleanup, and metadata persistence.
3. Implement root selection, shape application, and the breadth-first parser.
4. Add `TreeEdgeGraph` construction, line tracking, and graph metrics display.
5. Add algorithm selection adapter, Step/Start/Reset controls, and run metrics
   (implemented for nikogenia v1, with fixed nodes).
6. Add vault backup, rollback dialog, restore/reload, and cleanup
   (implemented; every layout change creates a backup first).
7. Add focused tests for pure metadata, geometry, queue/loop handling,
   indicator sync, edge geometry, and algorithm mapping (the repository has no
   Vitest setup yet; `syncIndicators` (including fixed indicators and the
   outset), edge binding and write-back, fixed node hydration, Reset, runs with
   stop/continue/Finished/session end, text fitting, backup numbering,
   rollback to a chosen backup, and reparse after Reset/Start (section 7.2)
   were verified with throwaway fake-EA smoke scripts);
   then run the repository check/build and an Obsidian smoke test covering
   modal lifecycle, closing the drawing with the workbench open, popout/mobile
   behavior, selection through indicators, indicator/content moves, parsing,
   fixed nodes, text fitting, Start/Stop/Step/Reset, closing the drawing during
   a run, save, rollback (newest and previous), and cancellation.

## 13. Acceptance Criteria for the First UI Slice

- Running the script immediately opens the primary floating modal.
- The modal contains the three sections, required labels/controls, disabled
  states, run statistics, and the credit line.
- Border Settings opens as a second floating modal and supports synchronized
  slider/text inputs, live red preview updates, Save, and Cancel.
- A stored border is loaded on startup; an absent border causes no notice.
- A stored root is loaded on startup and shows its blue preview; selecting a
  root starts parsing through the documented orchestration hook, even if the
  parser initially returns an empty graph. Persisted node metadata is loaded
  and shown with green node and parent-arrow indicators on startup.
- Closing the primary modal removes every temporary element marked with
  `isMindmapTemporary`.
- Closing the drawing (tab close, window close) while the workbench is open
  saves a file without temporary elements and logs no "targetView not set".
- Selecting an indicator works like selecting its node for root selection,
  border selection, and Apply Shape.
- Moving content moves its indicator and arrows; moving an indicator moves its
  content (undoable); deleting content removes its indicator; deleting an
  indicator recreates it.
- Rollback restores every element of the backup, including deleted nodes and
  earlier positions, and the restored file is not overwritten afterwards.
- Parsing produces a `TreeEdgeGraph`, and each edge's line carries `mindmapEdge`
  metadata. `writeGraphToScene` with an unchanged layout leaves the drawing in
  place.
- Fix/Unfix Selection toggles `isMindmapFixed`; fixed elements show orange
  indicators, are loaded into the graph, and never move during Start, Step, or
  Reset. Indicators lie 2 px outside their content.
- Fit Selected Text Widths narrows free text without changing its line breaks.
- Selecting a root marks it as fixed; Unfix Selection releases it.
- The graph is named after the drawing file (`Mindmap M12.1` for a file name
  starting with `M12.1`).
- After Start, Step, or Reset, Parse Mindmap gives the same tree again (same
  parents and lines); otherwise a warning notice is shown.
- Written lines end 1 px outside the visible outlines of rectangles (also with
  Excalidraw's rounded corners) and ellipses, and the Rendering Connection
  Distance away from nodes without a visible outline (plain texts).
- The workbench shows Parsing Connection Distance (`1..300`, default 20) and
  Rendering Connection Distance (`0..50`, default 15), both stored on the root.
- Export And Copy To Clipboard copies the serialized graph.
- Notices stay visible for 8 s.
- Start runs nikogenia v1 on the current layout and turns into Stop; Reset applies
  the radial area weighted initial layout; both create a backup first. Obsidian
  stays responsive during a run, and closing the workbench or the drawing stops
  it.
- The rollback dialog shows the backup's name and creation time and can restore
  a previous backup; Clear Backups shows how many backups it deletes.
- User actions report their result with a notice.
- The UI is implemented through documented EA/Obsidian APIs and does not
  mutate immutable scene elements directly.
- Backup and rollback controls use the documented vault API and remain disabled
  when no matching backup exists.

## 14. First-slice implementation notes

The current implementation includes import-safe metadata loading, persisted
graph hydration with automatic metrics, group- and bound-text-aware logical
selection, indicator-to-owner selection mapping, a serialized transaction
queue, unsaved non-undoable indicator/metadata transactions, two-way
indicator/content movement sync, startup indicator refresh, selection notices,
debounced border and connection-distance previews, and compact modal styling
with a clickable credit link. The Border Settings modal uses the documented
default positioning; no CSS translation is applied. The border indicator stays
visible for the full lifetime of the main modal, including while Border
Settings is open.

Module responsibilities:

- `session.ts`: `WorkbenchSession` binds to one view, registers the hook
  server and `onViewUnloadHook`, subscribes to scene/pointer/file-open events,
  owns the transaction queue, and performs the idempotent teardown.
- `indicators.ts`: indicator model, records, `syncIndicators` (drag detection,
  in-place reconcile), `resolveIndicatorOwners`, `clearIndicatorsNow`.
- `scene.ts`: `TransactionQueue`, `saveMetadata` (fresh copies), `moveElements`,
  `saveCurrentDrawing`, `removeTemporaryElementsNow` (imperative API, usable
  during view unload).
- `edges.ts`: pure conversion between lines and anchored edges, and the
  visible outline geometry (`outlineExit`, Excalidraw corner radius and corner
  curve) that line ends are placed at, with gap shrinking for close nodes
  (`fitGaps`, section 7.2).
- `layout.ts`: `writeGraphToScene`, used by every render of Start, Step, and
  Reset, including the preferred line gaps (`restGaps`, `OUTLINE_GAP`) and the
  reparse check (`ensureReparsable`, section 7.2).
- `parser.ts`: `parseMindmap`, `loadMindmapFromMetadata`, the pure
  `traverseLines` shared with the reparse check, and `mindmapName`.
- `algorithm.ts`: dropdown options, the parameter groups (primary, advanced,
  Reset) derived from the core parameter tables, tooltips, default settings from
  fresh core instances, validation of stored settings, `createLayoutAlgorithm`
  (Start) and `applyInitialLayout` (Reset).
- `runner.ts`: `LayoutRun` (time-sliced `run`, `step`, `stop`),
  `contentVersion`, `stepTimings`.
- `textfit.ts`: `fitTextWidths`.
- `dom.ts`: DOM builders (texts, buttons, rows, range/number pairs with an
  optional special maximum, checkboxes, selects, `disableControls`). Untrusted
  strings (file names, IDs) use `addPlainText` (`textContent`), not `innerHTML`.
- `ui.ts`: the `Workbench` runtime object (state, indicator registry, hydrated
  nodes and fixed IDs, border preview, child modals, algorithm settings, current
  run, busy flag) and all UI actions.

The startup loader keeps the first root flag in stable scene order. If more
than one element is flagged as a root, the remaining root flags are removed in
one unsaved metadata transaction and a warning notice is shown. Selecting a new
root removes the previous root flags in the same transaction. Metadata actions
are displayed in one row; Start, Step, and Reset share a row, as do Rollback and
Clear Backups.

The first parser slice is implemented in the import-safe `parser.ts` module.
It filters temporary and line elements, excludes the configured Border Element
and every member of its group, walks a queue with a read pointer, uses
shape-aware boundary distance checks, resolves the nearest eligible canvas
element in stable scene order, rejects queued and cyclic candidates, and adds
`TreeNode` instances parent-first to a `TreeEdgeGraph`. Parsed nodes retain their
actual bounds and normalized shape. Parsing persists parent and children
metadata (children arrays are copied, not shared with the graph) and edge metadata
on the lines, infers a missing shape, and clears stale mindmap relationships;
indicators then follow from hydration.

Confirmed Clear Mindmap and Clear All Metadata actions are implemented through
unsaved metadata transactions and preserve unrelated custom data. Before a
layout change, `createRunBackup` clears temporary indicators, saves the current
scene once (by round-tripping one element through
`addElementsToView(..., save = true)`), and then creates the backup.

## 15. Correctness Notes and Key Changes

The parser must not treat absent `mindmapShape` metadata as evidence of an
ellipse. During the first parse, metadata for newly discovered nodes does not
yet exist, so the fallback is the element's actual Excalidraw type:
`ellipse` remains an ellipse and every other supported node shape is represented
as `rectangle`. The same fallback is used by startup node indicators and root
indicators, so the first render and later reparses agree.

Graph coordinates are simulation coordinates, not Excalidraw scene
coordinates. The graph origin is the top-left corner of the padded border
region:

```text
graph.x = scene.x - (border.x + padding.left)
graph.y = scene.y - (border.y + padding.top)
scene.x = graph.x + (border.x + padding.left)
scene.y = graph.y + (border.y + padding.top)
```

`ParsedMindmap.coordinateSpace` stores this origin and the usable width and
height. `sceneToGraphPoint` and `graphToScenePoint` are the shared conversion
helpers; algorithm position updates (`writeGraphToScene`) convert graph positions back
through `graphToScenePoint` before editing Excalidraw elements. Indicators remain
scene overlays and therefore use the original logical element bounds directly.

Temporary indicators are cleared before backup creation and on every teardown
path. The earlier close handling did not work for three independent reasons
(section 3.2): the hook was set on the script EA without
`registerThisAsViewEA()`, so the view never called it; the `registerCleanup`
fallback runs only after the final save; and `ea.deleteViewElements` refuses to
run once `targetView._loaded` is false, which produced the "targetView not set"
console error. Calling the previous hook unconditionally also threw, because
its default value is `null`. The session now registers as hook server and
removes indicators in the hook through the imperative API captured at startup,
which is synchronous and still mounted at that point.

Rollback closes all views of the file, waits for the deferred final save, writes
and verifies the backup content, and reopens the file (section 10). The backup is
consumed only after the reopen succeeds. All caught
failures are also written with `console.error` before the user notice is shown.
Clearing the final backup deletes the empty `mindmap-backup` folder itself
while preserving folders that still contain any files.

## 16. Known Limitations and Open Issues

- **Switching files in the same tab** with the workbench open: Obsidian calls
  `onUnloadFile` (which saves) without unloading the view, and no hook runs
  before that save. Indicators are therefore persisted in the previous drawing;
  the workbench closes on the following `file-open` event, and the next session
  on that drawing deletes the leftovers. Autosave and crashes can leave
  leftovers the same way.
- **Hook shadowing**: while a session is active, the script EA is the view's
  hook server, so hooks set on `window.ExcalidrawAutomate` (startup script) are
  not called for that view. Only the previous `onViewUnloadHook` of the script
  EA itself is chained.
- **Undocumented reset**: releasing the hook server uses the view's
  `setHookServer()` because `deregisterThisAsViewEA()` is broken in 2.27.x.
  Recheck after plugin upgrades and switch back to the public method when fixed.
- **Nested groups**: `getElementsInTheSameGroupWithElement` matches any shared
  group ID and `getMaximumGroups` uses the outermost group. If the whole map is
  grouped, every node resolves to the entire map. Nodes must currently be
  ungrouped or grouped only with their own parts.
- **Lines while editing by hand**: moving content through its indicator moves
  elements by offset and then calls `api.refreshAllArrows()`. Unbound lines stay
  where they are until `writeGraphToScene` redraws them. With edge tracking in
  place, the workbench could redraw a moved node's lines immediately.
- **Line model**: the graph treats every line as its straight chord, so a strongly
  bent line is measured less exactly. Rotated elements (`angle`) are ignored, as
  in the node geometry.
- **Bound arrows**: `writeGraphToScene` writes arrow points but keeps
  `startBinding`/`endBinding`. Excalidraw may re-route such an arrow to its binding
  when the node is next moved by hand. Elbow arrows are not specifically supported.
- **Copied elements** keep their customData, including `mindmapEdge`. Hydration
  ignores the extra claim and the next parse clears it.
- **Core typecheck**: the core is compiled with this repository's stricter
  tsconfig (`exactOptionalPropertyTypes`, no Vite types). With the current
  simulation-repository changes, `npm run typecheck` reports errors only in
  `core/graph/generators.ts` (`import.meta.glob`, optional `width`/`height`/
  `parentId` assigned as `undefined`, `unknown` arguments) and
  `core/graph/TreeEdgeGraph.ts:75` (`edge.maxOffsetRatio = source.maxOffsetRatio`
  may assign `undefined`). The build is not affected. The fixes belong in the
  simulation repository.
- **Runs on the main thread**: see section 7.3 for the reasoning. A very large
  graph can make single steps (or Reset's rotation search) noticeably long.
- **Outline of grouped or framed content**: a node whose rectangle does not fill
  its group's bounds (content sticking out), and text and image nodes, use the
  bounding box as outline and keep the Rendering Connection Distance from it.
  Since text boxes include line spacing, the visible gap to the glyphs is a bit
  larger than configured, and a text node with node shape ellipse measures the
  gap from the ellipse inscribed in its box. Rotated
  elements (`angle`) and Excalidraw's hand-drawn roughness are ignored; with
  roughness the stroke wobbles by a pixel or two around the exact outline.
- **Hand-drawn line style is not kept**: every write moves the tracked line ends
  to the preferred gaps (section 7.2), also on Reset or a write of an unchanged
  layout.
- **Rendering larger than Parsing Connection Distance**: such ends cannot keep
  the configured gap, because the parse would lose them. The reparse check
  pulls them in to half the Parsing Connection Distance; this is silent (an
  adjusted line, no warning).
- **Reparse guarantee limits** (section 7.2): the check covers the tracked lines
  only. Line ends are moved along the anchor segment, never sideways, and lines
  are never reversed. In the rare fallback case an end stops a few pixels
  outside its node or reaches into it. An edge between overlapping or touching nodes may still
  be unrecoverable (warning notice). An untracked line that a layout moves next
  to a node can still add an unexpected node on reparse; it is counted as a
  wrong connection but not moved. The guarantee holds for the Connection
  Distance at write time (±1 px margin); parsing later with a smaller distance
  can lose edges again. Hand edits after the layout are not checked.
- **Reparse check cost**: two parser traversals per render, plus some per
  failing line. Measured 2–18 ms per write on the 65-node M12.1 scene, so
  Steps Per Render = 1 makes runs noticeably slower on large maps.
- **Parser change for existing drawings**: the nearest-owner rule and the
  outline tie-break (section 6) can change the result of Parse Mindmap on
  hand-drawn maps where a line end lies within reach of, or inside, several
  nodes: the end now goes to the nearest node (then the nearest outline), before
  to the first one processed or in scene order.
- **Edits during a run** are overwritten by the next render for moved nodes; the
  controls that change metadata are disabled, but the canvas itself is not
  locked.
- **Step ignores Reset Before Start**; only Start resets automatically.
- **Duplicate border flags** are not repaired (roots are).
- **Rollback ends the workbench**, because the view and its script EA are
  destroyed. Re-opening it automatically would need a new EA for the reopened
  view (`window.ExcalidrawAutomate.getAPI(view)`), which the Script Engine would
  not destroy on close; the session's own hook-based teardown would have to be
  the only cleanup path.
