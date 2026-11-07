import { shapeOf, type MindmapPadding, type MindmapShape } from "./metadata";
import { resolveAnchorId, type LogicalElement } from "./groups";
import { CAPTURE_NEVER, isTemporary, moveElements, removeTemporaryElementsNow } from "./scene";

export type IndicatorKind = "border" | "root" | "node" | "fixed" | "arrow";
type IndicatorType = "rectangle" | "ellipse" | "arrow";
type Points = [number, number][];

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Geometry extends Bounds {
    /** Arrow points relative to (x, y); omitted for rectangles and ellipses. */
    points?: Points;
}

/** One indicator owned by the runtime. Never persisted in metadata. */
export interface IndicatorRecord {
    id: string;
    kind: IndicatorKind;
    ownerId: string;
    type: IndicatorType;
    /** Geometry the indicator was last placed at, in scene coordinates. */
    geometry: Geometry;
    /** Bounds of the owning logical element when the indicator was placed. */
    contentBounds: Bounds;
}

export interface IndicatorState {
    records: Record<string, IndicatorRecord>;
}

/** A parsed node shown with a green indicator and an arrow to its parent. */
export interface IndicatorNode {
    id: string;
    parentId?: string;
    shape: MindmapShape;
}

/** Everything the indicators are derived from. Resolved against the live scene. */
export interface IndicatorModel {
    borderId?: string;
    padding: MindmapPadding;
    rootId?: string;
    nodes: readonly IndicatorNode[];
    /** Anchor IDs of fixed elements (tree nodes or isolated). */
    fixedIds: readonly string[];
}

interface IndicatorSpec {
    key: string;
    kind: IndicatorKind;
    ownerId: string;
    type: IndicatorType;
    geometry: Geometry;
    contentBounds: Bounds;
    color: string;
}

interface SpecSet {
    specs: IndicatorSpec[];
    logicals: Map<string, LogicalElement>;
}

interface ContentMove {
    ids: Set<string>;
    dx: number;
    dy: number;
}

const COLORS: Record<IndicatorKind, string> = {
    border: "#e03131",
    root: "#1971c2",
    node: "#2f9e44",
    fixed: "#f08c00",
    arrow: "#2f9e44",
};
const EPSILON = 0.5;
/**
 * Indicators around elements are drawn this far outside the element bounds, so
 * they stay visible when they would otherwise coincide with the outline of a
 * node's own border element. The border indicator marks the layout area and is
 * not inflated.
 */
const INDICATOR_OUTSET = 2;
/** A fixed root shows both rings; the orange one is drawn outside the blue one. */
const FIXED_ROOT_OUTSET = 6;
const MAX_ARROW_LENGTH = 60;

/** Creates an empty runtime indicator registry. */
export function createIndicatorState(): IndicatorState {
    return { records: {} };
}

function paddedBounds(bounds: Bounds, padding: MindmapPadding): Bounds {
    return {
        x: bounds.x + padding.left,
        y: bounds.y + padding.top,
        width: Math.max(1, bounds.width - padding.left - padding.right),
        height: Math.max(1, bounds.height - padding.top - padding.bottom),
    };
}

function inflate(bounds: Bounds, outset: number): Bounds {
    return {
        x: bounds.x - outset,
        y: bounds.y - outset,
        width: bounds.width + 2 * outset,
        height: bounds.height + 2 * outset,
    };
}

function centerOf(bounds: Bounds): { x: number; y: number } {
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function near(left: number, right: number): boolean {
    return Math.abs(left - right) < EPSILON;
}

function sameBounds(left: Bounds, right: Bounds): boolean {
    return near(left.x, right.x) && near(left.y, right.y)
        && near(left.width, right.width) && near(left.height, right.height);
}

function samePoints(left: Points | undefined, right: Points | undefined): boolean {
    if (!left || !right) return left === right;
    return left.length === right.length
        && left.every((point, index) => near(point[0], right[index][0]) && near(point[1], right[index][1]));
}

function elementGeometry(element: ExcalidrawElement): Geometry {
    const points = (element as ExcalidrawElement & { points?: readonly (readonly [number, number])[] }).points;
    return {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        ...(points ? { points: points.map(([x, y]) => [x, y] as [number, number]) } : {}),
    };
}

function sameGeometry(left: Geometry, right: Geometry): boolean {
    // Arrow width/height are derived from the points by Excalidraw; compare position and points only.
    if (left.points || right.points) {
        return near(left.x, right.x) && near(left.y, right.y) && samePoints(left.points, right.points);
    }
    return sameBounds(left, right);
}

function arrowGeometry(child: Bounds, parent: Bounds): Geometry {
    const start = centerOf(child);
    const target = centerOf(parent);
    const directionX = target.x - start.x;
    const directionY = target.y - start.y;
    const length = Math.max(Math.hypot(directionX, directionY), 1);
    const arrowLength = Math.min(MAX_ARROW_LENGTH, length / 2);
    const dx = directionX / length * arrowLength;
    const dy = directionY / length * arrowLength;
    return { x: start.x, y: start.y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]] };
}

function shapeSpec(
    key: string,
    kind: IndicatorKind,
    logical: LogicalElement,
    shape: MindmapShape,
    geometry: Bounds = inflate(logical.bounds, INDICATOR_OUTSET),
): IndicatorSpec {
    return {
        key,
        kind,
        ownerId: logical.anchor.id,
        type: shape === "ellipse" ? "ellipse" : "rectangle",
        geometry: { ...geometry },
        contentBounds: { ...logical.bounds },
        color: COLORS[kind],
    };
}

function nodeSpecs(
    model: IndicatorModel,
    resolve: (id: string | undefined) => LogicalElement | undefined,
    excludedIds: ReadonlySet<string>,
): IndicatorSpec[] {
    const specs: IndicatorSpec[] = [];
    const fixedIds = new Set(model.fixedIds);
    for (const node of model.nodes) {
        if (node.id === model.rootId || excludedIds.has(node.id)) continue;
        const logical = resolve(node.id);
        if (!logical) continue;
        // A fixed node shows the orange fixed indicator instead of the green one; its arrow stays.
        if (!fixedIds.has(node.id)) specs.push(shapeSpec(`node:${node.id}`, "node", logical, node.shape));
        const parent = resolve(node.parentId);
        if (!parent) continue;
        specs.push({
            key: `arrow:${node.id}`,
            kind: "arrow",
            ownerId: node.id,
            type: "arrow",
            geometry: arrowGeometry(logical.bounds, parent.bounds),
            contentBounds: { ...logical.bounds },
            color: COLORS.arrow,
        });
    }
    return specs;
}

function fixedSpecs(
    model: IndicatorModel,
    resolve: (id: string | undefined) => LogicalElement | undefined,
    excludedIds: ReadonlySet<string>,
): IndicatorSpec[] {
    const specs: IndicatorSpec[] = [];
    for (const id of model.fixedIds) {
        const logical = excludedIds.has(id) ? undefined : resolve(id);
        if (!logical) continue;
        const outset = id === model.rootId ? FIXED_ROOT_OUTSET : INDICATOR_OUTSET;
        specs.push(shapeSpec(`fixed:${id}`, "fixed", logical, shapeOf(logical.anchor), inflate(logical.bounds, outset)));
    }
    return specs;
}

/**
 * Derives the desired indicators from the model and the live scene.
 * Owners that no longer exist (deleted content) simply produce no indicator.
 */
function buildSpecs(ea: ExcalidrawAutomate, model: IndicatorModel, scene: readonly ExcalidrawElement[]): SpecSet {
    const logicals = new Map<string, LogicalElement>();
    const resolve = (id: string | undefined): LogicalElement | undefined => {
        if (!id) return undefined;
        if (!logicals.has(id)) {
            const logical = resolveAnchorId(ea, id, scene);
            if (logical) logicals.set(id, logical);
        }
        return logicals.get(id);
    };
    const specs: IndicatorSpec[] = [];
    const border = resolve(model.borderId);
    if (border) {
        specs.push(shapeSpec("border", "border", border, "rectangle", paddedBounds(border.bounds, model.padding)));
    }
    const root = resolve(model.rootId);
    if (root) specs.push(shapeSpec("root", "root", root, shapeOf(root.anchor)));
    const borderIds = new Set(border?.elements.map((element) => element.id));
    specs.push(...nodeSpecs(model, resolve, borderIds));
    specs.push(...fixedSpecs(model, resolve, borderIds));
    return { specs, logicals };
}

/**
 * Finds indicators the user dragged while their content stayed in place.
 *
 * Rule: if the owner's bounds still equal the recorded content bounds and the
 * indicator moved without being resized, the content follows the indicator.
 * In every other case (content moved, both moved, indicator resized) the
 * indicator is snapped back onto the content by the reconcile step.
 */
function detectIndicatorDrags(
    state: IndicatorState,
    scene: readonly ExcalidrawElement[],
    logicals: ReadonlyMap<string, LogicalElement>,
): ContentMove[] {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const moves = new Map<string, ContentMove>();
    const claimed = new Set<string>();
    for (const record of Object.values(state.records)) {
        if (record.kind === "arrow") continue;
        const element = byId.get(record.id);
        const logical = logicals.get(record.ownerId);
        if (!element || !logical || !sameBounds(logical.bounds, record.contentBounds)) continue;
        const dx = element.x - record.geometry.x;
        const dy = element.y - record.geometry.y;
        const resized = !near(element.width, record.geometry.width) || !near(element.height, record.geometry.height);
        if (resized || (near(dx, 0) && near(dy, 0))) continue;
        const key = `${Math.round(dx)}:${Math.round(dy)}`;
        const move = moves.get(key) ?? { ids: new Set<string>(), dx, dy };
        for (const member of logical.elements) {
            if (claimed.has(member.id)) continue;
            claimed.add(member.id);
            move.ids.add(member.id);
        }
        moves.set(key, move);
    }
    return [...moves.values()].filter((move) => move.ids.size > 0);
}

function createIndicator(ea: ExcalidrawAutomate, spec: IndicatorSpec): string {
    ea.style.strokeColor = spec.color;
    ea.style.strokeStyle = "dashed";
    ea.style.strokeWidth = 2;
    ea.style.backgroundColor = "transparent";
    ea.style.opacity = 100;
    const { x, y, width, height, points } = spec.geometry;
    let id: string;
    if (spec.type === "arrow") {
        id = ea.addArrow((points ?? [[0, 0], [0, 0]]).map(([px, py]) => [x + px, y + py] as [number, number]), {
            startArrowHead: null,
            endArrowHead: "arrow",
        });
    } else {
        id = spec.type === "ellipse" ? ea.addEllipse(x, y, width, height) : ea.addRect(x, y, width, height);
    }
    ea.addAppendUpdateCustomData(id, {
        isMindmapTemporary: true,
        mindmapIndicatorKind: spec.kind,
        mindmapIndicatorOwner: spec.ownerId,
    });
    return id;
}

function updateIndicator(ea: ExcalidrawAutomate, id: string, geometry: Geometry): void {
    const editable = ea.getElement(id);
    editable.x = geometry.x;
    editable.y = geometry.y;
    editable.width = geometry.width;
    editable.height = geometry.height;
    if (geometry.points) (editable as unknown as { points: Points }).points = geometry.points.map(([px, py]) => [px, py]);
}

function recordFor(spec: IndicatorSpec, id: string): IndicatorRecord {
    return {
        id,
        kind: spec.kind,
        ownerId: spec.ownerId,
        type: spec.type,
        geometry: spec.geometry,
        contentBounds: spec.contentBounds,
    };
}

/**
 * Applies the desired indicator set in at most one unsaved, non-undoable
 * transaction. Indicators whose type is unchanged are updated in place, so
 * their IDs (and therefore the user's selection) survive geometry changes.
 */
async function reconcile(
    ea: ExcalidrawAutomate,
    state: IndicatorState,
    specs: readonly IndicatorSpec[],
    scene: readonly ExcalidrawElement[],
): Promise<boolean> {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const nextRecords: Record<string, IndicatorRecord> = {};
    const updates: { id: string; geometry: Geometry }[] = [];
    const creates: IndicatorSpec[] = [];
    const keptIds = new Set<string>();
    for (const spec of specs) {
        const record = state.records[spec.key];
        const element = record ? byId.get(record.id) : undefined;
        if (!record || !element || record.type !== spec.type) {
            creates.push(spec);
            continue;
        }
        keptIds.add(record.id);
        nextRecords[spec.key] = recordFor(spec, record.id);
        if (!sameGeometry(elementGeometry(element), spec.geometry)) updates.push({ id: record.id, geometry: spec.geometry });
    }
    const deletions = scene.filter((element) => isTemporary(element) && !keptIds.has(element.id));
    if (updates.length === 0 && creates.length === 0 && deletions.length === 0) {
        state.records = nextRecords;
        return false;
    }
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing([...deletions, ...updates.map(({ id }) => byId.get(id)!)]);
        for (const element of deletions) ea.getElement(element.id).isDeleted = true;
        for (const { id, geometry } of updates) updateIndicator(ea, id, geometry);
        for (const spec of creates) nextRecords[spec.key] = recordFor(spec, createIndicator(ea, spec));
        await ea.addElementsToView(false, false, true, false, CAPTURE_NEVER);
        state.records = nextRecords;
    } finally {
        ea.clear();
    }
    return true;
}

/**
 * Synchronizes the temporary indicators with the model and the live scene.
 *
 * 1. Indicators the user dragged move their content by the same offset
 *    (one undoable transaction per distinct offset).
 * 2. All indicators are reconciled against the (possibly moved) content:
 *    moved content pulls its indicators and parent/child arrows along, deleted
 *    content loses its indicators, deleted indicators are recreated, and unknown
 *    temporary elements (for example leftovers from a crashed session) are removed.
 *
 * Must run inside the workbench transaction queue.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param state Mutable indicator registry.
 * @param model Desired indicator model.
 * @returns Whether content was moved or indicators changed.
 */
export async function syncIndicators(
    ea: ExcalidrawAutomate,
    state: IndicatorState,
    model: IndicatorModel,
): Promise<{ contentMoved: boolean; indicatorsChanged: boolean }> {
    const initialScene = ea.getViewElements();
    const initial = buildSpecs(ea, model, initialScene);
    const moves = detectIndicatorDrags(state, initialScene, initial.logicals);
    for (const move of moves) await moveElements(ea, move.ids, move.dx, move.dy);
    const scene = moves.length > 0 ? ea.getViewElements() : initialScene;
    const { specs } = moves.length > 0 ? buildSpecs(ea, model, scene) : initial;
    const indicatorsChanged = await reconcile(ea, state, specs, scene);
    return { contentMoved: moves.length > 0, indicatorsChanged };
}

/**
 * Maps selected indicators to the content element they represent.
 *
 * Indicators sit on top of their content, so clicks usually hit the indicator.
 * Every selection-driven action resolves the selection through this function
 * first, which makes selecting an indicator equivalent to selecting its owner.
 *
 * @param selection Current selection.
 * @param scene Current scene elements.
 * @returns Selection with indicators replaced by their owners, without duplicates.
 */
export function resolveIndicatorOwners(
    selection: readonly ExcalidrawElement[],
    scene: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const result = new Map<string, ExcalidrawElement>();
    for (const element of selection) {
        if (!isTemporary(element)) {
            result.set(element.id, element);
            continue;
        }
        const ownerId = (element.customData as Record<string, unknown> | undefined)?.mindmapIndicatorOwner;
        const owner = typeof ownerId === "string" ? byId.get(ownerId) : undefined;
        if (owner && !isTemporary(owner)) result.set(owner.id, owner);
    }
    return [...result.values()];
}

/**
 * Deletes every temporary element and resets the registry. Synchronous; usable
 * while the view is alive and also from `onViewUnloadHook`.
 *
 * @param api Imperative API captured while the view was alive.
 * @param state Mutable indicator registry.
 */
export function clearIndicatorsNow(api: ExcalidrawAPI | null | undefined, state: IndicatorState): void {
    removeTemporaryElementsNow(api);
    state.records = {};
}
