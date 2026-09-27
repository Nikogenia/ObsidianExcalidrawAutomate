import {
    clearIndicators,
    refreshBorderIndicator,
    refreshRootIndicator,
    type IndicatorState,
} from "./indicators";
import {
    clampInteger,
    loadRuntimeState,
    normalizeShape,
    type MindmapPadding,
    type MindmapRuntimeState,
} from "./metadata";

type CustomDataPatch = Parameters<ExcalidrawAutomate["addAppendUpdateCustomData"]>[1];

const CREDIT =
    "Nikolas Beyer | W-Seminar Informatik 2027 (Bodensee-Gymnasium Lindau) | " +
    "BOGYLI/simulierte-wirklichkeit";

function addText(parent: HTMLElement, text: string): HTMLParagraphElement {
    const element = parent.ownerDocument.createElement("p");
    element.textContent = text;
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
    await ea.addElementsToView(false, true);
    ea.clear();
}

function elementLabel(element: ExcalidrawElement | undefined): string {
    return element ? `${element.type} (${element.id})` : "Not configured";
}

function createBorderModal(
    ea: ExcalidrawAutomate,
    state: MindmapRuntimeState,
    indicators: IndicatorState,
    onSaved: () => Promise<void>,
): void {
    const modal = new ea.FloatingModal(ea.plugin.app);
    modal.titleEl.textContent = "Border Settings";
    modal.onOpen = () => {
        const content = modal.contentEl;
        content.empty();
        const scene = ea.getViewElements();
        let candidate = scene.find((element) => element.id === state.borderId);
        addText(content, `Current candidate: ${elementLabel(candidate)}`);
        const choose = addButton(content, "Use current selection");
        choose.addEventListener("click", () => {
            const selected = ea.getViewSelectedElements();
            if (selected.length === 1) {
                candidate = selected[0];
                addText(content, `Candidate: ${elementLabel(candidate)}`);
            }
        });

        const nextPadding: MindmapPadding = { ...state.padding };
        const preview = async (): Promise<void> => refreshBorderIndicator(ea, indicators, candidate, nextPadding);
        for (const side of ["top", "left", "bottom", "right"] as const) {
            addRangePair(content, side, -120, 120, nextPadding[side], (value) => {
                nextPadding[side] = value;
                void preview();
            });
        }
        const actions = content.ownerDocument.createElement("div");
        const save = addButton(actions, "Save");
        const cancel = addButton(actions, "Cancel");
        save.addEventListener("click", () => {
            if (!candidate) return;
            const selectedCandidate = candidate;
            const previous = scene.find((element) => element.id === state.borderId);
            const paddingData = { ...nextPadding } as Record<string, number>;
            void saveMetadata(ea, [selectedCandidate, ...(previous && previous.id !== selectedCandidate.id ? [previous] : [])], [
                ...(previous && previous.id !== selectedCandidate.id
                    ? [{ id: previous.id, patch: { isMindmapBorder: undefined, mindmapPadding: undefined } }]
                    : []),
                { id: selectedCandidate.id, patch: { isMindmapBorder: true, mindmapPadding: paddingData } },
            ]).then(() => {
                state.borderId = selectedCandidate.id;
                state.padding = { ...nextPadding };
                modal.close();
                return onSaved();
            });
        });
        cancel.addEventListener("click", () => {
            modal.close();
        });
        content.appendChild(actions);
        void preview();
    };
    modal.onClose = () => {
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
    const modal = new ea.FloatingModal(ea.plugin.app);
    let closed = false;
    modal.titleEl.textContent = "Automatic Mindmap Layouting";
    modal.onOpen = () => {
        const content = modal.contentEl;
        content.empty();
        const data = addSection(content, "Mindmap Data");
        const border = scene.find((element) => element.id === state.borderId);
        addText(data, `Border: ${elementLabel(border)}`);
        const configureBorder = addButton(data, "Configure border");
        configureBorder.addEventListener("click", () => createBorderModal(ea, state, indicators, async () => {
            await refreshBorderIndicator(ea, indicators, scene.find((element) => element.id === state.borderId), state.padding);
        }));
        const root = scene.find((element) => element.id === state.rootId);
        addText(data, `Root: ${elementLabel(root)}`);
        const selectRoot = addButton(data, root ? "Select root element" : "Select root element");
        selectRoot.addEventListener("click", () => {
            const selected = ea.getViewSelectedElements();
            if (selected.length !== 1) return;
            const selectedRoot = selected[0];
            const shape = normalizeShape(selectedRoot.type);
            void saveMetadata(ea, [selectedRoot], [{
                id: selectedRoot.id,
                patch: {
                    isMindmapRoot: true,
                    isMindmapNode: true,
                    mindmapShape: shape,
                    mindmapConnectionDistance: state.connectionDistance,
                    mindmapChildren: [],
                },
            }]).then(() => {
                state.rootId = selectedRoot.id;
                state.rootShape = shape;
                void refreshRootIndicator(ea, indicators, selectedRoot);
            });
        });
        addText(data, "Graph statistics: available after parsing");
        addRangePair(data, "Connection distance", 1, 300, state.connectionDistance, (value) => {
            state.connectionDistance = value;
        });
        const parse = addButton(data, "Parse Mindmap");
        parse.disabled = !state.rootId;
        parse.addEventListener("click", () => addText(data, "Parsing hook ready; graph parser is the next implementation slice."));
        addButton(data, "Clear Mindmap").disabled = true;
        addButton(data, "Clear All Metadata").disabled = true;

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
        for (const label of ["Start", "Step", "Reset", "Rollback", "Clear backups"]) {
            const button = addButton(control, label);
            button.disabled = true;
        }
        addText(control, "Current step / total steps: - / -");
        addText(control, "Milliseconds per step: now - | min - | average - | max -");
        addText(content, CREDIT);

        void refreshBorderIndicator(ea, indicators, border, state.padding);
        void refreshRootIndicator(ea, indicators, root);
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