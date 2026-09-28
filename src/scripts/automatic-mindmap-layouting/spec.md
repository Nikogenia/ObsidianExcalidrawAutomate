# Automatic Mindmap Layouting

## Status

Draft specification for the ExcalidrawAutomate script. This document describes
the first implementation slice (the floating UI) and the contracts that later
graph parsing, layout, persistence, and evaluation code must satisfy.

## 1. Goal and Scope

The script automatically lays out an existing Excalidraw mindmap. It must
discover a tree from existing node and line elements, represent it as a
`TreeGraph`, run one of the layout algorithms from the linked `core` folder,
and write the resulting node positions back to the drawing.

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
  preview.svg                     Script preview asset
  README.md                       Script-facing documentation
  spec.md                         This implementation specification
  core/                            Symbolic link to the research engine
    graph/types.ts                TreeNode, TreeEdge, TreeGraph
    graph/evaluation.ts           Graph metrics and formatted metrics string
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
- UI metadata changes and temporary indicator transactions must not save the
  open drawing file. The only save-enabled transaction is the explicit save
  immediately before creating a backup for a layout run. This keeps preview,
  selection, and configuration work from unexpectedly writing the active file.
- Merge metadata with `ea.addAppendUpdateCustomData(id, patch)` so plugin or
  user metadata is preserved.
- Temporary indicators are scene elements only while the main modal is open.
  Every temporary element is marked with `isMindmapTemporary: true` and is
  deleted/cleaned up when the modal closes. Cleanup must also run on failure.
- Use the current view's document/window for DOM work and register listeners,
  timers, and observers with `ea.registerCleanup`.

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

Padding values are integers in `[-120, 120]`; the default is `0` for each
side. On startup, scan the current scene for `isMindmapBorder === true`, load
the element and valid padding into runtime state, and silently continue without
a preview if none exists. If multiple elements are marked, use the first
valid match deterministically, show a warning and remove the flag from the other elements.

### Root element

```ts
{
  isMindmapRoot: true,
  mindmapShape: "ellipse" | "rectangle",
  mindmapConnectionDistance: number,
  mindmapChildren: string[]
}
```

`mindmapConnectionDistance` is an integer in `[1, 300]` and defaults to `50`.
`mindmapShape` is the normalized `TreeNode.shape` value. The UI may label the
rectangle option `rect`, but graph data must use `rectangle`, matching the core
types and evaluation functions.

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

## 5. Primary Floating Modal

The main modal title is **Automatic Mindmap Layouting**. It is opened as soon
as the script runs. If no element is selected, the script still opens the UI;
selection-dependent actions explain their missing selection in the UI and do
not mutate the scene.

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
- Root selection uses the current canvas selection and must be unambiguous.
- An ambiguous Root selection shows a notice and does not mutate metadata.
- For a selected group, inspect its largest/boundary-like element and choose
  the shape that best matches the group's dimensions. Persist the chosen
  normalized shape with the Root metadata.
- Selecting or saving a Root immediately starts automatic parsing from that
  Root.
- Show a shape dropdown (`ellipse` / `rect`) and **Apply To Selection**. The
  action updates only selected elements already marked `isMindmapNode`, both in
  metadata and in their temporary indicators.
- Show Graph Statistics only after parsing, using
  `calculateGraphMetricsString(graph)`.
- Provide a Connection Distance input with slider and number field, constrained
  to `1..300`, defaulting to `50`. Save it in Root metadata and use it during
  line-endpoint matching.
- Provide **Parse Mindmap** to discard the current parsed graph and parse again
  from the configured Root.
- Provide **Clear Mindmap** to remove all Mindmap Node metadata from the current
  scene and discard the current parsed graph. This action does not remove the
  Border or Root flags, but it does remove node flags and parent/children
  metadata while preserving normalized shape metadata. Ask for confirmation in
  an Obsidian modal before clearing.
- Provide **Clear All Metadata** to remove all Mindmap metadata from the current
  scene, including Border and Root flags. Ask for confirmation in an Obsidian
  modal before clearing.

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
- **Rollback** asks for confirmation in an Obsidian modal, loads the newest
  backup for the current file into the main file, then removes that backup.
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
2. For ellipse nodes, use the ellipse boundary/intersection geometry rather
   than only an axis-aligned rectangle.
3. Resolve the opposite line endpoint to the nearest eligible canvas element.
4. Ignore the candidate if it is the current node, already queued, already
   parsed as a child of this parent, or would introduce a loop. A loop must not
   abort parsing of other branches.
5. Mark a newly accepted element as a node, infer `ellipse` or `rectangle`
   (but only if no shape data is already present in customData),
   store parent/children metadata, and append its ID to the parent's
   `mindmapChildren` array.
6. Add a `TreeNode` containing ID, center position, normalized shape, width,
   height, parent ID, and children IDs to the `TreeGraph`.
7. Add a temporary node indicator and a temporary small arrow toward its
   parent.

Continue until the queue pointer reaches its end and no new lines produce
nodes. Parsing must be deterministic: stable scene order and distance tie
breaks are preferred. It must never convert a line into a node or select a
temporary indicator as a candidate.

## 7. Graph and Algorithm Integration

Construct `TreeGraph(name, rootId, width, height)` using the padded border as
the available layout area. Use the root and every parsed node as `TreeNode`
instances; preserve actual element dimensions because mixed shapes are a core
research requirement. Positions are `p5.Vector` centers as required by the
core.

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

## 8. Evaluation and Best Layout

After parsing and after each rendered layout, calculate and display
`calculateGraphMetricsString(graph)`. This currently reports node count and
overlaps, edge count and crossings, node-edge overlaps, minimum angular
resolution, edge-length statistics, and node-distance statistics.

The core does not define an aggregate score. Until a weighting study is
approved, “best” means a Pareto improvement: fewer node overlaps, edge
crossings, and node-edge overlaps; higher minimum angular resolution; and an
edge/node-distance distribution appropriate to the available border area.
No automatic winner selection should be implemented in the first UI slice.
Future scoring must be explicit, configurable, and evaluated against the
research test graphs.

## 9. Temporary Indicators and Scene Transactions

Indicators use the same coordinates as the current scene, are moved to the
topmost scene z-index after each refresh, and are clearly distinguishable from
user content: red dashed padded Border, blue dashed Root, and green per-node
indicators/arrows. They must carry `isMindmapTemporary: true` in
`customData`. Their IDs are held in runtime state, not persisted in root/node
metadata.

Indicator refreshes must replace/delete the previous temporary set in one
coherent unsaved EA transaction (`addElementsToView(false, false)`). The
initial main-modal open refreshes configured border and root indicators before
the user opens any child settings modal. Closing the main modal deletes all temporary
elements, including indicators created by an open child modal. Closing or
cancelling Border Settings restores the last committed preview state.

Persistent metadata changes from the UI use
`await ea.addElementsToView(false, false)`. Before the first mutation of a
layout run, the current drawing is explicitly saved as part of backup
preparation; that is the sole save-enabled scene transaction. A failed
transaction must leave runtime state consistent and must not leave the EA
workbench dirty.

## 10. Backups and Rollback

Before the first mutation of a layout run, save the complete current drawing
file through the Obsidian vault API in a hidden folder named `mindmap-backup`
beside the current mindmap file. The backup name is:

```text
<current-file-name>.run<incrementing-number>.backup
```

The counter is the next available number for this current file in that folder;
it must be collision-safe. Backups contain the whole original file, not only
the selected elements. Never overwrite an existing backup.

Rollback selects the newest matching backup only after explicit confirmation,
restores it to the active file using the vault API, then deletes the consumed
backup. Handle missing files and write failures without deleting the only
recoverable backup. Clear backups matches the current file exactly and leaves
backups belonging to other drawings untouched.

The exact current vault path and safe active-view reload sequence must be
verified against the available Obsidian API before implementation. This is a
required design checkpoint, not permission to use an undocumented target-view
internals shortcut.

## 11. Lifecycle and Failure Behavior

- Verify the required Excalidraw plugin version before opening the modal.
- If the Excalidraw API or active target view is unavailable, stop cleanly with
  the existing notice pattern.
- Closing the modal cancels a running loop, removes listeners/timers, clears all
  temporary elements, and leaves the last committed persistent state intact.
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
4. Add `TreeGraph` construction and graph metrics display.
5. Add algorithm selection adapter, Step/Start/Reset controls, and run metrics.
6. Add vault backup, rollback confirmation, restore/reload, and cleanup.
7. Add focused tests for pure metadata, geometry, queue/loop handling, and
   algorithm mapping; then run the repository check/build and an Obsidian smoke
   test covering modal lifecycle, popout/mobile behavior, selection, parsing,
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
- The UI is implemented through documented EA/Obsidian APIs and does not
  mutate immutable scene elements directly.
- The spec's unresolved backup path/reload checkpoint is resolved before
  backup controls are implemented.

## 14. First-slice implementation notes

The current implementation includes import-safe metadata loading, group-aware
logical selection, unsaved indicator/metadata transactions, startup indicator
refresh, selection notices, debounced border previews, and compact modal
styling with a clickable credit link. The Border Settings modal uses the
documented default positioning; no CSS translation is applied. Border, Root,
parsed-node, and parent-arrow indicators are rebuilt
in one transaction; the border therefore remains visible for the full lifetime
of the main modal, including while Border Settings is open. All temporary
indicators continue to carry `isMindmapTemporary: true`; child border previews
replace the complete current set, including parsed node arrows, and all are
removed when the main modal closes.

The startup loader keeps the first root flag in stable scene order. If more
than one element is flagged as a root, the remaining root flags are removed in
one unsaved metadata transaction and a warning notice is shown. Selecting a new
root removes the previous root flags in the same transaction. The main modal
is rendered from current runtime state after each configuration or parse
change, so labels, graph counts, and indicator state do not remain stale.
Metadata actions are displayed in one row; Start, Step, and Reset share a row,
as do Rollback and Clear Backups.

The first parser slice is implemented in the import-safe `parser.ts` module.
It filters temporary and line elements, excludes the configured Border Element
and every member of its group, walks a queue with a read pointer,
uses ellipse-aware boundary distance checks, resolves the nearest eligible
canvas element in stable scene order, rejects queued and cyclic candidates,
and adds `TreeNode` instances parent-first to a `TreeGraph`. Parsed nodes
retain their actual bounds and normalized shape. Parsing persists parent and
children metadata, infers a missing shape, clears stale mindmap relationships,
and creates green node indicators with small arrows toward each parent. The
graph and indicator state are discarded and rebuilt when a new root is chosen
or parsing is run again.

Confirmed Clear Mindmap and Clear All Metadata actions are implemented through
unsaved metadata transactions and preserve unrelated custom data. The layout
algorithm runner and the backup/rollback API checkpoint remain subsequent
slices.
