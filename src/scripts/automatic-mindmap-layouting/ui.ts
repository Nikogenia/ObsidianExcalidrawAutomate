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
import { loadMindmapFromMetadata, parseMindmap } from "./parser";
import { calculateGraphMetricsString } from "./core/graph/evaluation";
import { clearMindmapBackups, createMindmapBackup, listMindmapBackups, rollbackLatestMindmapBackup } from "./backup";

type CustomDataPatch = Parameters<ExcalidrawAutomate["addAppendUpdateCustomData"]>[1];

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

async function saveCurrentDrawing(ea: ExcalidrawAutomate): Promise<void> {
    const scene = ea.getViewElements();
    ea.clear();
    ea.copyViewElementsToEAforEditing(scene);
    await ea.addElementsToView(false, true);
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

function styleModalContent(content: HTMLElement, modal: HTMLElement, width: string): void {
    content.style.fontSize = "0.9em";
    content.style.display = "flex";
    content.style.flexDirection = "column";
    content.style.gap = "0.5em";
    modal.style.width = "min(" + width + ", 80vw)";
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

function reportError(message: string, error: unknown): void {
    console.error(`[Automatic Mindmap Layouting] ${message}`, error);
    showNotice(message);
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
        const data = element.customData as Record<string, unknown> | undefined;
        const shape = data?.mindmapShape !== undefined
            ? normalizeShape(data.mindmapShape)
            : element.type === "ellipse" ? "ellipse" : "rectangle";
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
        styleModalContent(content, modal.modalEl, "36em");
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
            }, "5em");
        }
        const actions = content.ownerDocument.createElement("div");
        actions.style.display = "flex";
        actions.style.justifyContent = "flex-end";
        actions.style.gap = "0.5em";
        actions.style.marginTop = "0.5em";
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
    const indicators: IndicatorState = { ids: [], records: {} };
    let parsedNodes: NodeIndicator[] = [];
    let parseCurrentMindmap: () => Promise<void> = async () => undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    const modal = new ea.FloatingModal(ea.plugin.app);
    let cleanupStarted = false;
    let renderMain: (refreshInd?: boolean) => void = () => undefined;
    modal.titleEl.textContent = "Automatic Mindmap Layouting";
    modal.onOpen = () => {
        renderMain = (refreshInd = true) => {
            const content = modal.contentEl;
            content.empty();
            styleModalContent(content, modal.modalEl, "28em");
            const data = addSection(content, "Mindmap Data");
            const currentScene = ea.getViewElements();
            const border = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
            addText(data, `Border Element: ${logicalLabel(border)}`);
            const configureBorder = addButton(data, "Configure Border");
            configureBorder.addEventListener("click", () => createBorderModal(ea, state, indicators, parsedNodes, async () => {
                await refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                renderMain();
            }));
            addSpacer(data, "0.5em");
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
            addSpacer(data, "0.5em");
            const shapeSelect = data.ownerDocument.createElement("select");
            for (const shape of ["ellipse", "rect"] as const) {
                const option = data.ownerDocument.createElement("option");
                option.value = shape;
                option.textContent = shape;
                shapeSelect.appendChild(option);
            }
            data.appendChild(shapeSelect);
            const applyShape = addButton(data, "Apply Shape To Selection");
            applyShape.addEventListener("click", () => {
                const shape = normalizeShape(shapeSelect.value);
                const selected = ea.getViewSelectedElements().filter((element) => (element.customData as Record<string, unknown> | undefined)?.isMindmapNode === true);
                if (selected.length === 0) return;
                void saveMetadata(ea, selected, selected.map((element) => ({ id: element.id, patch: { mindmapShape: shape } }))).then(() => {
                    parsedNodes = loadNodeIndicators(ea, ea.getViewElements(), state.rootId, border);
                    return refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
                });
            });
            addSpacer(data, "0.5em");
            addRangePair(data, "Connection Distance", 1, 300, state.connectionDistance, (value) => {
                state.connectionDistance = value;
                if (connectionTimer !== undefined) clearTimeout(connectionTimer);
                connectionTimer = setTimeout(() => {
                    const rootElement = ea.getViewElements().find((element) => element.id === state.rootId);
                    if (!rootElement) return;
                    void saveMetadata(ea, [rootElement], [{ id: rootElement.id, patch: { mindmapConnectionDistance: value } }]);
                }, 120);
            });
            const parse = addButton(data, "Parse Mindmap");
            parse.disabled = !logicalRoot;
            parseCurrentMindmap = async (): Promise<void> => {
                showNotice("Parsing Mindmap... This may take a moment for large mindmaps.");
                if (!logicalRoot) return;
                const currentScene = ea.getViewElements();
                const currentRoot = resolveAnchor(ea, currentScene.find((element) => element.id === state.rootId), currentScene);
                const currentBorder = resolveAnchor(ea, currentScene.find((element) => element.id === state.borderId), currentScene);
                if (!currentRoot || !currentBorder) return;
                const parsed = parseMindmap(ea, currentRoot, state.connectionDistance, currentBorder, state.padding);
                state.graph = parsed.graph;
                parsedNodes = parsed.nodes.slice(1).map((logical) => {
                    const parent = parsed.nodes.find((candidate) => parsed.graph.getNode(logical.anchor.id)?.parentId === candidate.anchor.id);
                    const shape = parsed.graph.getNode(logical.anchor.id)?.shape === "rectangle" ? "rectangle" : "ellipse";
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
            addSpacer(data, "0.5em");
            addText(data, state.graph ? `Graph Statistics:<br>${calculateGraphMetricsString(state.graph).replace(/\n/g, "<br>")}` : "Graph Statistics: Available after parsing");
            addSpacer(data, "0.5em");
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
            addSpacer(algorithm, "0.5em");
            addRangePair(algorithm, "Steps Per Render", 1, 1000, 1, () => undefined);
            addSpacer(algorithm, "0.5em");
            addText(algorithm, "Algorithm-Specific Options: Reserved");

            const control = addSection(content, "Control");
            const firstRow = content.ownerDocument.createElement("div");
            const secondRow = content.ownerDocument.createElement("div");
            firstRow.style.display = secondRow.style.display = "grid";
            firstRow.style.gap = secondRow.style.gap = "0.5em";
            firstRow.style.gridTemplateColumns = "auto auto auto";
            secondRow.style.gridTemplateColumns = "auto auto";
            const start = addButton(firstRow, "Start");
            start.addEventListener("click", async () => {
                try {
                    showNotice("Starting Mindmap Layouting... (This is a placeholder action.)");
                    const file = ea.targetView?.file;
                    if (!file) {
                        throw new Error("No drawing is open.");
                    }
                    await clearIndicators(ea, indicators, viewApi);
                    await saveCurrentDrawing(ea);
                    await createMindmapBackup(ea.plugin.app, file).then((backup) => {
                        showNotice(`Mindmap Backup Created: ${backup.file.path}`);
                    });
                } catch (error) {
                    reportError("Could not create the mindmap backup.", error);
                }
                renderMain();
            });
            for (const label of ["Step", "Reset"]) addButton(firstRow, label).disabled = true;
            const activeFile = ea.targetView?.file;
            const backups = activeFile ? listMindmapBackups(ea.plugin.app, activeFile) : [];
            const rollback = addButton(secondRow, "Rollback");
            rollback.disabled = !activeFile || backups.length === 0;
            rollback.addEventListener("click", () => {
                if (!activeFile) return;
                confirmAction(ea, "Restore the newest backup for this drawing?", async () => {
                    try {
                        await clearIndicators(ea, indicators, viewApi);
                        const restored = await rollbackLatestMindmapBackup(
                            ea.plugin.app,
                            activeFile,
                            async () => {
                                const leaf = ea.targetView?.leaf;
                                if (!leaf) throw new Error("The drawing view is no longer available.");
                                await leaf.openFile(activeFile, { active: true });
                            },
                        );
                        if (restored) {
                            showNotice("Mindmap backup restored.");
                        }
                    } catch (error) {
                        reportError("Could not restore the mindmap backup.", error);
                    }
                    renderMain();
                });
            });
            const clearBackups = addButton(secondRow, "Clear Backups");
            clearBackups.disabled = !activeFile || backups.length === 0;
            clearBackups.addEventListener("click", () => {
                if (!activeFile) return;
                confirmAction(ea, "Delete all backups for this drawing?", async () => {
                    try {
                        await clearMindmapBackups(ea.plugin.app, activeFile);
                        showNotice("Mindmap backups cleared.");
                    } catch (error) {
                        reportError("Could not clear the mindmap backups.", error);
                    }
                    renderMain();
                });
            });
            control.append(firstRow, secondRow);
            addSpacer(control, "0.5em");
            addText(control, "Current Step / Total Steps: - / -");
            addText(control, "Milliseconds Per Step: Now - | Min - | Average - | Max -");
            addCredit(content);
            if (refreshInd) {
                void refreshConfiguredIndicators(ea, indicators, state, parsedNodes);
            }
        };
        void repairRootFlags(ea, state).then(() => {
            const startupScene = ea.getViewElements();
            const startupBorder = resolveAnchor(ea, startupScene.find((element) => element.id === state.borderId), startupScene);
            const startupRoot = resolveAnchor(ea, startupScene.find((element) => element.id === state.rootId), startupScene);
            if (startupBorder && startupRoot) {
                const loaded = loadMindmapFromMetadata(ea, startupRoot, startupBorder, state.padding);
                state.graph = loaded.graph;
                parsedNodes = loaded.nodes.slice(1).map((logical) => {
                    const parent = loaded.nodes.find((candidate) => loaded.graph.getNode(logical.anchor.id)?.parentId === candidate.anchor.id);
                    const shape = loaded.graph.getNode(logical.anchor.id)?.shape === "rectangle" ? "rectangle" : "ellipse";
                    return parent ? { logical, parent, shape } : { logical, shape };
                });
            } else {
                delete state.graph;
                parsedNodes = [];
            }
            renderMain();
        });
    };
    modal.onClose = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        void clearIndicators(ea, indicators, viewApi).catch((error) => {
            reportError("Could not remove mindmap indicators before closing the drawing.", error);
        });
    };
    const targetView = ea.targetView;
    const viewApi = ea.getExcalidrawAPI();
    const previousUnloadHook = ea.onViewUnloadHook;
    const closeAndClearIndicators = (): void => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        modal.close();
        void clearIndicators(ea, indicators, viewApi).catch((error) => {
            reportError("Could not remove mindmap indicators before closing the drawing.", error);
        });
    };
    ea.onViewUnloadHook = (view) => {
        if (view === targetView) closeAndClearIndicators();
        previousUnloadHook(view);
    };
    ea.registerCleanup(() => {
        ea.onViewUnloadHook = previousUnloadHook;
        closeAndClearIndicators();
    });
    modal.open();
    return { close: () => modal.close() };
}