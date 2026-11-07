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
    clampInteger,
    DEFAULT_CONNECTION_DISTANCE,
    DEFAULT_PADDING,
    loadRuntimeState,
    normalizeShape,
    shapeOf,
    type MindmapPadding,
    type MindmapRuntimeState,
} from "./metadata";
import { normalizeBoundText, resolveAnchor, resolveAnchorId, resolveLogicalSelection, type LogicalElement } from "./groups";
import { loadMindmapFromMetadata, parseMindmap } from "./parser";
import { edgeMetadata } from "./edges";
import { calculateTreeEdgeGraphMetricsString } from "./core/graph/evaluationEdge";
import {
    clearMindmapBackups,
    closeViewsOfFile,
    createMindmapBackup,
    listMindmapBackups,
    rollbackLatestMindmapBackup,
} from "./backup";
import { saveCurrentDrawing, saveMetadata, type MetadataPatch } from "./scene";
import { WorkbenchSession, type TeardownReason } from "./session";

type Notify = (message: string) => void;
type WorkspaceLeaf = WorkbenchSession["view"]["leaf"];

/** Runtime state of one open workbench. */
interface Workbench {
    ea: ExcalidrawAutomate;
    session: WorkbenchSession;
    state: MindmapRuntimeState;
    indicators: IndicatorState;
    /** Parsed nodes, always re-derived from persisted metadata (see `hydrate`). */
    nodes: IndicatorNode[];
    /** Uncommitted Border Settings candidate shown instead of the saved border. */
    borderPreview?: { borderId?: string; padding: MindmapPadding };
    childModals: Set<{ close: () => void }>;
    statsEl?: HTMLElement;
    presence: string;
    connectionTimer?: number;
    notify: Notify;
    render: () => void;
}

const NODE_KEYS = ["isMindmapNode", "mindmapParent", "mindmapChildren", "isMindmapEdge", "mindmapEdge"];
const ALL_KEYS = ["isMindmapBorder", "mindmapPadding", "isMindmapRoot", "mindmapShape", "mindmapConnectionDistance", ...NODE_KEYS];
const DEBOUNCE_MS = 120;

function addText(parent: HTMLElement, text: string): HTMLParagraphElement {
    const element = parent.ownerDocument.createElement("p");
    element.innerHTML = text;
    element.style.margin = "0";
    parent.appendChild(element);
    return element;
}

function addButton(parent: HTMLElement, label: string): HTMLButtonElement {
    const button = parent.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = label;
    parent.appendChild(button);
    return button;
}

function addSpacer(parent: HTMLElement, height: string): void {
    const spacer = parent.ownerDocument.createElement("div");
    spacer.style.height = height;
    parent.appendChild(spacer);
}

function addSection(parent: HTMLElement, title: string): HTMLElement {
    const section = parent.ownerDocument.createElement("section");
    const heading = parent.ownerDocument.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);
    section.style.display = "flex";
    section.style.flexDirection = "column";
    section.style.gap = "0.45em";
    section.style.margin = "0 0 0.8em";
    parent.appendChild(section);
    return section;
}

function addRow(parent: HTMLElement, columns: string): HTMLDivElement {
    const row = parent.ownerDocument.createElement("div");
    row.style.display = "grid";
    row.style.gap = "0.5em";
    row.style.gridTemplateColumns = columns;
    parent.appendChild(row);
    return row;
}

function addRangePair(
    parent: HTMLElement,
    label: string,
    minimum: number,
    maximum: number,
    initial: number,
    onChange: (value: number) => void,
    minLabelWidth?: string,
): void {
    const row = parent.ownerDocument.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5em";
    const labelEl = parent.ownerDocument.createElement("label");
    labelEl.textContent = label;
    if (minLabelWidth) {
        labelEl.style.minWidth = minLabelWidth;
    }
    const range = parent.ownerDocument.createElement("input");
    range.type = "range";
    range.min = String(minimum);
    range.max = String(maximum);
    range.value = String(initial);
    const number = parent.ownerDocument.createElement("input");
    number.type = "number";
    number.min = String(minimum);
    number.max = String(maximum);
    number.value = String(initial);
    range.style.flex = "1 1 auto";
    number.style.width = "5em";
    const update = (source: HTMLInputElement): void => {
        const value = clampInteger(source.value, minimum, maximum, initial);
        range.value = String(value);
        number.value = String(value);
        onChange(value);
    };
    range.addEventListener("input", () => update(range));
    number.addEventListener("input", () => update(number));
    row.append(labelEl, range, number);
    parent.appendChild(row);
}

function customData(element: ExcalidrawElement): Record<string, unknown> {
    return (element.customData as Record<string, unknown> | undefined) ?? {};
}

function isNode(element: ExcalidrawElement): boolean {
    return customData(element).isMindmapNode === true;
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
        const actions = modal.contentEl.ownerDocument.createElement("div");
        actions.style.display = "flex";
        actions.style.justifyContent = "flex-end";
        actions.style.gap = "0.5em";
        const confirm = addButton(actions, "Confirm");
        const cancel = addButton(actions, "Cancel");
        confirm.addEventListener("click", () => {
            modal.close();
            void action();
        });
        cancel.addEventListener("click", () => modal.close());
        modal.contentEl.appendChild(actions);
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

/**
 * Resolves the canvas selection to one logical element. Selected indicators
 * count as their content, so a click on an indicator selects its node.
 */
function selectedLogical(wb: Workbench): LogicalElement | undefined {
    const scene = wb.ea.getViewElements();
    return resolveLogicalSelection(wb.ea, resolveIndicatorOwners(wb.ea.getViewSelectedElements(), scene), scene);
}

/** Returns the anchors of all selected mindmap nodes, selected directly or via an indicator. */
function selectedNodeAnchors(wb: Workbench): ExcalidrawElement[] {
    const scene = wb.ea.getViewElements();
    const owners = normalizeBoundText(resolveIndicatorOwners(wb.ea.getViewSelectedElements(), scene), scene);
    const anchors = new Map<string, ExcalidrawElement>();
    for (const element of owners) {
        const logical = resolveAnchor(wb.ea, element, scene);
        if (logical && isNode(logical.anchor)) anchors.set(logical.anchor.id, logical.anchor);
    }
    return [...anchors.values()];
}

function indicatorModel(wb: Workbench): IndicatorModel {
    const preview = wb.borderPreview;
    const borderId = preview ? preview.borderId : wb.state.borderId;
    return {
        ...(borderId ? { borderId } : {}),
        padding: preview?.padding ?? wb.state.padding,
        ...(wb.state.rootId ? { rootId: wb.state.rootId } : {}),
        nodes: wb.nodes,
    };
}

/**
 * Rebuilds the graph and the node list from persisted metadata and the live
 * scene. Metadata is the single source of truth, so moved content updates the
 * graph positions and deleted content drops out of the graph (with its subtree,
 * until the next parse).
 */
function hydrate(wb: Workbench): void {
    const scene = wb.ea.getViewElements();
    const border = resolveAnchorId(wb.ea, wb.state.borderId, scene);
    const root = resolveAnchorId(wb.ea, wb.state.rootId, scene);
    if (!border || !root) {
        delete wb.state.mindmap;
        wb.nodes = [];
        return;
    }
    const loaded = loadMindmapFromMetadata(wb.ea, root, border, wb.state.padding);
    wb.state.mindmap = loaded;
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
    return JSON.stringify([has(wb.state.borderId), has(wb.state.rootId), Boolean(wb.state.mindmap), scene.some(isNode)]);
}

function statsHtml(wb: Workbench): string {
    return wb.state.mindmap
        ? `Graph Statistics:<br>${calculateTreeEdgeGraphMetricsString(wb.state.mindmap.graph).replace(/\n/g, "<br>")}`
        : "Graph Statistics: Available after parsing";
}

/**
 * Re-derives graph and indicators from the scene. Runs after every debounced
 * scene change, so moving or deleting content (or an indicator) is reflected
 * immediately. Re-renders the modal only when border/root/graph presence
 * changed; otherwise only the statistics text is updated.
 */
async function refresh(wb: Workbench): Promise<void> {
    try {
        await wb.session.run(async () => {
            hydrate(wb);
            const result = await syncIndicators(wb.ea, wb.indicators, indicatorModel(wb));
            if (result.contentMoved) hydrate(wb);
        });
    } catch (error) {
        reportError(wb, "Could not update the mindmap indicators.", error);
    }
    if (!wb.session.alive) return;
    if (presenceKey(wb) !== wb.presence) wb.render();
    else if (wb.statsEl) wb.statsEl.innerHTML = statsHtml(wb);
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
            const parsed = parseMindmap(ea, root, state.connectionDistance, border, state.padding);
            await saveMetadata(ea, parsePatches(wb, parsed));
            hydrate(wb);
            await syncIndicators(ea, wb.indicators, indicatorModel(wb));
            return wb.notify(`Mindmap parsed: ${parsed.nodes.length} nodes, ${parsed.edges.size} edges.`);
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
        await saveMetadata(wb.ea, [
            ...oldRoots.map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined } })),
            {
                id: selected.anchor.id,
                patch: {
                    isMindmapRoot: true,
                    isMindmapNode: true,
                    mindmapShape: shape,
                    mindmapConnectionDistance: wb.state.connectionDistance,
                    mindmapChildren: [],
                },
            },
        ]);
        wb.state.rootId = selected.anchor.id;
        wb.state.rootShape = shape;
    });
    wb.notify("Root Element saved.");
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
    wb.notify(`Shape "${shape}" applied to ${anchors.length} node${anchors.length === 1 ? "" : "s"}.`);
}

function saveConnectionDistance(wb: Workbench, value: number): void {
    wb.state.connectionDistance = value;
    if (wb.connectionTimer !== undefined) window.clearTimeout(wb.connectionTimer);
    wb.connectionTimer = window.setTimeout(() => {
        const rootId = wb.state.rootId;
        if (!rootId) return;
        void wb.session.run(() => saveMetadata(wb.ea, [{ id: rootId, patch: { mindmapConnectionDistance: value } }]));
    }, DEBOUNCE_MS);
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
        }
    });
    await refresh(wb);
    if (wb.session.alive) wb.render();
    wb.notify(clearAll ? "All mindmap metadata cleared." : "Mindmap node and edge metadata cleared.");
}

async function startRun(wb: Workbench): Promise<void> {
    wb.notify("Starting Mindmap Layouting... (This is a placeholder action.)");
    try {
        const backup = await wb.session.run(async () => {
            clearIndicatorsNow(wb.session.api, wb.indicators);
            await saveCurrentDrawing(wb.ea);
            return createMindmapBackup(wb.session.app, wb.session.file);
        });
        if (backup) wb.notify(`Mindmap Backup Created: ${backup.file.path}`);
    } catch (error) {
        reportError(wb, "Could not create the mindmap backup.", error);
    }
    await refresh(wb);
    if (wb.session.alive) wb.render();
}

/**
 * Restores the newest backup by closing every view of the drawing, writing the
 * file, and reopening it in the original leaf. The workbench ends, because its
 * EA is destroyed together with the closed view.
 */
async function rollback(wb: Workbench): Promise<void> {
    const { app, file } = wb.session;
    const leaf = wb.session.view.leaf;
    const notify = wb.notify;
    let closedLeaves: WorkspaceLeaf[] = [];
    try {
        await wb.session.run(async () => undefined);
        const restored = await rollbackLatestMindmapBackup(app, file, {
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
        notify(restored ? "Mindmap backup restored. Run the script again to continue." : "No backup found for this drawing.");
    } catch (error) {
        console.error("[Automatic Mindmap Layouting] Could not restore the mindmap backup.", error);
        notify("Could not restore the mindmap backup. The backup file was kept.");
    }
}

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
    const candidateText = addText(content, `Border Element: ${logicalLabel(resolveAnchorId(wb.ea, candidateId, scene))}`);
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
        }, "5em");
    }
    const actions = content.ownerDocument.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "0.5em";
    actions.style.marginTop = "0.5em";
    addButton(actions, "Save").addEventListener("click", () => {
        if (!candidateId) return;
        void saveBorder(wb, candidateId, nextPadding)
            .then(() => wb.notify("Border saved."))
            .catch((error: unknown) => reportError(wb, "Could not save the border.", error))
            .then(() => modal.close());
    });
    addButton(actions, "Cancel").addEventListener("click", () => modal.close());
    content.appendChild(actions);
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

function renderDataSection(wb: Workbench, content: HTMLElement): void {
    const { ea, state } = wb;
    const data = addSection(content, "Mindmap Data");
    const scene = ea.getViewElements();
    addText(data, `Border Element: ${logicalLabel(resolveAnchorId(ea, state.borderId, scene))}`);
    addButton(data, "Configure Border").addEventListener("click", () => createBorderModal(wb));
    addSpacer(data, "0.5em");
    const root = resolveAnchorId(ea, state.rootId, scene);
    addText(data, `Root Element: ${logicalLabel(root)}`);
    addButton(data, "Select Root Element/Group").addEventListener("click", () => void selectRoot(wb));
    addSpacer(data, "0.5em");
    const shapeSelect = data.ownerDocument.createElement("select");
    for (const shape of ["ellipse", "rect"] as const) {
        const option = data.ownerDocument.createElement("option");
        option.value = shape;
        option.textContent = shape;
        shapeSelect.appendChild(option);
    }
    data.appendChild(shapeSelect);
    addButton(data, "Apply Shape To Selection").addEventListener("click", () => void applyShape(wb, shapeSelect.value));
    addSpacer(data, "0.5em");
    addRangePair(data, "Connection Distance", 1, 300, state.connectionDistance, (value) => saveConnectionDistance(wb, value));
    const parse = addButton(data, "Parse Mindmap");
    parse.disabled = !root;
    parse.addEventListener("click", () => void parseCurrentMindmap(wb));
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
}

function renderAlgorithmSection(content: HTMLElement): void {
    const algorithm = addSection(content, "Algorithm");
    const algorithmSelect = content.ownerDocument.createElement("select");
    const defaultOption = content.ownerDocument.createElement("option");
    defaultOption.value = "default";
    defaultOption.textContent = "Default";
    algorithmSelect.appendChild(defaultOption);
    algorithm.appendChild(algorithmSelect);
    addSpacer(algorithm, "0.5em");
    addRangePair(algorithm, "Steps Per Render", 1, 1000, 1, () => undefined);
    addSpacer(algorithm, "0.5em");
    addText(algorithm, "Algorithm-Specific Options: Reserved");
}

function renderControlSection(wb: Workbench, content: HTMLElement): void {
    const { ea, session } = wb;
    const control = addSection(content, "Control");
    const firstRow = addRow(control, "auto auto auto");
    const secondRow = addRow(control, "auto auto");
    addButton(firstRow, "Start").addEventListener("click", () => void startRun(wb));
    for (const label of ["Step", "Reset"]) addButton(firstRow, label).disabled = true;
    const hasBackups = listMindmapBackups(session.app, session.file).length > 0;
    const rollbackButton = addButton(secondRow, "Rollback");
    rollbackButton.disabled = !hasBackups;
    rollbackButton.addEventListener("click", () => confirmAction(
        ea,
        "Restore the newest backup for this drawing? The drawing is closed, restored, and reopened; the workbench closes and must be started again.",
        () => rollback(wb),
    ));
    const clearBackups = addButton(secondRow, "Clear Backups");
    clearBackups.disabled = !hasBackups;
    clearBackups.addEventListener("click", () => confirmAction(ea, "Delete all backups for this drawing?", async () => {
        try {
            await clearMindmapBackups(session.app, session.file);
            wb.notify("Mindmap backups cleared.");
        } catch (error) {
            reportError(wb, "Could not clear the mindmap backups.", error);
        }
        if (session.alive) wb.render();
    }));
    addSpacer(control, "0.5em");
    addText(control, "Current Step / Total Steps: - / -");
    addText(control, "Milliseconds Per Step: Now - | Min - | Average - | Max -");
}

function renderMain(wb: Workbench, modal: InstanceType<ExcalidrawAutomate["FloatingModal"]>): void {
    if (!wb.session.alive) return;
    const content = modal.contentEl;
    content.empty();
    styleModalContent(content, modal.modalEl, "28em");
    renderDataSection(wb, content);
    renderAlgorithmSection(content);
    renderControlSection(wb, content);
    addCredit(content);
    wb.presence = presenceKey(wb);
}

function handleTeardown(wb: Workbench, modal: { close: () => void }, reason: TeardownReason): void {
    if (wb.connectionTimer !== undefined) window.clearTimeout(wb.connectionTimer);
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
    const notify: Notify = (message) => {
        new NoticeClass(message);
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
        childModals: new Set(),
        presence: "",
        notify,
        render: () => renderMain(wb, modal),
    };
    holder.workbench = wb;
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
