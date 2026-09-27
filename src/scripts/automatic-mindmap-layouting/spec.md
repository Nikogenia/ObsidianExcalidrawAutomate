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
  commit one transaction with `await ea.addElementsToView()`.
- Merge metadata with `ea.addAppendUpdateCustomData(id, patch)` so plugin or
  user metadata is preserved.
- Temporary indicators are scene elements only while the main modal is open.
  Every temporary element is marked with `isMindmapTemporary: true` and is
  deleted/cleaned up when the modal closes. Cleanup must also run on failure.
- Use the current view's document/window for DOM work and register listeners,
  timers, and observers with `ea.registerCleanup`.

## 4. Persistent Metadata Contract

Metadata is stored on the relevant persistent element using merged
`customData`. IDs are always Excalidraw element IDs.

### Border element

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

- Show the current border element's type and ID, or `Not configured`.
- Provide **Configure border**, opening a second floating modal titled
  **Border Settings**.
- Border Settings shows the current candidate's type and ID and allows the
  user to choose a new border element from the current canvas selection. A
  selection must be unambiguous; otherwise the prior border remains unchanged.
- Provide four numeric controls: top, left, bottom, and right padding. Each
  control has a synchronized range slider and number field, constrained to
  `-120..120`.
- Update the border preview live while either slider or text field changes.
  **Save** writes the border flag and padding metadata in one persistent scene
  transaction. **Cancel** discards both element and padding changes.
- The preview is a red dashed rectangle at the padded border bounds. Negative
  padding expands the bounds and positive padding contracts them according to
  the named side. No-border startup is silent and has no preview.

#### Root and parser settings

- Show the configured root's type and ID. If absent, show **Select root
  element**.
- Root selection uses the current canvas selection and must be unambiguous.
- For a selected group, inspect its largest/boundary-like element and choose
  the shape that best matches the group's dimensions. Persist the chosen
  normalized shape with the root metadata.
- Selecting/saving a root immediately starts automatic parsing from that root.
- Show a shape dropdown (`ellipse` / `rect`) and **Apply to selection**. The
  action updates only selected elements already marked `isMindmapNode`, both in
  metadata and in their temporary indicators.
- Show graph statistics only after parsing, using
  `calculateGraphMetricsString(graph)`.
- Provide a connection-distance input with slider and number field, constrained
  to `1..300`, defaulting to `50`. Save it in root metadata and use it during
  line-endpoint matching.
- Provide **Parse Mindmap** to discard the current parsed graph and parse again
  from the configured root.
- Provide **Clear Mindmap** to remove all mindmap metadata from the current scene
  and discard the current parsed graph. This action does not remove the border
  or root flags, but it does remove all node flags and parent/children metadata.
  Ask for confirmation in an Obsidian modal before clearing.
- Provide **Clear All Metadata** to remove all mindmap metadata from the current scene, including border and root flags. Ask for confirmation in an Obsidian modal before clearing.

### 5.2 Algorithm

- Provide an algorithm dropdown. The first implementation exposes **Default**;
  the adapter must be designed for the concrete core algorithms later.
- Provide a steps-per-render input with slider and number field constrained to
  `1..1000`, default `1`.
- Reserve a clearly labeled options area for algorithm-specific controls.

### 5.3 Control

Provide **Start**, **Step**, **Reset**, **Rollback**, and **Clear backups**.

- **Start** runs the selected algorithm until completion or cancellation,
  rendering after the configured number of algorithm steps.
- **Step** performs one algorithm step and renders the result. This button is
  disabled if the algorithm wasn't started or reseted yet and isn't completed or running.
- **Reset** initializes execution from the parsed graph and resets run metrics;
  it does not discard user configuration.
- **Rollback** asks for confirmation in an Obsidian modal, loads the newest
  backup for the current file into the main file, then removes that backup.
- **Clear backups** removes all backups for the current file. If the backup
  folder is empty afterward, remove the folder as well.

Show current-run metrics: current step / total steps, and milliseconds per
step for now, minimum, average, and maximum. Disable controls when their
preconditions are not met (for example, no parsed graph or no active run).

At the bottom, show exactly:

> Nikolas Beyer | W-Seminar Informatik 2027 (Bodensee-Gymnasium Lindau) |
> [BOGYLI/simulierte-wirklichkeit](https://github.com/BOGYLI/simulierte-wirklichkeit/tree/nikolas/projects/nikolas)

## 6. Mindmap Parsing

Parsing is breadth-first and uses a queue plus a read pointer. All customData
except for `mindmapShape` shall be removed from all existing node elements before
parsing to ensure a clean starting state. The root is
inserted first; nodes are never removed from the queue. For each queued node:

1. Inspect line/arrow elements whose start or end is within the configured
   connection distance of the node boundary.
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

The selected implementation must satisfy `LayoutAlgorithm`:

```ts
initialize(graph): void
step(dt): boolean
isCompleted(): boolean
getGraph(): TreeGraph
```

An algorithm adapter maps graph node positions back to the corresponding
Excalidraw elements while preserving shape, dimensions, metadata, and IDs.
`dt` and the meaning of total steps must be defined by the chosen algorithm;
the UI's steps-per-render value is a rendering batch size, not a hidden change
to algorithm semantics.

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

Indicators use the same coordinates as the current scene and are clearly
distinguishable from user content: red dashed padded border, blue dashed root,
and green per-node indicators/arrows. They must carry `isMindmapTemporary: true` in
`customData`. Their IDs are held in runtime state, not persisted in root/node
metadata.

Indicator refreshes must replace/delete the previous temporary set in one
coherent EA transaction. Closing the main modal deletes all temporary
elements, including indicators created by an open child modal. Closing or
cancelling Border Settings restores the last committed preview state.

Persistent metadata and layout changes are committed with
`await ea.addElementsToView()`. A failed transaction must leave runtime state
consistent and must not leave the EA workbench dirty.

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
  parser initially returns an empty graph.
- Closing the primary modal removes every temporary element marked with
  `isMindmapTemporary`.
- The UI is implemented through documented EA/Obsidian APIs and does not
  mutate immutable scene elements directly.
- The spec's unresolved backup path/reload checkpoint is resolved before
  backup controls are implemented.
