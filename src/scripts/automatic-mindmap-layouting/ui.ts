import {
    clearIndicators,
    refreshIndicators,
    type NodeIndicator,
    type IndicatorState,
} from "./indicators";
import {
    clampInteger,
    loadRuntimeState,
    normalizeShape,
    type MindmapPadding,
    type MindmapRuntimeState,
} from "./metadata";
import { resolveAnchor, resolveLogicalSelection, type LogicalElement } from "./groups";
import { showNotice } from "../../sharedUtils/notice";
import { parseMindmap } from "./parser";
import { calculateGraphMetricsString } from "./core/graph/evaluation";

type CustomDataPatch = Parameters<ExcalidrawAutomate["addAppendUpdateCustomData"]>[1];

function addText(parent: HTMLElement, text: string): HTMLParagraphElement {
    const element = parent.ownerDocument.createElement("p");
    element.textContent = text;
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

function addRangePair(
    parent: HTMLElement,
    label: string,
    minimum: number,
    maximum: number,
    initial: number,
    onChange: (value: number) => void,
): void {
    const row = parent.ownerDocument.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5em";
    row.textContent = label;
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
    row.append(range, number);
    parent.appendChild(row);
}

async function saveMetadata(
    ea: ExcalidrawAutomate,
    elements: readonly ExcalidrawElement[],
    patches: readonly { id: string; patch: CustomDataPatch }[],
): Promise<void> {
    ea.clear();
    ea.copyViewElementsToEAforEditing(elements);
    for (const { id, patch } of patches) ea.addAppendUpdateCustomData(id, patch);
    await ea.addElementsToView(false, false);
    ea.clear();
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

async function clearMindmapMetadata(ea: ExcalidrawAutomate, clearAll: boolean): Promise<void> {
    const scene = ea.getViewElements();
    const keys = clearAll
        ? ["isMindmapBorder", "mindmapPadding", "isMindmapRoot", "mindmapShape", "mindmapConnectionDistance", "mindmapChildren", "isMindmapNode", "mindmapParent"]
        : ["isMindmapNode", "mindmapParent", "mindmapChildren"];
    const elements = scene.filter((element) => {
        const data = element.customData as Record<string, unknown> | undefined;
        return keys.some((key) => data?.[key] !== undefined);
    });
    const patches = elements.map((element) => ({
        id: element.id,
        patch: Object.fromEntries(keys.map((key) => [key, undefined])) as CustomDataPatch,
    }));
    if (elements.length > 0) await saveMetadata(ea, elements, patches);
}

function logicalLabel(element: LogicalElement | undefined): string {
    return element ? `${element.anchor.type} (${element.anchor.id})` : "Not Configured";
}

function styleModalContent(content: HTMLElement, modal: HTMLElement): void {
    content.style.fontSize = "0.9em";
    content.style.display = "flex";
    content.style.flexDirection = "column";
    content.style.gap = "0.6em";
    modal.style.width = "min(28em, 80vw)";
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

async function refreshConfiguredIndicators(
    ea: ExcalidrawAutomate,
    indicators: IndicatorState,
    state: MindmapRuntimeState,
    nodes: readonly NodeIndicator[] = [],
): Promise<void> {
    const scene = ea.getViewElements();
    const border = resolveAnchor(ea, scene.find((element) => element.id === state.borderId), scene);
    const root = resolveAnchor(ea, scene.find((element) => element.id === state.rootId), scene);
    await refreshIndicators(ea, indicators, border, state.padding, root, nodes);
}

function loadNodeIndicators(
    ea: ExcalidrawAutomate,
    scene: readonly ExcalidrawElement[],
    rootId: string | undefined,
    border: LogicalElement | undefined,
): NodeIndicator[] {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const nodes = scene.filter((element) => {
        const data = element.customData as Record<string, unknown> | undefined;
        return data?.isMindmapNode === true && element.id !== rootId && !borderIds.has(element.id);
    });
    return nodes.flatMap((element) => {
        const logical = resolveAnchor(ea, element, scene);
        if (!logical) return [];
        const parentId = (element.customData as Record<string, unknown> | undefined)?.mindmapParent;
        const parentElement = typeof parentId === "string" ? scene.find((candidate) => candidate.id === parentId) : undefined;
        const parent = parentElement ? resolveAnchor(ea, parentElement, scene) : undefined;
        const shape = normalizeShape((element.customData as Record<string, unknown> | undefined)?.mindmapShape);
        return parent ? [{ logical, parent, shape }] : [{ logical, shape }];
    });
}

async function repairRootFlags(ea: ExcalidrawAutomate, state: MindmapRuntimeState): Promise<void> {
    const scene = ea.getViewElements();
    const roots = scene.filter((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapRoot === true);
    if (roots.length <= 1) return;
    const keep = roots[0];
    const remove = roots.slice(1);
    await saveMetadata(ea, remove, remove.map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined } })));
    state.rootId = keep.id;
    showNotice("Multiple Mindmap Roots Found; Kept the First Root and Removed the Other Root Flags.");
}

function createBorderModal(
    ea: ExcalidrawAutomate,
    state: MindmapRuntimeState,
    indicators: IndicatorState,
    nodes: readonly NodeIndicator[],
    onSaved: () => Promise<void>,
): void {
    const modal = new ea.FloatingModal(ea.plugin.app);
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewDirty = false;
    modal.titleEl.textContent = "Border Settings";
    modal.onOpen = () => {
        const content = modal.contentEl;
        content.empty();
        styleModalContent(content, modal.modalEl);
        const scene = ea.getViewElements();
        let candidate = resolveAnchor(ea, scene.find((element) => element.id === state.borderId), scene);
        const candidateText = addText(content, `Border Element: ${logicalLabel(candidate)}`);
        const nextPadding: MindmapPadding = { ...state.padding };
        const preview = async (): Promise<void> => {
            const currentScene = ea.getViewElements();
            const root = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
            await refreshIndicators(ea, indicators, candidate, nextPadding, root, nodes);
        };
        const schedulePreview = (): void => {
            previewDirty = true;
            if (previewTimer !== undefined) clearTimeout(previewTimer);
            previewTimer = setTimeout(() => void preview(), 120);
        };
        const choose = addButton(content, "Use Selected Element/Group");
        choose.addEventListener("click", () => {
            candidate = resolveLogicalSelection(ea, ea.getViewSelectedElements(), ea.getViewElements());
            if (!candidate) {
                showNotice("Border selection must contain one element or one complete group.");
                return;
            }
            candidateText.textContent = `Border Element: ${logicalLabel(candidate)}`;
            schedulePreview();
        });

        for (const side of ["top", "left", "bottom", "right"] as const) {
            const label = `${side[0].toUpperCase()}${side.slice(1)}`;
            addRangePair(content, label, -120, 120, nextPadding[side], (value) => {
                nextPadding[side] = value;
                schedulePreview();
            });
        }
        const actions = content.ownerDocument.createElement("div");
        const save = addButton(actions, "Save");
        const cancel = addButton(actions, "Cancel");
        save.addEventListener("click", () => {
            if (!candidate) return;
            const selectedCandidate = candidate;
            const currentScene = ea.getViewElements();
            const previous = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
            const paddingData = { ...nextPadding } as Record<string, number>;
            void saveMetadata(ea, [selectedCandidate.anchor, ...(previous && previous.anchor.id !== selectedCandidate.anchor.id ? [previous.anchor] : [])], [
                ...(previous && previous.anchor.id !== selectedCandidate.anchor.id
                    ? [{ id: previous.anchor.id, patch: { isMindmapBorder: undefined, mindmapPadding: undefined } }]
                    : []),
                { id: selectedCandidate.anchor.id, patch: { isMindmapBorder: true, mindmapPadding: paddingData } },
            ]).then(() => {
                state.borderId = selectedCandidate.anchor.id;
                state.padding = { ...nextPadding };
                modal.close();
            });
        });
        cancel.addEventListener("click", () => {
            modal.close();
        });
        content.appendChild(actions);
    };
    modal.onClose = () => {
        if (previewTimer !== undefined) clearTimeout(previewTimer);
        if (previewDirty) void onSaved();
    };
    modal.open();
}

/**
 * Opens the import-safe first-slice workbench UI.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @returns The opened modal.
 */
export function openMindmapWorkbench(ea: ExcalidrawAutomate): { close: () => void } {
    const scene = ea.getViewElements();
    const state = loadRuntimeState(scene);
    const indicators: IndicatorState = { ids: [] };
    let parsedNodes: NodeIndicator[] = [];
    let parseCurrentMindmap: () => Promise<void> = async () => undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    const modal = new ea.FloatingModal(ea.plugin.app);
    let closed = false;
    let renderMain: (refreshInd?: boolean) => void = () => undefined;
    modal.titleEl.textContent = "Automatic Mindmap Layouting";
    modal.onOpen = () => {
        const startupScene = ea.getViewElements();
        const startupBorder = resolveAnchor(ea, startupScene.find((element) => element.id === state.borderId), startupScene);
        parsedNodes = loadNodeIndicators(ea, startupScene, state.rootId, startupBorder);
        renderMain = (refreshInd = true) => {
            const content = modal.contentEl;
            content.empty();
            styleModalContent(content, modal.modalEl);
            const data = addSection(content, "Mindmap Data");
            const currentScene = ea.getViewElements();
            const border = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
            addText(data, `Border Element: ${logicalLabel(border)}`);
            const configureBorder = addButton(data, "Configure Border");
            configureBorder.addEventListener("click", () => createBorderModal(ea, state, indicators, parsedNodes, async () => {
                await refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                renderMain();
            }));
            const logicalRoot = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
            addText(data, `Root Element: ${logicalLabel(logicalRoot)}`);
            const selectRoot = addButton(data, "Select Root Element/Group");
            selectRoot.addEventListener("click", () => {
                const selectedRoot = resolveLogicalSelection(ea, ea.getViewSelectedElements(), ea.getViewElements());
                if (!selectedRoot) {
                    showNotice("Root selection must contain one element or one complete group.");
                    return;
                }
                const oldRoots = ea.getViewElements().filter((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapRoot === true);
                const shape = normalizeShape(selectedRoot.anchor.type);
                const elements = [...oldRoots, selectedRoot.anchor].filter((element, index, all) => all.findIndex((item) => item.id === element.id) === index);
                void saveMetadata(ea, elements, [
                    ...oldRoots.filter((element) => element.id !== selectedRoot.anchor.id).map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined } })),
                    { id: selectedRoot.anchor.id, patch: { isMindmapRoot: true, isMindmapNode: true, mindmapShape: shape, mindmapConnectionDistance: state.connectionDistance, mindmapChildren: [] } },
                ]).then(() => {
                    state.rootId = selectedRoot.anchor.id;
                    state.rootShape = shape;
                    parsedNodes = [];
                    delete state.graph;
                    return refreshConfiguredIndicators(ea, indicators, state).then(() => {
                        renderMain();
                        return parseCurrentMindmap();
                    });
                });
            });
            const shapeSelect = data.ownerDocument.createElement("select");
            for (const shape of ["ellipse", "rect"] as const) {
                const option = data.ownerDocument.createElement("option");
                option.value = shape;
                option.textContent = shape;
                shapeSelect.appendChild(option);
            }
            data.appendChild(shapeSelect);
            const applyShape = addButton(data, "Apply To Selection");
            applyShape.addEventListener("click", () => {
                const shape = normalizeShape(shapeSelect.value);
                const selected = ea.getViewSelectedElements().filter((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapNode === true);
                if (selected.length === 0) return;
                void saveMetadata(ea, selected, selected.map((element) => ({ id: element.id, patch: { mindmapShape: shape } }))).then(() => {
                    parsedNodes = loadNodeIndicators(ea, ea.getViewElements(), state.rootId, border);
                    return refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                });
            });
            addRangePair(data, "Connection Distance", 1, 300, state.connectionDistance, (value) => {
                state.connectionDistance = value;
                if (connectionTimer !== undefined) clearTimeout(connectionTimer);
                connectionTimer = setTimeout(() => {
                    const rootElement = ea.getViewElements().find((element) => element.id === state.rootId);
                    if (!rootElement) return;
                    void saveMetadata(ea, [rootElement], [{ id: rootElement.id, patch: { mindmapConnectionDistance: value } }]);
                }, 120);
                renderMain(false);
            });
            const parse = addButton(data, "Parse Mindmap");
            parse.disabled = !logicalRoot;
            parseCurrentMindmap = async (): Promise<void> => {
                if (!logicalRoot) return;
                const currentScene = ea.getViewElements();
                const currentRoot = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
                const currentBorder = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
                if (!currentRoot || !currentBorder) return;
                const parsed = parseMindmap(ea, currentRoot, state.connectionDistance, currentBorder);
                state.graph = parsed.graph;
                parsedNodes = parsed.nodes.slice(1).map((logical) => {
                    const parent = parsed.nodes.find((candidate) => parsed.graph.getNode(logical.anchor.id)?.parentId === candidate.anchor.id);
                    const shape = normalizeShape((logical.anchor.customData as Record<string, unknown> | undefined)?.mindmapShape);
                    return parent ? { logical, parent, shape } : { logical, shape };
                });
                const sceneNodes = ea.getViewElements().filter((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapNode === true);
                const parsedPatches = parsed.nodes.map((node) => {
                    const graphNode = parsed.graph.getNode(node.anchor.id)!;
                    const existingData = node.anchor.customData as Record<string, unknown> | undefined;
                    return {
                        id: node.anchor.id,
                        patch: {
                            isMindmapNode: true,
                            mindmapParent: graphNode.parentId,
                            mindmapChildren: graphNode.children,
                            ...(existingData?.mindmapShape === undefined ? { mindmapShape: node.anchor.type === "ellipse" ? "ellipse" : "rectangle" } : {}),
                        },
                    };
                });
                const parsedIds = new Set(parsed.nodes.map((node) => node.anchor.id));
                const stalePatches = sceneNodes
                    .filter((element) => !parsedIds.has(element.id) && element.id !== state.rootId)
                    .map((element) => ({ id: element.id, patch: { isMindmapNode: undefined, mindmapParent: undefined, mindmapChildren: undefined } }));
                const elements = [...sceneNodes, ...parsed.nodes.map((node) => node.anchor)].filter((element, index, all) => all.findIndex((item) => item.id === element.id) === index);
                await saveMetadata(ea, elements, [...stalePatches, ...parsedPatches]);
                await refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                renderMain(false);
            };
            parse.addEventListener("click", () => void parseCurrentMindmap());
            addText(data, state.graph ? `Graph Statistics: ${calculateGraphMetricsString(state.graph)}` : "Graph Statistics: Available after parsing");
            const metadataActions = data.ownerDocument.createElement("div");
            metadataActions.style.display = "grid";
            metadataActions.style.gridTemplateColumns = "auto auto";
            metadataActions.style.gap = "0.5em";
            const clearMindmap = addButton(metadataActions, "Clear Mindmap");
            const clearAllMetadata = addButton(metadataActions, "Clear All Metadata");
            const hasNodeMetadata = currentScene.some((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapNode === true);
            clearMindmap.disabled = !hasNodeMetadata;
            clearMindmap.addEventListener("click", () => confirmAction(ea, "Clear All Mindmap Node Metadata?", async () => {
                await clearMindmapMetadata(ea, false);
                parsedNodes = [];
                delete state.graph;
                await refreshConfiguredIndicators(ea, indicators, state);
                renderMain();
            }));
            const hasMindmapMetadata = currentScene.some((element) => {
                const data = element.customData as Record<string, unknown> | undefined;
                return data && Object.keys(data).some((key) => key.startsWith("mindmap") || key === "isMindmapBorder" || key === "isMindmapRoot");
            });
            clearAllMetadata.disabled = !hasMindmapMetadata;
            clearAllMetadata.addEventListener("click", () => confirmAction(ea, "Clear All Mindmap Metadata?", async () => {
                await clearMindmapMetadata(ea, true);
                parsedNodes = [];
                delete state.graph;
                delete state.borderId;
                delete state.rootId;
                await refreshConfiguredIndicators(ea, indicators, state);
                renderMain();
            }));
            data.appendChild(metadataActions);

            const algorithm = addSection(content, "Algorithm");
            const algorithmSelect = content.ownerDocument.createElement("select");
            const defaultOption = content.ownerDocument.createElement("option");
            defaultOption.value = "default";
            defaultOption.textContent = "Default";
            algorithmSelect.appendChild(defaultOption);
            algorithm.appendChild(algorithmSelect);
            addRangePair(algorithm, "Steps Per Render", 1, 1000, 1, () => undefined);
            addText(algorithm, "Algorithm-Specific Options: Reserved");

            const control = addSection(content, "Control");
            const firstRow = content.ownerDocument.createElement("div");
            const secondRow = content.ownerDocument.createElement("div");
            firstRow.style.display = secondRow.style.display = "grid";
            firstRow.style.gap = secondRow.style.gap = "0.5em";
            firstRow.style.gridTemplateColumns = "auto auto auto";
            secondRow.style.gridTemplateColumns = "auto auto";
            for (const label of ["Start", "Step", "Reset"]) addButton(firstRow, label).disabled = true;
            for (const label of ["Rollback", "Clear Backups"]) addButton(secondRow, label).disabled = true;
            control.append(firstRow, secondRow);
            addText(control, "Current Step / Total Steps: - / -");
            addText(control, "Milliseconds Per Step: Now - | Min - | Average - | Max -");
            addCredit(content);
            if (refreshInd) {
                void refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
            }
        };
        void repairRootFlags(ea, state).then(() => {
            renderMain();
        });
    };
    modal.onClose = () => {
        if (closed) return;
        closed = true;
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        void clearIndicators(ea, indicators);
    };
    ea.registerCleanup(() => {
        closed = true;
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        void clearIndicators(ea, indicators);
    });
    modal.open();
    return { close: () => modal.close() };
}