import {
    clearIndicatorsNow,
    createIndicatorState,
    resolveIndicatorOwners,
    syncIndicators,
    type IndicatorModel,
    type IndicatorNode,
    type IndicatorState,
} from "./indicators";
import {
    DEFAULT_CONNECTION_DISTANCE,
    DEFAULT_RENDERING_DISTANCE,
    MAX_RENDERING_DISTANCE,
    DEFAULT_PADDING,
    isFixedFlagged,
    loadRuntimeState,
    normalizeShape,
    shapeOf,
    type MindmapPadding,
    type MindmapRuntimeState,
} from "./metadata";
import { normalizeBoundText, resolveAnchor, resolveAnchorId, resolveLogicalSelection, type LogicalElement } from "./groups";
import { loadMindmapFromMetadata, mindmapName, parseMindmap, resolveFixedElements, type ParsedMindmap } from "./parser";
import { edgeMetadata } from "./edges";
import { writeGraphToScene, type ReparseCheck, type WriteDistances } from "./layout";
import { fitTextWidths } from "./textfit";
import {
    ADVANCED_PARAMETERS,
    ALGORITHM_OPTIONS,
    applyInitialLayout,
    createLayoutAlgorithm,
    defaultAlgorithmSettings,
    ALGORITHM_SETTINGS_KEY,
    applyStoredSettings,
    INITIAL_LAYOUT_PARAMETERS,
    isBooleanParameter,
    parameterTooltipText,
    readStoredSettings,
    sameStoredSettings,
    toStoredSettings,
    PRIMARY_PARAMETERS,
    STEPS_FINISHED,
    stepsPerRenderLimit,
    type AlgorithmId,
    type AlgorithmSettings,
    type Parameter,
    type StoredAlgorithmSettings,
} from "./algorithm";
import { contentVersion, LayoutRun, stepTimings, type RunHooks } from "./runner";
import { calculateTreeEdgeGraphMetricsString } from "./core/graph/evaluationEdge";
import {
    backupCreatedAt,
    clearMindmapBackups,
    closeViewsOfFile,
    createMindmapBackup,
    listMindmapBackups,
    rollbackMindmapBackup,
    type MindmapBackup,
} from "./backup";
import { saveCurrentDrawing, saveMetadata, type MetadataPatch } from "./scene";
import { WorkbenchSession, type TeardownReason } from "./session";
import {
    addActions,
    addButton,
    addCheckbox,
    addPlainText,
    addRangePair,
    addRow,
    addSection,
    addSelect,
    addSpacer,
    addText,
    disableControls,
} from "./dom";

type Notify = (message: string, durationMs?: number) => void;

/** Notices stay longer than Obsidian's short default, so results can be read while working on the canvas. */
const NOTICE_MS = 8000;
/** Warnings that ask the user to act stay longer still. */
const WARNING_NOTICE_MS = 12000;
type WorkspaceLeaf = WorkbenchSession["view"]["leaf"];

interface ProgressElements {
    steps: HTMLElement;
    timings: HTMLElement;
    status: HTMLElement;
}

/** Runtime state of one open workbench. */
interface Workbench {
    ea: ExcalidrawAutomate;
    session: WorkbenchSession;
    state: MindmapRuntimeState;
    indicators: IndicatorState;
    /** Parsed nodes, always re-derived from persisted metadata (see `hydrate`). */
    nodes: IndicatorNode[];
    /** Anchor IDs of fixed elements, re-derived from metadata like `nodes`. */
    fixedIds: string[];
    /** Uncommitted Border Settings candidate shown instead of the saved border. */
    borderPreview?: { borderId?: string; padding: MindmapPadding };
    childModals: Set<{ close: () => void }>;
    statsEl?: HTMLElement;
    progressEls?: ProgressElements;
    /** Controls whose state follows settings and scene changes without a re-render (`updateControls`). */
    controls?: { start?: HTMLButtonElement; restoreStored?: HTMLButtonElement; save?: HTMLButtonElement };
    /** Mindmap parameters stored on the root (`mindmapAlgorithmSettings`), re-read by `hydrate`. */
    storedSettings?: StoredAlgorithmSettings | undefined;
    presence: string;
    /** Pending debounced saves of the root distance settings (`saveRootDistance`). */
    distanceTimers: Partial<Record<RootDistanceKey, number>>;
    settings: AlgorithmSettings;
    /** Current or last layout run; a stopped, unfinished run can be continued. */
    run?: LayoutRun;
    /** True while Start, Step, or Reset owns the scene; refreshes and other actions pause. */
    busy: boolean;
    runStatus: string;
    notify: Notify;
    render: () => void;
}

const NODE_KEYS = ["isMindmapNode", "mindmapParent", "mindmapChildren", "isMindmapEdge", "mindmapEdge"];
const ALL_KEYS = ["isMindmapBorder", "mindmapPadding", "isMindmapRoot", "mindmapShape", "mindmapConnectionDistance", "mindmapRenderingConnectionDistance", "isMindmapFixed", ALGORITHM_SETTINGS_KEY, ...NODE_KEYS];
const DEBOUNCE_MS = 120;
const LABEL_WIDTH = "13em";

function customData(element: ExcalidrawElement): Record<string, unknown> {
    return (element.customData as Record<string, unknown> | undefined) ?? {};
}

function isNode(element: ExcalidrawElement): boolean {
    return customData(element).isMindmapNode === true;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function confirmAction(
    ea: ExcalidrawAutomate,
    message: string,
    action: () => Promise<void>,
): void {
    const modal = new ea.obsidian.Modal(ea.plugin.app);
    modal.onOpen = () => {
        modal.contentEl.empty();
        addText(modal.contentEl, message);
        const actions = addActions(modal.contentEl);
        addButton(actions, "Confirm").addEventListener("click", () => {
            modal.close();
            void action();
        });
        addButton(actions, "Cancel").addEventListener("click", () => modal.close());
    };
    modal.open();
}

function logicalLabel(element: LogicalElement | undefined): string {
    return element ? `${element.anchor.type} (${element.anchor.id})` : "Not Configured";
}

function styleModalContent(content: HTMLElement, modal: HTMLElement, width: string): void {
    content.style.fontSize = "0.9em";
    content.style.display = "flex";
    content.style.flexDirection = "column";
    content.style.gap = "0.5em";
    modal.style.width = `min(${width}, 80vw)`;
}

function addCredit(parent: HTMLElement): void {
    const credit = parent.ownerDocument.createElement("p");
    credit.style.fontSize = "0.8em";
    credit.style.margin = "0.8em 0 0";
    credit.style.opacity = "0.75";
    credit.append("Nikolas Beyer | W-Seminar Informatik 2027 (Bodensee-Gymnasium Lindau) | ");
    const link = parent.ownerDocument.createElement("a");
    link.href = "https://github.com/BOGYLI/simulierte-wirklichkeit/tree/nikolas/projects/nikolas";
    link.textContent = "BOGYLI/simulierte-wirklichkeit";
    link.target = "_blank";
    credit.appendChild(link);
    parent.appendChild(credit);
}

function reportError(wb: Workbench, message: string, error: unknown): void {
    console.error(`[Automatic Mindmap Layouting] ${message}`, error);
    wb.notify(message);
}

/** Current selection with indicators replaced by their owners. */
function selectedOwners(wb: Workbench): { selection: ExcalidrawElement[]; scene: readonly ExcalidrawElement[] } {
    const scene = wb.ea.getViewElements();
    return { selection: resolveIndicatorOwners(wb.ea.getViewSelectedElements(), scene), scene };
}

/**
 * Resolves the canvas selection to one logical element. Selected indicators
 * count as their content, so a click on an indicator selects its node.
 */
function selectedLogical(wb: Workbench): LogicalElement | undefined {
    const { selection, scene } = selectedOwners(wb);
    return resolveLogicalSelection(wb.ea, selection, scene);
}

/** Resolves every selected element (or indicator) to its logical element, once per anchor. */
function selectedLogicals(wb: Workbench): LogicalElement[] {
    const { selection, scene } = selectedOwners(wb);
    const logicals = new Map<string, LogicalElement>();
    for (const element of normalizeBoundText(selection, scene)) {
        const logical = resolveAnchor(wb.ea, element, scene);
        if (logical) logicals.set(logical.anchor.id, logical);
    }
    return [...logicals.values()];
}

/** Returns the anchors of all selected mindmap nodes, selected directly or via an indicator. */
function selectedNodeAnchors(wb: Workbench): ExcalidrawElement[] {
    return selectedLogicals(wb).map((logical) => logical.anchor).filter(isNode);
}

function indicatorModel(wb: Workbench): IndicatorModel {
    const preview = wb.borderPreview;
    const borderId = preview ? preview.borderId : wb.state.borderId;
    return {
        ...(borderId ? { borderId } : {}),
        padding: preview?.padding ?? wb.state.padding,
        ...(wb.state.rootId ? { rootId: wb.state.rootId } : {}),
        nodes: wb.nodes,
        fixedIds: wb.fixedIds,
    };
}

/** Loads a new graph from metadata and the live scene, or undefined without root and border. */
function loadMindmap(wb: Workbench): ParsedMindmap | undefined {
    const scene = wb.ea.getViewElements();
    const border = resolveAnchorId(wb.ea, wb.state.borderId, scene);
    const root = resolveAnchorId(wb.ea, wb.state.rootId, scene);
    return border && root ? loadMindmapFromMetadata(wb.ea, root, border, wb.state.padding, mindmapName(wb.session.file.basename)) : undefined;
}

/**
 * Rebuilds the graph and the node list from persisted metadata and the live
 * scene. Metadata is the single source of truth, so moved content updates the
 * graph positions and deleted content drops out of the graph (with its subtree,
 * until the next parse). Fixed elements are shown even before a root and a
 * border exist.
 */
function readRootSettings(wb: Workbench): StoredAlgorithmSettings | undefined {
    const root = wb.state.rootId ? wb.ea.getViewElements().find((element) => element.id === wb.state.rootId) : undefined;
    return root ? readStoredSettings(customData(root)[ALGORITHM_SETTINGS_KEY]) : undefined;
}

function hydrate(wb: Workbench): void {
    wb.storedSettings = readRootSettings(wb);
    const loaded = loadMindmap(wb);
    if (!loaded) {
        const scene = wb.ea.getViewElements();
        delete wb.state.mindmap;
        wb.nodes = [];
        wb.fixedIds = [...resolveFixedElements(wb.ea, scene, resolveAnchorId(wb.ea, wb.state.borderId, scene)).keys()];
        return;
    }
    wb.state.mindmap = loaded;
    wb.fixedIds = loaded.fixedIds;
    wb.nodes = loaded.nodes.slice(1).map((logical) => {
        const node = loaded.graph.getNode(logical.anchor.id);
        return {
            id: logical.anchor.id,
            ...(node?.parentId ? { parentId: node.parentId } : {}),
            shape: node?.shape === "ellipse" ? "ellipse" : "rectangle",
        };
    });
}

function presenceKey(wb: Workbench): string {
    const scene = wb.ea.getViewElements();
    const has = (id: string | undefined): boolean => Boolean(id && scene.some((element) => element.id === id));
    return JSON.stringify([has(wb.state.borderId), has(wb.state.rootId), Boolean(wb.state.mindmap), scene.some(isNode), wb.fixedIds.length]);
}

/** The graph shown in the statistics: the run's live graph while it owns the scene. */
function displayedGraph(wb: Workbench): ParsedMindmap["graph"] | undefined {
    return wb.busy && wb.run ? wb.run.mindmap.graph : wb.state.mindmap?.graph;
}

function statsHtml(wb: Workbench): string {
    const graph = displayedGraph(wb);
    return graph
        ? `Graph Statistics:<br>${calculateTreeEdgeGraphMetricsString(graph).replace(/\n/g, "<br>")}`
        : "Graph Statistics: Available after parsing";
}

/** True when a parsed graph with at least one non-root node exists. */
function graphReady(wb: Workbench): boolean {
    return Boolean(wb.state.mindmap) && wb.nodes.length > 0;
}

/**
 * Re-derives graph and indicators from the scene. Runs after every debounced
 * scene change, so moving or deleting content (or an indicator) is reflected
 * immediately. Re-renders the modal only when border/root/graph presence
 * changed; otherwise only the statistics text is updated. Skipped while a run
 * owns the scene: the run keeps its own graph and its writes would otherwise
 * replace it (spec 7.3).
 */
async function refresh(wb: Workbench): Promise<void> {
    if (wb.busy) return;
    try {
        await wb.session.run(async () => {
            hydrate(wb);
            const result = await syncIndicators(wb.ea, wb.indicators, indicatorModel(wb));
            if (result.contentMoved) hydrate(wb);
        });
    } catch (error) {
        reportError(wb, "Could not update the mindmap indicators.", error);
    }
    if (!wb.session.alive || wb.busy) return;
    if (presenceKey(wb) !== wb.presence) wb.render();
    else {
        if (wb.statsEl) wb.statsEl.innerHTML = statsHtml(wb);
        updateControls(wb);
    }
}

async function repairRootFlags(wb: Workbench): Promise<void> {
    const roots = wb.ea.getViewElements().filter((element) => customData(element).isMindmapRoot === true);
    if (roots.length <= 1) return;
    const remove = roots.slice(1);
    await saveMetadata(wb.ea, remove.map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined } })));
    wb.state.rootId = roots[0].id;
    wb.notify("Multiple Mindmap Roots Found; Kept the First Root and Removed the Other Root Flags.");
}

function parsePatches(wb: Workbench, parsed: ReturnType<typeof parseMindmap>): MetadataPatch[] {
    const parsedIds = new Set(parsed.nodes.map((node) => node.anchor.id));
    const parsedLineIds = new Set([...parsed.edges.values()].map((binding) => binding.lineId));
    const scene = wb.ea.getViewElements();
    const stale = scene
        .filter((element) => isNode(element) && !parsedIds.has(element.id) && element.id !== wb.state.rootId)
        .map((element) => ({ id: element.id, patch: { isMindmapNode: undefined, mindmapParent: undefined, mindmapChildren: undefined } }));
    const staleLines = scene
        .filter((element) => customData(element).isMindmapEdge === true && !parsedLineIds.has(element.id))
        .map((element) => ({ id: element.id, patch: { isMindmapEdge: undefined, mindmapEdge: undefined } }));
    const lines = [...parsed.edges.values()].map((binding) => ({
        id: binding.lineId,
        patch: { isMindmapEdge: true, mindmapEdge: edgeMetadata(parsed.graph.getEdge(binding.childId)!, binding) },
    }));
    const nodes = parsed.nodes.map((node) => {
        const graphNode = parsed.graph.getNode(node.anchor.id)!;
        return {
            id: node.anchor.id,
            patch: {
                isMindmapNode: true,
                mindmapParent: graphNode.parentId,
                mindmapChildren: [...graphNode.children],
                ...(customData(node.anchor).mindmapShape === undefined ? { mindmapShape: shapeOf(node.anchor) } : {}),
            },
        };
    });
    return [...stale, ...staleLines, ...nodes, ...lines];
}

/** Parses from the configured root, persists the result, and refreshes indicators. */
async function parseCurrentMindmap(wb: Workbench): Promise<void> {
    const { ea, state } = wb;
    try {
        await wb.session.run(async () => {
            const scene = ea.getViewElements();
            const root = resolveAnchorId(ea, state.rootId, scene);
            const border = resolveAnchorId(ea, state.borderId, scene);
            if (!root) return wb.notify("Select a Root Element before parsing.");
            if (!border) return wb.notify("Configure a Border before parsing.");
            const parsed = parseMindmap(ea, root, state.connectionDistance, border, state.padding, mindmapName(wb.session.file.basename));
            await saveMetadata(ea, parsePatches(wb, parsed));
            hydrate(wb);
            await syncIndicators(ea, wb.indicators, indicatorModel(wb));
            return wb.notify(`Mindmap parsed: ${plural(parsed.nodes.length, "node")}, ${plural(parsed.edges.size, "edge")}.`);
        });
    } catch (error) {
        reportError(wb, "Could not parse the mindmap.", error);
    }
    if (wb.session.alive) wb.render();
}

async function selectRoot(wb: Workbench): Promise<void> {
    const selected = selectedLogical(wb);
    if (!selected) {
        wb.notify("Root selection must contain one element or one complete group (or its indicator).");
        return;
    }
    const shape = shapeOf(selected.anchor);
    await wb.session.run(async () => {
        const oldRoots = wb.ea.getViewElements()
            .filter((element) => customData(element).isMindmapRoot === true && element.id !== selected.anchor.id);
        // Stored parameters follow the root unless the new root brings its own.
        const keepOwn = readStoredSettings(customData(selected.anchor)[ALGORITHM_SETTINGS_KEY]) !== undefined;
        const moved = keepOwn ? undefined : wb.storedSettings;
        await saveMetadata(wb.ea, [
            ...oldRoots.map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined, [ALGORITHM_SETTINGS_KEY]: undefined } })),
            {
                id: selected.anchor.id,
                patch: {
                    isMindmapRoot: true,
                    isMindmapNode: true,
                    // The core does not keep the root in place by itself; fix it on selection, Unfix Selection releases it.
                    isMindmapFixed: true,
                    mindmapShape: shape,
                    mindmapConnectionDistance: wb.state.connectionDistance,
                    mindmapRenderingConnectionDistance: wb.state.renderingDistance,
                    mindmapChildren: [],
                    ...(moved ? { [ALGORITHM_SETTINGS_KEY]: moved } : {}),
                },
            },
        ]);
        wb.state.rootId = selected.anchor.id;
        wb.state.rootShape = shape;
    });
    wb.notify("Root Element saved and fixed.");
    await parseCurrentMindmap(wb);
}

async function applyShape(wb: Workbench, value: string): Promise<void> {
    const shape = normalizeShape(value);
    const anchors = selectedNodeAnchors(wb);
    if (anchors.length === 0) {
        wb.notify("Select at least one parsed mindmap node (or its indicator).");
        return;
    }
    await wb.session.run(async () => {
        await saveMetadata(wb.ea, anchors.map((element) => ({ id: element.id, patch: { mindmapShape: shape } })));
        if (anchors.some((element) => element.id === wb.state.rootId)) wb.state.rootShape = shape;
    });
    await refresh(wb);
    wb.notify(`Shape "${shape}" applied to ${plural(anchors.length, "node")}.`);
}

/**
 * Adds or removes the fixed flag (`isMindmapFixed`) on the selected logical
 * elements. The flag is stored on the anchor; removing also clears flags left
 * on other group members. The border and lines cannot be fixed nodes.
 */
async function setSelectionFixed(wb: Workbench, fixed: boolean): Promise<void> {
    const scene = wb.ea.getViewElements();
    const borderIds = new Set(resolveAnchorId(wb.ea, wb.state.borderId, scene)?.elements.map((element) => element.id));
    const logicals = selectedLogicals(wb).filter((logical) =>
        logical.anchor.type !== "line" && logical.anchor.type !== "arrow"
        && !logical.elements.some((element) => borderIds.has(element.id)));
    if (logicals.length === 0) {
        wb.notify("Select at least one element or group (not the border or a line).");
        return;
    }
    const patches: MetadataPatch[] = fixed
        ? logicals.filter((logical) => !isFixedFlagged(logical.anchor)).map((logical) => ({ id: logical.anchor.id, patch: { isMindmapFixed: true } }))
        : logicals.flatMap((logical) => logical.elements.filter(isFixedFlagged).map((element) => ({ id: element.id, patch: { isMindmapFixed: undefined } })));
    const changed = new Set(fixed ? patches.map(({ id }) => id) : logicals.filter((logical) => logical.elements.some(isFixedFlagged)).map((logical) => logical.anchor.id));
    try {
        if (patches.length > 0) await wb.session.run(() => saveMetadata(wb.ea, patches));
    } catch (error) {
        reportError(wb, "Could not save the fixed nodes.", error);
        return;
    }
    await refresh(wb);
    if (fixed) wb.notify(changed.size > 0 ? `${plural(changed.size, "element")} fixed.` : "The selected elements are already fixed.");
    else wb.notify(changed.size > 0 ? `${plural(changed.size, "element")} no longer fixed.` : "None of the selected elements is fixed.");
}

async function fitSelectedTextWidths(wb: Workbench): Promise<void> {
    const { selection } = selectedOwners(wb);
    const texts = selection.filter((element) =>
        element.type === "text" && !(element as ExcalidrawElement & { containerId?: string | null }).containerId);
    if (texts.length === 0) {
        wb.notify("Select at least one text element that is not inside a container.");
        return;
    }
    try {
        const result = await wb.session.run(() => fitTextWidths(wb.ea, texts));
        if (!result) return;
        const parts = [`${plural(result.fitted, "text box")} narrowed`];
        if (result.unchanged > 0) parts.push(`${result.unchanged} already minimal`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped (line breaks could not be kept)`);
        wb.notify(`${parts.join(", ")}.`);
    } catch (error) {
        reportError(wb, "Could not fit the text widths.", error);
    }
}

/**
 * Copies the serialized current graph (the same JSON that Parse Mindmap logs:
 * nodes, anchored edges, fixed flags, graph name) to the clipboard, for
 * example to add it to the research repository's examples. Uses the hydrated
 * graph, or the run's live graph while a run owns the scene.
 */
async function exportGraphToClipboard(wb: Workbench, doc: Document): Promise<void> {
    const graph = displayedGraph(wb);
    if (!graph) {
        wb.notify("Parse the mindmap first; there is no graph to export.");
        return;
    }
    const serialized = graph.serialize();
    try {
        await (doc.defaultView ?? window).navigator.clipboard.writeText(serialized);
    } catch (error) {
        reportError(wb, "Could not copy the graph to the clipboard.", error);
        return;
    }
    wb.notify(`Graph "${graph.name}" copied to the clipboard: ${plural(graph.nodes.size, "node")}, ${(serialized.length / 1024).toFixed(1)} KB.`);
}

/** Root keys of the Parsing and the Rendering Connection Distance. */
type RootDistanceKey = "mindmapConnectionDistance" | "mindmapRenderingConnectionDistance";

/** Applies a distance setting at once and stores it on the root after a debounce. */
function saveRootDistance(wb: Workbench, key: RootDistanceKey, value: number): void {
    if (key === "mindmapConnectionDistance") wb.state.connectionDistance = value;
    else wb.state.renderingDistance = value;
    const pending = wb.distanceTimers[key];
    if (pending !== undefined) window.clearTimeout(pending);
    wb.distanceTimers[key] = window.setTimeout(() => {
        delete wb.distanceTimers[key];
        const rootId = wb.state.rootId;
        if (!rootId) return;
        void wb.session.run(() => saveMetadata(wb.ea, [{ id: rootId, patch: { [key]: value } }]));
    }, DEBOUNCE_MS);
}

/** Line distances of a write-back: the parse to keep intact and the gap at nodes without outline. */
function writeDistances(wb: Workbench): WriteDistances {
    return { parsing: wb.state.connectionDistance, rendering: wb.state.renderingDistance };
}

async function clearMindmapMetadata(wb: Workbench, clearAll: boolean): Promise<void> {
    const keys = clearAll ? ALL_KEYS : NODE_KEYS;
    await wb.session.run(async () => {
        const patches = wb.ea.getViewElements()
            .filter((element) => keys.some((key) => customData(element)[key] !== undefined))
            .map((element) => ({ id: element.id, patch: Object.fromEntries(keys.map((key) => [key, undefined])) as MetadataPatch["patch"] }));
        if (patches.length > 0) await saveMetadata(wb.ea, patches);
        if (clearAll) {
            delete wb.state.borderId;
            delete wb.state.rootId;
            wb.state.padding = { ...DEFAULT_PADDING };
            wb.state.connectionDistance = DEFAULT_CONNECTION_DISTANCE;
            wb.state.renderingDistance = DEFAULT_RENDERING_DISTANCE;
        }
    });
    await refresh(wb);
    if (wb.session.alive) wb.render();
    wb.notify(clearAll ? "All mindmap metadata cleared." : "Mindmap node and edge metadata cleared.");
}

// LAYOUT RUNS

/**
 * Removes the indicators, saves the drawing, and copies the file into a new
 * backup. Every layout change (Start, Step, Reset) is preceded by this; a
 * failed backup cancels the layout change.
 */
async function createRunBackup(wb: Workbench): Promise<boolean> {
    try {
        const backup = await wb.session.run(async () => {
            clearIndicatorsNow(wb.session.api, wb.indicators);
            await saveCurrentDrawing(wb.ea);
            return createMindmapBackup(wb.session.app, wb.session.file);
        });
        if (!backup) return false;
        wb.notify(`Mindmap backup created: ${backup.file.name}`);
        return true;
    } catch (error) {
        reportError(wb, "Could not create the mindmap backup; the layout was not changed.", error);
        return false;
    }
}

/** A stopped run may continue only if nobody changed the drawing since its last write. */
function continuableRun(wb: Workbench): LayoutRun | undefined {
    const run = wb.run;
    if (!run || run.running || run.completed) return undefined;
    return run.writtenVersion === contentVersion(wb.ea.getViewElements()) ? run : undefined;
}

/** Discards a stopped run, for example after its parameters changed. */
function invalidateRun(wb: Workbench): void {
    if (wb.run && !wb.run.running) delete wb.run;
    updateControls(wb);
}

/** Start label: Stop while running, Resume while the stopped run can be continued, otherwise Start. */
function startLabel(wb: Workbench): string {
    if (wb.run?.running) return "Stop";
    return !wb.settings.resetBeforeStart && continuableRun(wb) ? "Resume" : "Start";
}

/**
 * Updates the controls that depend on settings and on the scene without
 * rebuilding the modal (sliders keep their drag state): the Start/Resume label
 * and the two mindmap parameter buttons.
 */
function updateControls(wb: Workbench): void {
    const controls = wb.controls;
    if (!controls || !wb.session.alive) return;
    if (controls.start) controls.start.textContent = startLabel(wb);
    const same = wb.storedSettings !== undefined && sameStoredSettings(toStoredSettings(wb.settings), wb.storedSettings);
    if (controls.save) controls.save.disabled = !wb.state.rootId || same;
    if (controls.restoreStored) controls.restoreStored.disabled = !wb.storedSettings || same;
}

/**
 * Stores the current algorithm settings on the root. Only the root's metadata
 * changes, so a stopped run stays continuable.
 */
async function saveMindmapParameters(wb: Workbench): Promise<void> {
    const rootId = wb.state.rootId;
    if (!rootId) {
        wb.notify("Select a Root Element first; the mindmap parameters are stored on the root.");
        return;
    }
    const stored = toStoredSettings(wb.settings);
    const resumable = continuableRun(wb);
    try {
        await wb.session.run(async () => {
            await saveMetadata(wb.ea, [{ id: rootId, patch: { [ALGORITHM_SETTINGS_KEY]: stored } }]);
            if (resumable) resumable.writtenVersion = contentVersion(wb.ea.getViewElements());
        });
    } catch (error) {
        reportError(wb, "Could not save the mindmap parameters.", error);
        return;
    }
    wb.storedSettings = stored;
    updateControls(wb);
    wb.notify("Mindmap parameters saved to the root element.");
}

function restoreSettings(wb: Workbench, stored: StoredAlgorithmSettings, message: string): void {
    wb.settings = applyStoredSettings(wb.settings, stored);
    invalidateRun(wb);
    wb.render();
    wb.notify(message);
}

function runHooks(wb: Workbench, run: LayoutRun): RunHooks {
    return {
        stepsPerRender: () => stepsPerRenderLimit(wb.settings),
        render: async () => {
            if (!wb.session.alive) return false;
            const written = await wb.session.run(async () => {
                run.reparse = await writeGraphToScene(wb.ea, run.mindmap, writeDistances(wb));
                run.writtenVersion = contentVersion(wb.ea.getViewElements());
                return true;
            });
            return written === true && wb.session.alive;
        },
        progress: () => updateProgress(wb),
    };
}

/**
 * Prepares a new run on the current layout: backup, new graph from metadata,
 * optionally the initial layout (Reset Before Start), and the initialized
 * algorithm.
 */
async function createRun(wb: Workbench, withReset: boolean): Promise<LayoutRun | undefined> {
    if (!await createRunBackup(wb)) return undefined;
    const mindmap = loadMindmap(wb);
    if (!mindmap) {
        wb.notify("Configure a Border and a Root and parse the mindmap first.");
        return undefined;
    }
    if (withReset) applyInitialLayout(mindmap.graph, wb.settings);
    return new LayoutRun(createLayoutAlgorithm(mindmap.graph, wb.settings), mindmap);
}

/** Owns the scene for the duration of `action`, then restores indicators and the UI. */
async function withBusy(wb: Workbench, action: () => Promise<void>): Promise<void> {
    if (wb.busy) return;
    wb.busy = true;
    wb.render();
    try {
        await action();
    } finally {
        wb.busy = false;
        if (wb.session.alive) {
            await refresh(wb);
            wb.render();
        }
    }
}

/**
 * Warns when the written layout would not parse back to the same tree even
 * after the line ends were adjusted (`layout.ts: ensureReparsable`). Adjusted
 * lines alone are normal and stay silent.
 */
function notifyReparse(wb: Workbench, check: ReparseCheck | undefined): void {
    if (!check || check.failed.length === 0) return;
    wb.notify(`Warning: Parse Mindmap would not recover ${plural(check.failed.length, "edge")} of this layout`
        + " (nodes too close for the Parsing Connection Distance). Keep using the stored structure or adjust the lines by hand.", WARNING_NOTICE_MS);
}

function runSummary(run: LayoutRun): string {
    return `step ${run.algorithm.currentIteration} / ${run.algorithm.iterations}`;
}

/**
 * Start: runs nikogenia v1 on the current layout (initiation mode "none") until
 * it completes or Stop is pressed. A stopped run continues where it stopped as
 * long as the drawing was not changed meanwhile; otherwise, and with Reset
 * Before Start, a new run (with a new backup) begins. While running, the Start
 * button is Stop.
 */
async function toggleStart(wb: Workbench): Promise<void> {
    if (wb.run?.running) {
        wb.run.stop();
        return;
    }
    await withBusy(wb, async () => {
        try {
            const resumed = wb.settings.resetBeforeStart ? undefined : continuableRun(wb);
            let run = resumed;
            if (run) {
                await wb.session.run(async () => clearIndicatorsNow(wb.session.api, wb.indicators));
            } else {
                wb.runStatus = "Preparing...";
                updateProgress(wb);
                run = await createRun(wb, wb.settings.resetBeforeStart);
                if (!run) return;
                wb.run = run;
            }
            wb.runStatus = "Running";
            wb.notify(resumed ? `Layout run continued at ${runSummary(run)}.` : "Layout run started.");
            // `run` marks itself running synchronously, so this render already shows Stop.
            const running = run.run(runHooks(wb, run));
            wb.render();
            const outcome = await running;
            if (!wb.session.alive) return;
            wb.runStatus = outcome === "completed" ? "Completed" : `Stopped at ${runSummary(run)}`;
            wb.notify(outcome === "completed" ? "Layout run completed." : `Layout run stopped at ${runSummary(run)}.`);
            notifyReparse(wb, run.reparse);
        } catch (error) {
            wb.run?.stop();
            wb.runStatus = "Failed";
            reportError(wb, "The layout run failed.", error);
        }
    });
}

/** Step: one algorithm step of the stopped run, or of a new run on the current layout. */
async function stepOnce(wb: Workbench): Promise<void> {
    await withBusy(wb, async () => {
        try {
            let run = continuableRun(wb);
            if (run) {
                await wb.session.run(async () => clearIndicatorsNow(wb.session.api, wb.indicators));
            } else {
                run = await createRun(wb, false);
                if (!run) return;
                wb.run = run;
            }
            await run.step(runHooks(wb, run));
            wb.runStatus = run.completed ? "Completed" : `Paused at ${runSummary(run)}`;
            notifyReparse(wb, run.reparse);
        } catch (error) {
            wb.runStatus = "Failed";
            reportError(wb, "The layout step failed.", error);
        }
    });
}

/**
 * Reset: replaces the layout with the initial layout (radial area weighted,
 * then rotated and fitted to the border area). The next Start optimizes it.
 */
async function resetLayout(wb: Workbench): Promise<void> {
    await withBusy(wb, async () => {
        try {
            if (!await createRunBackup(wb)) return;
            const mindmap = loadMindmap(wb);
            if (!mindmap) {
                wb.notify("Configure a Border and a Root and parse the mindmap first.");
                return;
            }
            applyInitialLayout(mindmap.graph, wb.settings);
            delete wb.run;
            const reparse = await wb.session.run(() => writeGraphToScene(wb.ea, mindmap, writeDistances(wb)));
            wb.runStatus = "Initial layout applied";
            wb.notify("Initial layout applied (radial, area weighted).");
            notifyReparse(wb, reparse);
        } catch (error) {
            wb.runStatus = "Failed";
            reportError(wb, "Could not apply the initial layout.", error);
        }
    });
}

function updateProgress(wb: Workbench): void {
    const elements = wb.progressEls;
    if (!elements || !wb.session.alive) return;
    const algorithm = wb.run?.algorithm;
    elements.steps.textContent = algorithm
        ? `Current Step / Total Steps: ${algorithm.currentIteration} / ${algorithm.iterations} (${algorithm.phase})`
        : "Current Step / Total Steps: - / -";
    elements.timings.textContent = `Milliseconds Per Step: ${algorithm ? stepTimings(algorithm) : "Now - | Min - | Average - | Max -"}`;
    elements.status.textContent = algorithm
        ? `Status: ${wb.runStatus} | Gap ${algorithm.getGap().toFixed(1)} | Step Length ${algorithm.getStepLength().toFixed(2)} | Max Move ${algorithm.lastMaxMove.toFixed(2)} | Anchor Repairs ${algorithm.anchorRepairs}`
        : `Status: ${wb.runStatus}`;
    if (wb.statsEl) wb.statsEl.innerHTML = statsHtml(wb);
}

// BACKUPS

/**
 * Restores a backup by closing every view of the drawing, writing the file,
 * and reopening it in the original leaf. The workbench ends, because its EA is
 * destroyed together with the closed view.
 */
async function rollback(wb: Workbench, backup: MindmapBackup): Promise<void> {
    const { app, file } = wb.session;
    const leaf = wb.session.view.leaf;
    const notify = wb.notify;
    let closedLeaves: WorkspaceLeaf[] = [];
    try {
        await wb.session.run(async () => undefined);
        const restored = await rollbackMindmapBackup(app, file, backup, {
            beforeWrite: async () => {
                wb.session.teardown("rollback");
                closedLeaves = await closeViewsOfFile(app, file);
            },
            afterWrite: async () => {
                for (const other of closedLeaves) {
                    if (other !== leaf) await other.openFile(file, { active: false });
                }
                await leaf.openFile(file, { active: true });
            },
        });
        notify(restored
            ? `Mindmap backup ${backup.file.name} restored. Run the script again to continue.`
            : "The selected backup no longer exists.");
    } catch (error) {
        console.error("[Automatic Mindmap Layouting] Could not restore the mindmap backup.", error);
        notify("Could not restore the mindmap backup. The backup file was kept.");
    }
}

const ROLLBACK_NOTE = "The drawing is closed, restored, and reopened; the workbench closes and must be started again.";

/**
 * Rollback dialog: shows the newest backup (file name and creation time) and
 * offers to restore it or to choose a previous one.
 */
function openRollbackDialog(wb: Workbench): void {
    const { app, file } = wb.session;
    const backups = listMindmapBackups(app, file);
    const newest = backups[0];
    if (!newest) {
        wb.notify("No backup found for this drawing.");
        return;
    }
    const modal = new wb.ea.obsidian.Modal(app);
    wb.childModals.add(modal);
    const restore = (backup: MindmapBackup): void => {
        modal.close();
        void rollback(wb, backup);
    };
    const showNewest = (): void => {
        const content = modal.contentEl;
        content.empty();
        modal.titleEl.textContent = "Rollback";
        addText(content, "Restore the newest backup of this drawing?");
        addPlainText(content, `Backup: ${newest.file.name}`);
        addPlainText(content, `Created: ${backupCreatedAt(newest)}`);
        addText(content, ROLLBACK_NOTE);
        const actions = addActions(content);
        addButton(actions, "Restore").addEventListener("click", () => restore(newest));
        const previous = addButton(actions, "Choose Previous Backup");
        previous.disabled = backups.length < 2;
        previous.addEventListener("click", showPrevious);
        addButton(actions, "Cancel").addEventListener("click", () => modal.close());
    };
    const showPrevious = (): void => {
        const content = modal.contentEl;
        content.empty();
        modal.titleEl.textContent = "Rollback to a Previous Backup";
        addText(content, "Choose the backup to restore. Only the chosen backup is consumed; newer backups are kept.");
        const select = addSelect(content, backups.slice(1).map((backup) => ({
            value: backup.file.path,
            label: `${backup.file.name} (${backupCreatedAt(backup)})`,
        })));
        addText(content, ROLLBACK_NOTE);
        const actions = addActions(content);
        addButton(actions, "Restore").addEventListener("click", () => {
            const chosen = backups.find((backup) => backup.file.path === select.value);
            if (chosen) restore(chosen);
        });
        addButton(actions, "Back").addEventListener("click", showNewest);
        addButton(actions, "Cancel").addEventListener("click", () => modal.close());
    };
    modal.onOpen = showNewest;
    modal.onClose = () => wb.childModals.delete(modal);
    modal.open();
}

function confirmClearBackups(wb: Workbench): void {
    const { app, file } = wb.session;
    const count = listMindmapBackups(app, file).length;
    confirmAction(wb.ea, `Delete all ${plural(count, "backup")} of this drawing?`, async () => {
        try {
            const deleted = await clearMindmapBackups(app, file);
            wb.notify(`${plural(deleted, "mindmap backup")} deleted.`);
        } catch (error) {
            reportError(wb, "Could not clear the mindmap backups.", error);
        }
        if (wb.session.alive) wb.render();
    });
}

// BORDER SETTINGS

async function saveBorder(wb: Workbench, candidateId: string, padding: MindmapPadding): Promise<void> {
    await wb.session.run(async () => {
        const previousId = wb.state.borderId;
        await saveMetadata(wb.ea, [
            ...(previousId && previousId !== candidateId
                ? [{ id: previousId, patch: { isMindmapBorder: undefined, mindmapPadding: undefined } }]
                : []),
            { id: candidateId, patch: { isMindmapBorder: true, mindmapPadding: { ...padding } as Record<string, number> } },
        ]);
        wb.state.borderId = candidateId;
        wb.state.padding = { ...padding };
    });
}

function renderBorderSettings(wb: Workbench, modal: InstanceType<ExcalidrawAutomate["FloatingModal"]>, timer: { id?: number }): void {
    const content = modal.contentEl;
    content.empty();
    styleModalContent(content, modal.modalEl, "36em");
    const scene = wb.ea.getViewElements();
    let candidateId = wb.state.borderId;
    const nextPadding: MindmapPadding = { ...wb.state.padding };
    wb.borderPreview = { ...(candidateId ? { borderId: candidateId } : {}), padding: nextPadding };
    const candidateText = addPlainText(content, `Border Element: ${logicalLabel(resolveAnchorId(wb.ea, candidateId, scene))}`);
    const schedulePreview = (): void => {
        if (timer.id !== undefined) window.clearTimeout(timer.id);
        timer.id = window.setTimeout(() => void refresh(wb), DEBOUNCE_MS);
    };
    addButton(content, "Use Selected Element/Group").addEventListener("click", () => {
        const candidate = selectedLogical(wb);
        if (!candidate) {
            wb.notify("Border selection must contain one element or one complete group (or its indicator).");
            return;
        }
        candidateId = candidate.anchor.id;
        wb.borderPreview = { borderId: candidateId, padding: nextPadding };
        candidateText.textContent = `Border Element: ${logicalLabel(candidate)}`;
        schedulePreview();
    });
    for (const side of ["top", "left", "bottom", "right"] as const) {
        const label = `${side[0].toUpperCase()}${side.slice(1)}`;
        addRangePair(content, label, -120, 120, nextPadding[side], (value) => {
            nextPadding[side] = value;
            schedulePreview();
        }, { minLabelWidth: "5em" });
    }
    const actions = addActions(content);
    addButton(actions, "Save").addEventListener("click", () => {
        if (!candidateId) return;
        void saveBorder(wb, candidateId, nextPadding)
            .then(() => wb.notify("Border saved."))
            .catch((error: unknown) => reportError(wb, "Could not save the border.", error))
            .then(() => modal.close());
    });
    addButton(actions, "Cancel").addEventListener("click", () => modal.close());
}

function createBorderModal(wb: Workbench): void {
    const modal = new wb.ea.FloatingModal(wb.ea.plugin.app);
    const timer: { id?: number } = {};
    wb.childModals.add(modal);
    modal.titleEl.textContent = "Border Settings";
    modal.onOpen = () => renderBorderSettings(wb, modal, timer);
    modal.onClose = () => {
        if (timer.id !== undefined) window.clearTimeout(timer.id);
        wb.childModals.delete(modal);
        delete wb.borderPreview;
        if (!wb.session.alive) return;
        void refresh(wb).then(() => {
            if (wb.session.alive) wb.render();
        });
    };
    modal.open();
}

// MAIN MODAL

function renderDataSection(wb: Workbench, content: HTMLElement): void {
    const { ea, state } = wb;
    const data = addSection(content, "Mindmap Data");
    const scene = ea.getViewElements();
    addPlainText(data, `Border Element: ${logicalLabel(resolveAnchorId(ea, state.borderId, scene))}`);
    addButton(data, "Configure Border").addEventListener("click", () => createBorderModal(wb));
    addSpacer(data, "0.5em");
    const root = resolveAnchorId(ea, state.rootId, scene);
    addPlainText(data, `Root Element: ${logicalLabel(root)}`);
    addButton(data, "Select Root Element/Group").addEventListener("click", () => void selectRoot(wb));
    addSpacer(data, "0.5em");
    const shapeSelect = addSelect(data, [{ value: "ellipse", label: "ellipse" }, { value: "rect", label: "rect" }]);
    addButton(data, "Apply Shape To Selection").addEventListener("click", () => void applyShape(wb, shapeSelect.value));
    addSpacer(data, "0.5em");
    addText(data, `Fixed Nodes: ${wb.fixedIds.length}`);
    const fixedActions = addRow(data, "1fr 1fr");
    addButton(fixedActions, "Fix Selection").addEventListener("click", () => void setSelectionFixed(wb, true));
    addButton(fixedActions, "Unfix Selection").addEventListener("click", () => void setSelectionFixed(wb, false));
    addSpacer(data, "0.5em");
    addButton(data, "Fit Selected Text Widths").addEventListener("click", () => void fitSelectedTextWidths(wb));
    addSpacer(data, "0.5em");
    addRangePair(data, "Parsing Connection Distance", 1, 300, state.connectionDistance, (value) => saveRootDistance(wb, "mindmapConnectionDistance", value));
    addRangePair(data, "Rendering Connection Distance", 0, MAX_RENDERING_DISTANCE, state.renderingDistance, (value) => saveRootDistance(wb, "mindmapRenderingConnectionDistance", value));
    const parse = addButton(data, "Parse Mindmap");
    parse.disabled = !root;
    parse.addEventListener("click", () => void parseCurrentMindmap(wb));
    const exportGraph = addButton(data, "Export And Copy To Clipboard");
    exportGraph.disabled = !displayedGraph(wb);
    exportGraph.addEventListener("click", () => void exportGraphToClipboard(wb, data.ownerDocument));
    addSpacer(data, "0.5em");
    wb.statsEl = addText(data, statsHtml(wb));
    addSpacer(data, "0.5em");
    const metadataActions = addRow(data, "auto auto");
    const clearMindmap = addButton(metadataActions, "Clear Mindmap");
    const clearAll = addButton(metadataActions, "Clear All Metadata");
    clearMindmap.disabled = !scene.some(isNode);
    clearMindmap.addEventListener("click", () => confirmAction(ea, "Clear All Mindmap Node and Edge Metadata?", () => clearMindmapMetadata(wb, false)));
    clearAll.disabled = !scene.some((element) => ALL_KEYS.some((key) => customData(element)[key] !== undefined));
    clearAll.addEventListener("click", () => confirmAction(ea, "Clear All Mindmap Metadata?", () => clearMindmapMetadata(wb, true)));
    if (wb.busy) disableControls(data);
}

function addParameterControl(wb: Workbench, parent: HTMLElement, parameter: Parameter): void {
    const update = (value: number | boolean): void => {
        wb.settings.values[parameter.key] = value;
        invalidateRun(wb);
    };
    const tooltip = parameterTooltipText(parameter);
    if (isBooleanParameter(parameter)) {
        const checkbox = addCheckbox(parent, parameter.label, Boolean(wb.settings.values[parameter.key]), update);
        if (checkbox.parentElement) checkbox.parentElement.title = tooltip;  // the row label
        return;
    }
    addRangePair(parent, parameter.label, parameter.min, parameter.max, Number(wb.settings.values[parameter.key]), update, {
        step: parameter.step,
        minLabelWidth: LABEL_WIDTH,
        tooltip,
    });
}

function renderAlgorithmSection(wb: Workbench, content: HTMLElement): void {
    const section = addSection(content, "Algorithm");
    const options = Object.entries(ALGORITHM_OPTIONS).map(([value, label]) => ({ value, label }));
    const select = addSelect(section, options, wb.settings.algorithm);
    select.addEventListener("change", () => {
        wb.settings.algorithm = select.value as AlgorithmId;
        invalidateRun(wb);
    });
    addSpacer(section, "0.5em");
    addRangePair(section, "Steps Per Render", 1, STEPS_FINISHED, wb.settings.stepsPerRender, (value) => {
        wb.settings.stepsPerRender = value;
        updateControls(wb);
    }, { minLabelWidth: LABEL_WIDTH, maximumLabel: "Finished" });
    addSpacer(section, "0.5em");
    for (const parameter of PRIMARY_PARAMETERS) addParameterControl(wb, section, parameter);
    const details = content.ownerDocument.createElement("details");
    details.open = wb.settings.showAdvanced;
    details.addEventListener("toggle", () => {
        wb.settings.showAdvanced = details.open;
    });
    const summary = content.ownerDocument.createElement("summary");
    summary.textContent = "Advanced Parameters";
    details.appendChild(summary);
    const advanced = content.ownerDocument.createElement("div");
    advanced.style.display = "flex";
    advanced.style.flexDirection = "column";
    advanced.style.gap = "0.45em";
    advanced.style.marginTop = "0.45em";
    for (const parameter of [...ADVANCED_PARAMETERS, ...INITIAL_LAYOUT_PARAMETERS]) addParameterControl(wb, advanced, parameter);
    details.appendChild(advanced);
    section.appendChild(details);
    addSpacer(section, "0.5em");
    addButton(section, "Restore Algorithm Defaults").addEventListener("click", () => {
        restoreSettings(wb, toStoredSettings(defaultAlgorithmSettings()), "Algorithm defaults restored.");
    });
    const restoreStored = addButton(section, "Restore Mindmap Parameters");
    restoreStored.addEventListener("click", () => {
        if (wb.storedSettings) restoreSettings(wb, wb.storedSettings, "Mindmap parameters restored from the root element.");
    });
    const save = addButton(section, "Save Mindmap Parameters");
    save.addEventListener("click", () => void saveMindmapParameters(wb));
    wb.controls = { ...wb.controls, restoreStored, save };
}

function renderControlSection(wb: Workbench, content: HTMLElement): void {
    const { session } = wb;
    const control = addSection(content, "Control");
    const firstRow = addRow(control, "1fr 1fr 1fr");
    const secondRow = addRow(control, "1fr 1fr");
    const running = Boolean(wb.run?.running);
    const ready = graphReady(wb);
    const start = addButton(firstRow, startLabel(wb));
    start.disabled = running ? false : wb.busy || !ready;
    start.addEventListener("click", () => void toggleStart(wb));
    wb.controls = { ...wb.controls, start };
    const step = addButton(firstRow, "Step");
    step.disabled = wb.busy || !ready;
    step.addEventListener("click", () => void stepOnce(wb));
    const reset = addButton(firstRow, "Reset");
    reset.disabled = wb.busy || !ready;
    reset.addEventListener("click", () => void resetLayout(wb));
    const hasBackups = listMindmapBackups(session.app, session.file).length > 0;
    const rollbackButton = addButton(secondRow, "Rollback");
    rollbackButton.disabled = wb.busy || !hasBackups;
    rollbackButton.addEventListener("click", () => openRollbackDialog(wb));
    const clearBackups = addButton(secondRow, "Clear Backups");
    clearBackups.disabled = wb.busy || !hasBackups;
    clearBackups.addEventListener("click", () => confirmClearBackups(wb));
    addCheckbox(control, "Reset Before Start", wb.settings.resetBeforeStart, (value) => {
        wb.settings.resetBeforeStart = value;
        updateControls(wb);
    });
    addSpacer(control, "0.5em");
    wb.progressEls = {
        steps: addText(control, ""),
        timings: addText(control, ""),
        status: addText(control, ""),
    };
    updateProgress(wb);
}

function renderMain(wb: Workbench, modal: InstanceType<ExcalidrawAutomate["FloatingModal"]>): void {
    if (!wb.session.alive) return;
    const content = modal.contentEl;
    content.empty();
    styleModalContent(content, modal.modalEl, "30em");
    renderDataSection(wb, content);
    renderAlgorithmSection(wb, content);
    renderControlSection(wb, content);
    addCredit(content);
    wb.presence = presenceKey(wb);
    updateControls(wb);
}

function handleTeardown(wb: Workbench, modal: { close: () => void }, reason: TeardownReason): void {
    // Stop first: the run checks the flag before its next step and render.
    wb.run?.stop();
    for (const timer of Object.values(wb.distanceTimers)) window.clearTimeout(timer);
    for (const child of [...wb.childModals]) child.close();
    wb.childModals.clear();
    if (reason !== "modal-close") modal.close();
    if (reason === "file-switch") wb.notify("Automatic Mindmap Layouting closed because another file was opened in this tab.");
    if (reason === "replaced") wb.notify("Automatic Mindmap Layouting was already running; it has been restarted.");
}

/**
 * Opens the workbench for the EA's current drawing.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @returns The opened modal, or undefined when no drawing is open.
 */
export function openMindmapWorkbench(ea: ExcalidrawAutomate): { close: () => void } | undefined {
    const NoticeClass = ea.obsidian.Notice;
    const notify: Notify = (message, durationMs = NOTICE_MS) => {
        new NoticeClass(message, durationMs);
    };
    const modal = new ea.FloatingModal(ea.plugin.app);
    // Session callbacks fire only after the workbench below exists.
    const holder: { workbench?: Workbench } = {};
    const session = WorkbenchSession.start(ea, {
        onSceneChange: () => {
            if (holder.workbench) void refresh(holder.workbench);
        },
        onTeardown: (reason) => {
            if (holder.workbench) handleTeardown(holder.workbench, modal, reason);
        },
    });
    if (!session) {
        notify("Open an Excalidraw drawing before starting Automatic Mindmap Layouting.");
        return undefined;
    }
    if (!session.closeHookActive) {
        notify("Could not register the close hook; indicators may be saved if the drawing is closed while the workbench is open.");
    }
    const wb: Workbench = {
        ea,
        session,
        state: loadRuntimeState(ea.getViewElements()),
        indicators: createIndicatorState(),
        nodes: [],
        fixedIds: [],
        childModals: new Set(),
        presence: "",
        distanceTimers: {},
        settings: defaultAlgorithmSettings(),
        busy: false,
        runStatus: "Idle",
        notify,
        render: () => renderMain(wb, modal),
    };
    holder.workbench = wb;
    wb.storedSettings = readRootSettings(wb);
    if (wb.storedSettings) wb.settings = applyStoredSettings(wb.settings, wb.storedSettings);
    modal.titleEl.textContent = "Automatic Mindmap Layouting";
    modal.onOpen = () => {
        wb.render();
        void session.run(() => repairRootFlags(wb))
            .catch((error: unknown) => reportError(wb, "Could not repair the root flags.", error))
            .then(() => refresh(wb))
            .then(() => wb.render());
    };
    modal.onClose = () => session.teardown("modal-close");
    modal.open();
    return { close: () => modal.close() };
}
