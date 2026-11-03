export interface LogicalElement {
    anchor: ExcalidrawElement;
    elements: ExcalidrawElement[];
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

/**
 * Returns the container ID of a container-bound text element.
 *
 * @param element Scene element.
 * @returns The container ID, or undefined for every other element.
 */
export function containerIdOf(element: ExcalidrawElement): string | undefined {
    if (element.type !== "text") return undefined;
    const containerId = (element as ExcalidrawElement & { containerId?: string | null }).containerId;
    return containerId ?? undefined;
}

/**
 * Replaces container-bound text with its container and removes duplicates.
 *
 * `ea.getViewSelectedElements()` adds the bound text of every selected
 * container, and `getMaximumGroups` treats an ungrouped bound text as its own
 * group. Without this normalization a plain labelled rectangle would count as
 * two logical elements.
 *
 * @param selection Selected elements.
 * @param scene Current scene elements.
 * @returns Selection without bound text, with lone bound text mapped to its container.
 */
export function normalizeBoundText(
    selection: readonly ExcalidrawElement[],
    scene: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const result = new Map<string, ExcalidrawElement>();
    for (const element of selection) {
        const containerId = containerIdOf(element);
        const resolved = containerId ? byId.get(containerId) ?? element : element;
        result.set(resolved.id, resolved);
    }
    return [...result.values()];
}

function withBoundText(
    elements: readonly ExcalidrawElement[],
    scene: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
    const ids = new Set(elements.map((element) => element.id));
    const boundText = scene.filter((element) => {
        const containerId = containerIdOf(element);
        return !ids.has(element.id) && containerId !== undefined && ids.has(containerId);
    });
    return [...elements, ...boundText];
}

/**
 * Resolves a canvas selection to one logical element or group.
 *
 * EA exposes group members as individual elements sharing groupIds. A selection
 * is valid when it contains one maximum group; the full group is then resolved
 * from the scene and its largest element is used as the stable metadata anchor.
 * Container-bound text is folded into its container and included in the
 * logical member list so that moving the logical element moves its label.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param selection Current canvas selection.
 * @param scene Current scene elements.
 * @returns One logical element, or undefined for an ambiguous selection.
 */
export function resolveLogicalSelection(
    ea: ExcalidrawAutomate,
    selection: readonly ExcalidrawElement[],
    scene: readonly ExcalidrawElement[],
): LogicalElement | undefined {
    const selected = normalizeBoundText(selection, scene);
    if (selected.length === 0) return undefined;
    const maximumGroups = ea.getMaximumGroups(selected);
    if (maximumGroups.length > 1) return undefined;

    const commonGroup = ea.getCommonGroupForElements(selected);
    if (selected.length > 1 && !commonGroup) return undefined;
    const first = selected[0];
    const members = ea.getElementsInTheSameGroupWithElement(first, scene);
    const groupElements = members.length > 0 ? members : [first];
    const anchorCandidates = groupElements.filter((element) => containerIdOf(element) === undefined);
    const anchor = ea.getLargestElement(anchorCandidates.length > 0 ? anchorCandidates : groupElements);
    const elements = withBoundText(groupElements, scene);
    const bounds = ea.getBoundingBox(elements);
    return {
        anchor,
        elements,
        bounds: {
            x: bounds.topX,
            y: bounds.topY,
            width: bounds.width,
            height: bounds.height,
        },
    };
}

/**
 * Resolves a persisted anchor and expands it to its current group members.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param anchor Persisted anchor element.
 * @param scene Current scene elements.
 * @returns The logical element represented by the anchor.
 */
export function resolveAnchor(
    ea: ExcalidrawAutomate,
    anchor: ExcalidrawElement | undefined,
    scene: readonly ExcalidrawElement[],
): LogicalElement | undefined {
    if (!anchor) return undefined;
    return resolveLogicalSelection(ea, [anchor], scene);
}

/**
 * Resolves a persisted anchor ID against the current scene.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param id Persisted anchor ID.
 * @param scene Current scene elements.
 * @returns The current logical element, or undefined when the anchor is gone.
 */
export function resolveAnchorId(
    ea: ExcalidrawAutomate,
    id: string | undefined,
    scene: readonly ExcalidrawElement[],
): LogicalElement | undefined {
    if (!id) return undefined;
    return resolveAnchor(ea, scene.find((element) => element.id === id), scene);
}
