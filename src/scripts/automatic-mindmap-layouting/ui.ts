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

function logicalLabel(element: LogicalElement | undefined): string {
    return element ? `${element.anchor.type} (${element.anchor.id})` : "Not configured";
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

async function repairRootFlags(ea: ExcalidrawAutomate, state: MindmapRuntimeState): Promise<void> {
    if (state.duplicateRootIds.length === 0 || !state.rootId) return;
    const scene = ea.getViewElements();
    const duplicates = scene.filter((element) => state.duplicateRootIds.includes(element.id));
    const patches = duplicates.map((element) => ({ id: element.id, patch: { isMindmapRoot: undefined } }));
    if (patches.length === 0) return;
    await saveMetadata(ea, duplicates, patches);
    showNotice("Multiple mindmap roots found; kept the first root and removed the other root flags.");
    state.duplicateRootIds = [];
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
    modal.titleEl.textContent = "Border Settings";
    modal.modalEl.style.transform = "translate(2em, 2em)";
    modal.onOpen = () => {
        const content = modal.contentEl;
        content.empty();
        styleModalContent(content, modal.modalEl);
        const scene = ea.getViewElements();
        let candidate = resolveAnchor(ea, scene.find((element) => element.id === state.borderId), scene);
        const candidateText = addText(content, `Border element: ${logicalLabel(candidate)}`);
        const nextPadding: MindmapPadding = { ...state.padding };
        const preview = async (): Promise<void> => {
            const currentScene = ea.getViewElements();
            const root = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
            await refreshIndicators(ea, indicators, candidate, nextPadding, root, nodes);
        };
        const schedulePreview = (): void => {
            if (previewTimer !== undefined) clearTimeout(previewTimer);
            previewTimer = setTimeout(() => void preview(), 120);
        };
        const choose = addButton(content, "Use selected element/group");
        choose.addEventListener("click", () => {
            candidate = resolveLogicalSelection(ea, ea.getViewSelectedElements(), ea.getViewElements());
            if (!candidate) {
                showNotice("Border selection must contain one element or one complete group.");
                return;
            }
            candidateText.textContent = `Border element: ${logicalLabel(candidate)}`;
            schedulePreview();
        });

        for (const side of ["top", "left", "bottom", "right"] as const) {
            addRangePair(content, side, -120, 120, nextPadding[side], (value) => {
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
        void preview();
    };
    modal.onClose = () => {
        if (previewTimer !== undefined) clearTimeout(previewTimer);
        void onSaved();
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
    const modal = new ea.FloatingModal(ea.plugin.app);
    let closed = false;
    let renderMain: () => void = () => undefined;
    modal.titleEl.textContent = "Automatic Mindmap Layouting";
    modal.onOpen = () => {
        renderMain = () => {
            const content = modal.contentEl;
            content.empty();
            styleModalContent(content, modal.modalEl);
            const data = addSection(content, "Mindmap Data");
            const currentScene = ea.getViewElements();
            const border = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
            addText(data, `Border: ${logicalLabel(border)}`);
            const configureBorder = addButton(data, "Configure border");
            configureBorder.addEventListener("click", () => createBorderModal(ea, state, indicators, parsedNodes, async () => {
                await refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                renderMain();
            }));
            const logicalRoot = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
            addText(data, `Root: ${logicalLabel(logicalRoot)}`);
            const selectRoot = addButton(data, "Select root element/group");
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
                    return refreshConfiguredIndicators(ea, indicators, state).then(renderMain);
                });
            });
            addRangePair(data, "Connection distance", 1, 300, state.connectionDistance, (value) => {
                state.connectionDistance = value;
                renderMain();
            });
            const parse = addButton(data, "Parse Mindmap");
            parse.disabled = !logicalRoot;
            parse.addEventListener("click", () => {
                if (!logicalRoot) return;
                const parsed = parseMindmap(ea, logicalRoot, state.connectionDistance);
                state.graph = parsed.graph;
                parsedNodes = parsed.nodes.slice(1).map((logical) => {
                    const parent = parsed.nodes.find((candidate) => parsed.graph.getNode(logical.anchor.id)?.parentId === candidate.anchor.id);
                    return parent ? { logical, parent } : { logical };
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
                void saveMetadata(ea, elements, [...stalePatches, ...parsedPatches]).then(() => refreshConfiguredIndicators(ea, indicators, state, parsedNodes)).then(renderMain);
            });
            addText(data, state.graph ? `Graph statistics: ${state.graph.getAllNodes().length} nodes, ${state.graph.getEdges().length} edges` : "Graph statistics: available after parsing");
            const metadataActions = data.ownerDocument.createElement("div");
            metadataActions.style.display = "grid";
            metadataActions.style.gridTemplateColumns = "auto auto";
            metadataActions.style.gap = "0.5em";
            addButton(metadataActions, "Clear Mindmap").disabled = true;
            addButton(metadataActions, "Clear All Metadata").disabled = true;
            data.appendChild(metadataActions);

            const algorithm = addSection(content, "Algorithm");
            const algorithmSelect = content.ownerDocument.createElement("select");
            const defaultOption = content.ownerDocument.createElement("option");
            defaultOption.value = "default";
            defaultOption.textContent = "Default";
            algorithmSelect.appendChild(defaultOption);
            algorithm.appendChild(algorithmSelect);
            addRangePair(algorithm, "Steps per render", 1, 1000, 1, () => undefined);
            addText(algorithm, "Algorithm-specific options: reserved");

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
            addText(control, "Current step / total steps: - / -");
            addText(control, "Milliseconds per step: now - | min - | average - | max -");
            addCredit(content);
            void refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
        };
        void repairRootFlags(ea, state).then(renderMain);
    };
    modal.onClose = () => {
        if (closed) return;
        closed = true;
        void clearIndicators(ea, indicators);
    };
    ea.registerCleanup(() => {
        closed = true;
        void clearIndicators(ea, indicators);
    });
    modal.open();
    return { close: () => modal.close() };
}