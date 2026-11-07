# Automatic Mindmap Layouting

## Status

Draft specification for the ExcalidrawAutomate script. This document describes
the first implementation slice (the floating UI) and the contracts that later
graph parsing, layout, persistence, and evaluation code must satisfy.

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
  parser.ts                       Line parser and metadata hydration
  edges.ts                        Line <-> anchored edge geometry
  layout.ts                       Writes a graph back to the canvas
  backup.ts                       Vault backups and rollback
  preview.svg                     Script preview asset
  README.md                       Script-facing documentation
  spec.md                         This implementation specification
  core/                            Symbolic link to the research engine
    graph/types.ts                TreeNode, TreeEdge, TreeGraph
    graph/TreeEdgeGraph.ts        TreeGraph subclass with movable edge anchors
    graph/shapes.ts               Shape geometry (ray casting, anchor clamping)
    graph/evaluation.ts           Graph metrics and formatted metrics string
    graph/evaluationEdge.ts       Metrics measured on anchored edges
    graph/generators.ts            Reproducible test graphs
    algorithms/types.ts           LayoutAlgorithm contract
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
  dragging an indicator use `"IMMEDIATELY"` and are undoable like a native move.
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
  mindmapConnectionDistance: number,
  mindmapChildren: string[]
}
```

`mindmapConnectionDistance` is an integer in `[1, 300]`. The default is `15`,
also for a malformed persisted value.
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
    parentGap: number,          // line end to parent boundary (negative: inside)
    childGap: number            // line end to child boundary (negative: inside)
  }
}
```

The metadata lives on the line because the line is the element it describes:
deleting the line removes the binding, and undo restores it. Node elements store
no line IDs. `readEdgeMetadata` validates the value; malformed metadata counts as
no binding.

## 5. Primary Floating Modal

The main modal title is **Automatic Mindmap Layouting**. It is opened as soon
as the script runs. If no element is selected, the script still opens the UI;
selection-dependent actions explain their missing selection in the UI and do
not mutate the scene.

**Selections through indicators.** Indicators lie on top of their content, so
a click usually selects the indicator. Every selection-driven action (Use
Selected Element/Group, Select Root Element/Group, Apply Shape To Selection)
first maps selected indicators to their owner via
`customData.mindmapIndicatorOwner` (`resolveIndicatorOwners`) and folds bound
text into its container. Selecting an indicator is therefore equivalent to
selecting its node; selecting both the node and its indicator is not
ambiguous.

**Notices.** Each user action reports its result with an Obsidian notice: root
saved, border saved, parse result (node and edge counts), shape applied, metadata
cleared, backup created, backup restored, backups cleared, and every failed
precondition or error. Restarting the script while a workbench is open, or
opening another file in its tab, also shows a notice. Continuous input (sliders)
and automatic refreshes stay silent.

The modal is rendered from runtime state. A scene change re-renders it only
when border/root/graph presence changed (for example the root was deleted or
restored with undo); otherwise only the graph statistics text is updated, so
sliders are not rebuilt while the user drags them.

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
- Selecting or saving a Root immediately starts automatic parsing from that
  Root.
- Show a shape dropdown (`ellipse` / `rect`) and **Apply Shape To Selection**. The
  action resolves the selection (content or indicators) to logical anchors and
  updates those already marked `isMindmapNode` (the root included), both in
  metadata and in their temporary indicators.
- Show Graph Statistics after parsing or successful startup graph loading, using
  `calculateTreeEdgeGraphMetricsString(graph)`. Statistics follow moved and deleted
  content (the graph is re-hydrated after every scene change).
- Provide a Connection Distance input with slider and number field, constrained
  to `1..300`, defaulting to `15`. Save it in Root metadata and use it during
  line-endpoint matching. Slider and number input changes use the same short
  debounce as Border Settings and must not rebuild the modal while the control
  is being dragged.
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

- Provide an algorithm dropdown. The first implementation exposes **Default**;
  the adapter must be designed for the concrete core algorithms later.
- Provide a **Steps Per Render** input with slider and number field constrained to
  `1..1000`, default `1`.
- Reserve a clearly labeled options area for algorithm-specific controls.

### 5.3 Control

Provide **Start**, **Step**, **Reset**, **Rollback**, and **Clear Backups**.

- **Start** runs the selected algorithm until completion or cancellation,
  rendering after the configured number of algorithm steps.
- **Step** performs one algorithm step and renders the result. This button is
  disabled if the algorithm wasn't started or reseted yet and isn't completed or running.
- **Reset** initializes execution from the parsed graph and resets run metrics;
  it does not discard user configuration.
- **Rollback** asks for confirmation in an Obsidian modal, restores the newest
  backup for the current file (closing and reopening the drawing, section 10),
  then removes that backup. The workbench ends with the closed view; the user
  starts the script again on the reopened drawing.
- **Clear Backups** removes all backups for the current file. If the backup
  folder is empty afterward, remove the folder as well.

Show current-run metrics: current step / total steps, and milliseconds per
step for now, minimum, average, and maximum. Disable controls when their
preconditions are not met (for example, no parsed graph or no active run).

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
  Connection Distance of the node boundary. The configured Border Element and
  every member of its group are excluded from candidates.
2. For nodes whose effective shape (`shapeOf`) is ellipse, use the ellipse
   boundary geometry rather than only an axis-aligned rectangle. A shape set
   with Apply Shape therefore also changes connection matching.
3. Resolve the opposite line endpoint to the nearest eligible canvas element.
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
nodes. Parsing must be deterministic: stable scene order and distance tie
breaks are preferred. It must never convert a line into a node or select a
temporary indicator as a candidate.

## 7. Graph and Algorithm Integration

Construct `TreeEdgeGraph(name, rootId, width, height, 0.5)` using the padded border as
the available layout area. Use the root and every parsed node as `TreeNode`
instances; preserve actual element dimensions because mixed shapes are a core
research requirement. Positions are `p5.Vector` centers as required by the
core.

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
does not use it. An adapter must not invent time scaling, the parameter can be omitted.

The UI's steps-per-render value is only an outer loop around `step(dt)`. It
must not change the algorithm's iteration count or other algorithm semantics.
For our algorithms, `iterations` is the completion limit and `currentIteration` is
incremented once per `step` call; non-root nodes are moved while the root is
left fixed, and positive `borderPadding` clamps positions to the graph bounds,
in this use case it should be always set to `1` cause padding is already applied to the graph dimensions.

Initialization and reset are not universally interchangeable. The current
`Algorithm.initialize(graph)` assigns the graph but does not reset
`currentIteration`. Reset behavior must therefore create a fresh algorithm
instance or explicitly reset the concrete algorithm's run state before
calling `initialize`. Do not assume that `initialize` resets parameters,
positions, or progress unless the selected implementation documents that
behavior.

The default algorithm is intentionally a placeholder until the algorithm
selection policy is reviewed. The implementation must not claim that one
algorithm is universally best.

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
node boundary along the anchor-to-anchor direction.

**Edge to line (`edgeEndpoints`, after a layout).** With `u` the unit direction
from anchor `a` to anchor `b`:

```text
parent end = a + u * (exitDistance(parent, parentOffset,  u) + parentGap)
child end  = b - u * (exitDistance(child,  childOffset,  -u) + childGap)
```

`exitDistance` is the core's ray cast from an inner point to the shape boundary.
If nothing would remain visible (overlapping nodes), the line spans the anchors.
These two conversions are inverse: for an unchanged layout and unclamped anchors,
the line ends exactly where it was drawn.

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
- stores the current offsets in `mindmapEdge`.

Undo capture defaults to `"NEVER"`, because Rollback is the undo of a layout run.
Lines grouped with a node are placed by the edge logic, not moved with the group.

The layout runner calls `writeGraphToScene` after each render inside
`session.run(...)`. It must keep its own `ParsedMindmap` and skip `hydrate` during
a run, because hydration creates a new graph after every scene change, and that
includes the runner's own writes.

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
content: red dashed padded Border, blue dashed Root, and green per-node
indicators/arrows. Their `customData` is:

```ts
{
  isMindmapTemporary: true,
  mindmapIndicatorKind: "border" | "root" | "node" | "arrow",
  mindmapIndicatorOwner: string  // anchor ID of the represented content
}
```

Their IDs are held in runtime state (`IndicatorState.records`), not in
root/node metadata. Each record stores its key (`border`, `root`,
`node:<id>`, `arrow:<childId>`), element ID, kind, owner, element type, the
geometry the indicator was last placed at, and the owner's bounds at that time.

### 9.1 Indicator sync

`syncIndicators(ea, state, model)` is the only way indicators change. The model
holds border ID, padding, root ID, and the hydrated node list; everything else
is resolved from the live scene on every call. One sync:

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
elements. Before the first mutation of a layout run, the current drawing is
explicitly saved as part of backup preparation; that is the sole explicitly
save-enabled scene transaction. A failed transaction must leave runtime state
consistent and must not leave the EA workbench dirty (`ea.clear()` in
`finally`).

## 10. Backups and Rollback

Before the first mutation of a layout run, remove the indicators, save the
drawing, and copy the complete saved file through the Obsidian vault API into a
folder named `mindmap-backup` beside the current mindmap file. The folder is a
normal vault folder (a dot-folder would not be indexed by the vault API); the
`.backup` files are hidden from the file explorer only because Obsidian does not
show unknown extensions by default. The backup name is:

```text
<current-file-name>.run<incrementing-number>.backup
```

The counter is the next available number for this current file in that folder;
it must be collision-safe. Backups contain the whole original file, not only
the selected elements. Never overwrite an existing backup.

Rollback selects the newest matching backup only after explicit confirmation
and restores it in this order (`backup.ts: rollbackLatestMindmapBackup`):

1. Wait for queued transactions, then read the backup. A read failure changes
   nothing.
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
shown. Rollback takes about 1.5 s because of the two quiet periods. Clear Backups matches the current file exactly and leaves backups
belonging to other drawings untouched.

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
`mindmap-backup` folder. The layout runner still needs to call
`createMindmapBackup` immediately before its first layout mutation.

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

- Closing the modal cancels a running loop (future), removes listeners/timers,
  clears all temporary elements, and leaves the last committed persistent state
  intact.
- Parsing with no root, no border, or no matching lines is valid; show an empty
  or explanatory state without throwing.
- Malformed metadata is ignored or replaced with validated defaults, although a
  warning should be displayed; unrelated custom data is retained.
- Long-running Start execution must yield to the UI and provide a cancellation
  path through modal close.

## 12. Implementation Order

1. Create import-safe state, metadata validation, and indicator/workbench
   helpers.
2. Implement the primary `FloatingModal` and Border Settings modal with live
   previews, cancellation, cleanup, and metadata persistence.
3. Implement root selection, shape application, and the breadth-first parser.
4. Add `TreeEdgeGraph` construction, line tracking, and graph metrics display.
5. Add algorithm selection adapter, Step/Start/Reset controls, and run metrics.
6. Add vault backup, rollback confirmation, restore/reload, and cleanup. The
  vault helper and UI rollback/cleanup controls are implemented; the future
  layout runner must call backup creation before its first save-enabled edit.
7. Add focused tests for pure metadata, geometry, queue/loop handling,
   indicator sync, edge geometry, and algorithm mapping (the repository has no
   Vitest setup yet; `syncIndicators`, edge binding and write-back, and the
   rollback order were verified with throwaway fake-EA smoke scripts);
   then run the repository check/build and an Obsidian smoke test covering
   modal lifecycle, closing the drawing with the workbench open, popout/mobile
   behavior, selection through indicators, indicator/content moves, parsing,
   save, rollback, and cancellation.

## 13. Acceptance Criteria for the First UI Slice

- Running the script immediately opens the primary floating modal.
- The modal contains the three sections, required labels/controls, disabled
  states, run metrics placeholders, and the credit line.
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
- `edges.ts`: pure conversion between lines and anchored edges (section 7.2).
- `layout.ts`: `writeGraphToScene`; not called by the UI until the layout runner
  exists.
- `ui.ts`: the `Workbench` runtime object (state, indicator registry, hydrated
  nodes, border preview, child modals) and all UI actions.

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
unsaved metadata transactions and preserve unrelated custom data. The current
Start action clears temporary indicators, saves the current scene once (by
round-tripping one element through `addElementsToView(..., save = true)`), and
then creates the backup; the future layout algorithm runner must retain that
ordering before its first layout mutation.

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
helpers; future algorithm position updates must convert graph positions back
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
- **Core typecheck**: `core/graph/generators.ts` passes `parentId: parentId ??
  undefined`, which `exactOptionalPropertyTypes` in this repository rejects, so
  `npm run typecheck` reports one error there. The build is not affected. The fix
  belongs in the simulation repository.
- **Duplicate border flags** are not repaired (roots are).
- **Rollback ends the workbench**, because the view and its script EA are
  destroyed. Re-opening it automatically would need a new EA for the reopened
  view (`window.ExcalidrawAutomate.getAPI(view)`), which the Script Engine would
  not destroy on close; the session's own hook-based teardown would have to be
  the only cleanup path.
