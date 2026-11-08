import p5 from "p5";
import { TreeEdgeGraph } from "./core/graph/TreeEdgeGraph";
import type { TreeNode } from "./core/graph/types";
import { isFixedFlagged, readEdgeMetadata, shapeOf, type LineEnd, type MindmapPadding } from "./metadata";
import { containerIdOf, resolveAnchor, type LogicalElement } from "./groups";
import { bindLineToEdge, excalidrawCornerRadius, lineEndpoints, type EdgeBinding, type Point } from "./edges";

export interface ParsedMindmap {
    graph: TreeEdgeGraph;
    nodes: LogicalElement[];
    /** Line element of each edge, keyed by child ID like `TreeEdgeGraph.edges`. */
    edges: Map<string, EdgeBinding>;
    /** Anchor IDs of fixed nodes (tree nodes and isolated fixed elements), in scene order. */
    fixedIds: string[];
    coordinateSpace: CoordinateSpace;
    /** Border element and its group members; never parse candidates or lines. */
    borderIds: string[];
    /** Corner radius of every tree node drawn as a rounded rectangle (`cornerRadiusOf`). */
    cornerRadii: Map<string, number>;
    /** Tree nodes with a visible outline of their own shape (`hasVisibleOutline`); lines end just outside it. */
    outlinedIds: Set<string>;
}

/**
 * Leading short code: one or more letters (any case) immediately followed by a
 * digit, then any further letters, digits, and dots up to the first whitespace
 * or the end of the name (`M12`, `M12.1`, `M12.1b`, `inf11a`, `Ph10.4.2`).
 * Any other character before the first whitespace (`M12.1,`, `M12_notes`)
 * means the name has no code.
 */
const SHORT_CODE = /^(\p{L}+\d[\p{L}\p{N}.]*)(?=\s|$)/u;

/**
 * Graph name for a drawing file: `Mindmap <code>` when the file name starts
 * with a short code such as `M12.1`, otherwise the file name itself.
 *
 * @param basename File name without the `.md` extension (`TFile.basename`).
 * @returns The graph name.
 */
export function mindmapName(basename: string): string {
    const name = basename.trim();
    const code = SHORT_CODE.exec(name)?.[1];
    if (code) return `Mindmap ${code}`;
    return name || "Mindmap";
}

/** Distances (px) closer than this count as equal in the nearest search. */
const TIE_EPSILON = 1e-6;

/** Default anchor region, matching the default of `TreeEdgeGraph` and the Nikogenia algorithm. */
const MAX_OFFSET_RATIO = 0.5;

export interface CoordinateSpace {
    origin: Point;
    width: number;
    height: number;
}

export function sceneToGraphPoint(point: Point, coordinateSpace: CoordinateSpace): Point {
    return {
        x: point.x - coordinateSpace.origin.x,
        y: point.y - coordinateSpace.origin.y,
    };
}

export function graphToScenePoint(point: Point, coordinateSpace: CoordinateSpace): Point {
    return {
        x: point.x + coordinateSpace.origin.x,
        y: point.y + coordinateSpace.origin.y,
    };
}

function customData(element: ExcalidrawElement): Record<string, unknown> {
    return (element.customData as Record<string, unknown> | undefined) ?? {};
}

function isTemporaryElement(element: ExcalidrawElement): boolean {
    return customData(element).isMindmapTemporary === true;
}

/**
 * Resolves every element flagged `isMindmapFixed` to its logical element.
 *
 * Lines, arrows, and members of the border are never fixed nodes (the UI does
 * not flag them, and a stale flag is ignored here). Several flagged members of
 * one group count once.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param scene Current scene elements.
 * @param border Configured border, if any.
 * @returns Fixed logical elements keyed by anchor ID, in scene order.
 */
export function resolveFixedElements(
    ea: ExcalidrawAutomate,
    scene: readonly ExcalidrawElement[],
    border: LogicalElement | undefined,
): Map<string, LogicalElement> {
    const borderIds = new Set(border?.elements.map((element) => element.id));
    const fixed = new Map<string, LogicalElement>();
    for (const element of scene) {
        if (!isFixedFlagged(element) || isTemporaryElement(element) || borderIds.has(element.id)) continue;
        if (element.type === "line" || element.type === "arrow") continue;
        const logical = resolveAnchor(ea, element, scene);
        if (logical && !logical.elements.some((member) => borderIds.has(member.id))) fixed.set(logical.anchor.id, logical);
    }
    return fixed;
}

/**
 * Marks fixed elements in the graph: a fixed tree node keeps its place in the
 * tree, every other fixed element becomes an isolated node without parent edge
 * (`TreeNode.fixed`, e.g. a logo reserving its space).
 */
function addFixedNodes(graph: TreeEdgeGraph, fixed: ReadonlyMap<string, LogicalElement>, space: CoordinateSpace): string[] {
    for (const [id, logical] of fixed) {
        if (graph.getNode(id)) graph.setFixed(id, true);
        else graph.addNode({ ...nodeFor(logical, undefined, space), fixed: true });
    }
    return [...fixed.keys()];
}

function center(logical: LogicalElement): Point {
    return {
        x: logical.bounds.x + logical.bounds.width / 2,
        y: logical.bounds.y + logical.bounds.height / 2,
    };
}

/** Geometry the parser sees of one logical element: ID, bounds, and effective shape. */
export interface ParseTarget {
    id: string;
    bounds: LogicalElement["bounds"];
    shape: "ellipse" | "rectangle";
}

/** A logical element that may become a node, with its scene order for tie breaks. */
export interface ParseCandidate {
    target: ParseTarget;
    order: number;
}

/** End points of one line or arrow the parser inspects (scene coordinates). */
export interface ParseLine {
    id: string;
    start: Point;
    end: Point;
}

/** One edge accepted by `traverseLines`. */
export interface TraversedEdge {
    lineId: string;
    parentId: string;
    childId: string;
    parentEnd: LineEnd;
    /** Line end at the parent, scene coordinates. */
    parentPoint: Point;
    /** Line end at the child, scene coordinates. */
    childPoint: Point;
}

export function targetOf(logical: LogicalElement): ParseTarget {
    return { id: logical.anchor.id, bounds: logical.bounds, shape: shapeOf(logical.anchor) };
}

/**
 * Distance used for connection matching: Euclidean distance to the rectangle
 * (0 inside it), and for ellipses the radial distance to the boundary along the
 * ray from the center (inside as well, so a point deep inside is "far").
 */
export function distanceToBoundary(point: Point, target: ParseTarget): number {
    const dx = point.x - (target.bounds.x + target.bounds.width / 2);
    const dy = point.y - (target.bounds.y + target.bounds.height / 2);
    if (target.shape === "ellipse") {
        const radiusX = Math.max(target.bounds.width / 2, 1);
        const radiusY = Math.max(target.bounds.height / 2, 1);
        const normalizedDistance = Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY));
        const boundary = Math.sqrt((dx * dx) + (dy * dy)) / Math.max(normalizedDistance, 1e-6);
        return Math.abs(Math.sqrt((dx * dx) + (dy * dy)) - boundary);
    }
    const distanceX = Math.max(Math.abs(dx) - target.bounds.width / 2, 0);
    const distanceY = Math.max(Math.abs(dy) - target.bounds.height / 2, 0);
    return Math.sqrt(distanceX * distanceX + distanceY * distanceY);
}

function isLoop(candidateId: string, parentId: string, parentById: Map<string, string | undefined>): boolean {
    let current: string | undefined = parentId;
    while (current) {
        if (current === candidateId) return true;
        current = parentById.get(current);
    }
    return false;
}

/** A node candidate with its resolved logical element. */
export interface LogicalCandidate {
    logical: LogicalElement;
    order: number;
}

/**
 * Elements the parser works on: no temporary indicators, no border flag, and
 * no member of the configured border group.
 */
export function parseScene(elements: readonly ExcalidrawElement[], borderIds: Iterable<string>): ExcalidrawElement[] {
    const excluded = new Set(borderIds);
    return elements.filter((element) => {
        const data = customData(element);
        return data.isMindmapTemporary !== true && data.isMindmapBorder !== true && !excluded.has(element.id);
    });
}

/** End points of every line and arrow of the scene, in scene order. */
export function parseLines(scene: readonly ExcalidrawElement[]): ParseLine[] {
    const lines: ParseLine[] = [];
    for (const element of scene) {
        const endpoints = lineEndpoints(element);
        if (endpoints) lines.push({ id: element.id, ...endpoints });
    }
    return lines;
}

/**
 * Resolves every element that may become a node exactly once per parse.
 * Lines, arrows, and container-bound text are never candidates; a group is
 * represented once, by its anchor.
 */
export function nodeCandidates(scene: readonly ExcalidrawElement[], ea: ExcalidrawAutomate): LogicalCandidate[] {
    const candidates: LogicalCandidate[] = [];
    scene.forEach((element, order) => {
        if (element.type === "line" || element.type === "arrow" || containerIdOf(element) !== undefined) return;
        const logical = resolveAnchor(ea, element, scene);
        if (logical && logical.anchor.id === element.id) candidates.push({ logical, order });
    });
    return candidates;
}

/**
 * Returns the eligible element nearest to a line endpoint.
 *
 * Already queued elements stay in the candidate set on purpose. Excluding them
 * would make a line back to an already parsed node (for example the edge to the
 * parent) resolve to the next-nearest unrelated element. The caller rejects a
 * queued result instead.
 */
function nearestCandidate(
    endpoint: Point,
    candidates: readonly ParseCandidate[],
    connectionDistance: number,
): ParseTarget | undefined {
    let best: { target: ParseTarget; distance: number; depth: number; order: number } | undefined;
    for (const { target, order } of candidates) {
        const distance = distanceToBoundary(endpoint, target);
        if (distance > connectionDistance) continue;
        const depth = insideDepth(endpoint, target);
        // Differences below TIE_EPSILON are rounding noise (a line end computed on an outline lies 1e-14 px off it).
        const nearer = !best || distance < best.distance - TIE_EPSILON
            || (distance <= best.distance + TIE_EPSILON && (depth < best.depth - TIE_EPSILON
                || (depth <= best.depth + TIE_EPSILON && order < best.order)));
        if (nearer) best = { target, distance, depth, order };
    }
    return best?.target;
}

/**
 * Tie-break of the nearest search: how far a point lies inside a rectangle
 * (distance to its nearest side, 0 outside). Every point inside a rectangle
 * has distance 0, so a line end inside several overlapping boxes used to go
 * to the first box in scene order. Now the element whose outline is closest
 * wins: an end drawn on its node's outline beats a neighbour box that merely
 * contains it (layouts with node-edge overlaps). Ellipse distances are already
 * measured to the outline inside the ellipse, so their depth is 0.
 */
function insideDepth(point: Point, target: ParseTarget): number {
    if (target.shape === "ellipse") return 0;
    const dx = Math.abs(point.x - (target.bounds.x + target.bounds.width / 2));
    const dy = Math.abs(point.y - (target.bounds.y + target.bounds.height / 2));
    return Math.max(0, Math.min(target.bounds.width / 2 - dx, target.bounds.height / 2 - dy));
}

/**
 * The parser's breadth-first line traversal (section 6 of the spec) on plain
 * geometry. Pure, so that the layout write-back can check that the drawing it
 * is about to write parses back to the same tree (`layout.ts`). Parsing and
 * that check must both use this one function.
 *
 * @param root Root target, the first queued node.
 * @param candidates Every eligible element (the root included), in scene order.
 * @param lines Every line and arrow, in scene order.
 * @param connectionDistance Maximum endpoint-to-boundary distance.
 * @returns The accepted edges in acceptance order (every parent before its children).
 */
export function traverseLines(
    root: ParseTarget,
    candidates: readonly ParseCandidate[],
    lines: readonly ParseLine[],
    connectionDistance: number,
): TraversedEdge[] {
    const queue: ParseTarget[] = [root];
    const queued = new Set([root.id]);
    const parentById = new Map<string, string | undefined>([[root.id, undefined]]);
    const accepted: TraversedEdge[] = [];
    const candidateIds = new Set(candidates.map(({ target }) => target.id));
    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        // A line end belongs to its nearest element: within reach is not enough when another element is nearer.
        const owns = (point: Point): boolean =>
            distanceToBoundary(point, parent) <= connectionDistance
            && (!candidateIds.has(parent.id) || nearestCandidate(point, candidates, connectionDistance)?.id === parent.id);
        for (const line of lines) {
            const nearStart = owns(line.start);
            const nearEnd = !nearStart && owns(line.end);
            if (!nearStart && !nearEnd) continue;
            const parentEnd: LineEnd = nearStart ? "start" : "end";
            const parentPoint = nearStart ? line.start : line.end;
            const childPoint = nearStart ? line.end : line.start;
            const candidate = nearestCandidate(childPoint, candidates, connectionDistance);
            if (!candidate || queued.has(candidate.id)) continue;
            if (isLoop(candidate.id, parent.id, parentById)) continue;
            queued.add(candidate.id);
            parentById.set(candidate.id, parent.id);
            queue.push(candidate);
            accepted.push({ lineId: line.id, parentId: parent.id, childId: candidate.id, parentEnd, parentPoint, childPoint });
        }
    }
    return accepted;
}

/**
 * Corner radius of a node's visible outline, so that lines can end exactly on
 * a rounded rectangle (`edges.ts: outlineExit`). Only when the node is a
 * rectangle node whose anchor is a rounded Excalidraw rectangle filling the
 * node bounds (within 1 px); a group with content outside the rectangle, a
 * text, or an image keeps sharp corners (its outline is the bounding box).
 */
function cornerRadiusOf(logical: LogicalElement): number {
    const anchor = logical.anchor as ExcalidrawElement & { roundness?: { type: number; value?: number } | null };
    if (anchor.type !== "rectangle" || shapeOf(anchor) !== "rectangle" || !anchor.roundness) return 0;
    return fillsBounds(logical) ? excalidrawCornerRadius(anchor.width, anchor.height, anchor.roundness) : 0;
}

/** Whether the anchor's box matches the node bounds within 1 px (no group content outside it). */
function fillsBounds(logical: LogicalElement): boolean {
    const { anchor, bounds } = logical;
    return Math.abs(anchor.x - bounds.x) <= 1 && Math.abs(anchor.y - bounds.y) <= 1
        && Math.abs(anchor.width - bounds.width) <= 1 && Math.abs(anchor.height - bounds.height) <= 1;
}

function isVisibleColor(color: unknown): boolean {
    return typeof color === "string" && color !== "" && color !== "transparent";
}

/** Whether an Excalidraw shape shows a stroke or a fill. */
function isDrawn(element: ExcalidrawElement & { strokeWidth?: number; opacity?: number }): boolean {
    if ((element.opacity ?? 100) <= 0) return false;
    return (isVisibleColor(element.strokeColor) && (element.strokeWidth ?? 1) > 0) || isVisibleColor(element.backgroundColor);
}

/**
 * Whether a node draws its own outline: its anchor is an Excalidraw rectangle
 * (rectangle node) or ellipse (ellipse node) that fills the node bounds
 * (within 1 px) and shows a stroke or a fill. Texts, images, transparent
 * shapes, shapes that do not match the node shape, and groups with content
 * outside the shape have no outline; written lines keep the Rendering
 * Connection Distance from their bounds instead of touching them.
 */
function hasVisibleOutline(logical: LogicalElement): boolean {
    const { anchor } = logical;
    const shape = shapeOf(anchor);
    const matches = (anchor.type === "rectangle" && shape === "rectangle") || (anchor.type === "ellipse" && shape === "ellipse");
    return matches && fillsBounds(logical) && isDrawn(anchor);
}

function outlinedIds(nodes: readonly LogicalElement[]): Set<string> {
    return new Set(nodes.filter(hasVisibleOutline).map((logical) => logical.anchor.id));
}

function cornerRadii(nodes: readonly LogicalElement[]): Map<string, number> {
    const radii = new Map<string, number>();
    for (const logical of nodes) {
        const radius = cornerRadiusOf(logical);
        if (radius > 0) radii.set(logical.anchor.id, radius);
    }
    return radii;
}

function nodeFor(logical: LogicalElement, parentId: string | undefined, space: CoordinateSpace): TreeNode {
    const point = center(logical);
    const graphPoint = sceneToGraphPoint(point, space);
    return {
        id: logical.anchor.id,
        ...(parentId ? { parentId } : {}),
        children: [],
        pos: new p5.Vector(graphPoint.x, graphPoint.y),
        shape: shapeOf(logical.anchor),
        width: logical.bounds.width,
        height: logical.bounds.height,
    };
}

function graphDimensions(border: LogicalElement, padding: MindmapPadding): { width: number; height: number } {
    return {
        width: Math.max(1, border.bounds.width - padding.left - padding.right),
        height: Math.max(1, border.bounds.height - padding.top - padding.bottom),
    };
}

function coordinateSpace(border: LogicalElement, padding: MindmapPadding): CoordinateSpace {
    const dimensions = graphDimensions(border, padding);
    return {
        origin: {
            x: border.bounds.x + padding.left,
            y: border.bounds.y + padding.top,
        },
        ...dimensions,
    };
}


/**
 * Reconstructs a previously parsed graph from persisted parent/children metadata.
 * The metadata is traversed breadth-first so TreeGraph receives parents first.
 * Fixed elements are added afterwards (`addFixedNodes`).
 */
export function loadMindmapFromMetadata(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    border: LogicalElement,
    padding: MindmapPadding,
    name: string,
): ParsedMindmap {
    const scene = ea.getViewElements().filter((element) => !isTemporaryElement(element));
    const space = coordinateSpace(border, padding);
    const graph = new TreeEdgeGraph(name, root.anchor.id, space.width, space.height, MAX_OFFSET_RATIO);
    const nodes: LogicalElement[] = [root];
    const queued = new Set<string>([root.anchor.id]);
    const queue: LogicalElement[] = [root];
    const byId = new Map(scene.map((element) => [element.id, element]));
    graph.addNode(nodeFor(root, undefined, space));

    for (let readIndex = 0; readIndex < queue.length; readIndex++) {
        const parent = queue[readIndex];
        const children = customData(parent.anchor).mindmapChildren;
        if (!Array.isArray(children)) continue;
        for (const childId of children) {
            if (typeof childId !== "string" || queued.has(childId)) continue;
            const child = resolveAnchor(ea, byId.get(childId), scene);
            if (!child || customData(child.anchor).isMindmapNode !== true) continue;
            if (customData(child.anchor).mindmapParent !== parent.anchor.id) continue;
            queued.add(childId);
            queue.push(child);
            nodes.push(child);
            graph.addNode(nodeFor(child, parent.anchor.id, space));
        }
    }
    const edges = hydrateEdges(graph, scene);
    const fixedIds = addFixedNodes(graph, resolveFixedElements(ea, scene, border), space);
    return {
        graph, nodes, edges, fixedIds, coordinateSpace: space,
        borderIds: border.elements.map((element) => element.id),
        cornerRadii: cornerRadii(nodes),
        outlinedIds: outlinedIds(nodes),
    };
}

/**
 * Applies persisted line metadata to the graph's edges.
 *
 * Offsets come from metadata rather than the line's current geometry, because a
 * node moved by hand must not turn the old line position into an anchor offset.
 * If several lines claim one edge (for example a copied line), the first in scene
 * order wins. An edge without a line stays centered and is simply not redrawn.
 */
function hydrateEdges(graph: TreeEdgeGraph, scene: readonly ExcalidrawElement[]): Map<string, EdgeBinding> {
    const edges = new Map<string, EdgeBinding>();
    for (const line of scene) {
        const metadata = readEdgeMetadata(line);
        const edge = metadata && graph.getEdge(metadata.childId);
        if (!metadata || !edge || edge.parentId !== metadata.parentId || edges.has(metadata.childId) || !lineEndpoints(line)) continue;
        graph.setOffset(edge, "parent", metadata.parentOffset.x, metadata.parentOffset.y);
        graph.setOffset(edge, "child", metadata.childOffset.x, metadata.childOffset.y);
        edges.set(metadata.childId, {
            lineId: line.id,
            parentId: metadata.parentId,
            childId: metadata.childId,
            parentEnd: metadata.parentEnd,
            parentGap: metadata.parentGap,
            childGap: metadata.childGap,
        });
    }
    return edges;
}

/**
 * Parses connected canvas nodes breadth-first from the configured root.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param root Configured root logical element.
 * @param connectionDistance Maximum endpoint-to-boundary distance.
 * @param border Configured border; its padded area is the graph coordinate space.
 * @param padding Border padding.
 * @param name Graph name (`mindmapName` of the drawing file).
 * @returns The parent-first graph, logical node representations, and the line of each edge.
 */
export function parseMindmap(
    ea: ExcalidrawAutomate,
    root: LogicalElement,
    connectionDistance: number,
    border: LogicalElement,
    padding: MindmapPadding,
    name: string,
): ParsedMindmap {
    const borderIds = border.elements.map((element) => element.id);
    const scene = parseScene(ea.getViewElements(), borderIds);
    const space = coordinateSpace(border, padding);
    const graph = new TreeEdgeGraph(name, root.anchor.id, space.width, space.height, MAX_OFFSET_RATIO);
    const edges = new Map<string, EdgeBinding>();
    const nodes: LogicalElement[] = [root];
    graph.addNode(nodeFor(root, undefined, space));
    const candidates = nodeCandidates(scene, ea);
    const logicalById = new Map(candidates.map(({ logical }) => [logical.anchor.id, logical]));
    const radii = cornerRadii([root, ...logicalById.values()]);
    const traversed = traverseLines(
        targetOf(root),
        candidates.map(({ logical, order }) => ({ target: targetOf(logical), order })),
        parseLines(scene),
        connectionDistance,
    );
    for (const accepted of traversed) {
        const candidate = logicalById.get(accepted.childId)!;
        nodes.push(candidate);
        graph.addNode(nodeFor(candidate, accepted.parentId, space));
        const binding = bindLineToEdge(
            graph,
            { lineId: accepted.lineId, childId: accepted.childId, parentEnd: accepted.parentEnd },
            sceneToGraphPoint(accepted.parentPoint, space),
            sceneToGraphPoint(accepted.childPoint, space),
            radii,
        );
        if (binding) edges.set(accepted.childId, binding);
    }

    // fixed elements before the export, otherwise the serialized graph lacks the `fixed` flags and isolated fixed nodes
    const fixedIds = addFixedNodes(graph, resolveFixedElements(ea, ea.getViewElements(), border), space);
    console.log(`Parsed ${nodes.length} nodes from mindmap. Serialized graph:`);
    console.log(graph.serialize());
    return { graph, nodes, edges, fixedIds, coordinateSpace: space, borderIds, cornerRadii: cornerRadii(nodes), outlinedIds: outlinedIds(nodes) };
}
