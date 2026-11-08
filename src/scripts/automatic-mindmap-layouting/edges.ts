import { exitDistance } from "./core/graph/shapes";
import type { AnchoredTreeEdge, TreeEdgeGraph } from "./core/graph/TreeEdgeGraph";
import type { TreeNode } from "./core/graph/types";
import type { LineEnd, MindmapEdgeMetadata } from "./metadata";

export interface Point {
    x: number;
    y: number;
}

/** Links one `AnchoredTreeEdge` (keyed by child ID) to the line element drawing it. */
export interface EdgeBinding {
    lineId: string;
    parentId: string;
    childId: string;
    /** The line end that attaches to the parent. */
    parentEnd: LineEnd;
    /** Drawn clearance from the parent boundary to the line end (negative: inside the node). */
    parentGap: number;
    /** Drawn clearance from the child boundary to the line end (negative: inside the node). */
    childGap: number;
}

/** Signed clearances between the line ends and the node boundaries. */
export type EdgeGaps = Pick<EdgeBinding, "parentGap" | "childGap">;

/** Corner radius of the visible outline of rounded rectangle nodes, keyed by node ID (missing = sharp). */
export type CornerRadii = ReadonlyMap<string, number>;

const NO_RADII: CornerRadii = new Map();

/** Excalidraw's `ROUNDNESS` types and defaults (`getCornerRadius`). */
const ROUNDNESS_LEGACY = 1;
const ROUNDNESS_PROPORTIONAL = 2;
const ROUNDNESS_ADAPTIVE = 3;
const PROPORTIONAL_RADIUS = 0.25;
const ADAPTIVE_RADIUS = 32;

/**
 * Corner radius Excalidraw draws for a rectangle (`getCornerRadius` of the
 * Excalidraw package): proportional and legacy roundness use a quarter of the
 * shorter side; adaptive roundness does the same up to a cutoff and then uses
 * the fixed radius (`roundness.value`, default 32).
 *
 * @param width Rectangle width.
 * @param height Rectangle height.
 * @param roundness The element's `roundness`.
 * @returns The radius, 0 for sharp corners.
 */
export function excalidrawCornerRadius(width: number, height: number, roundness: { type: number; value?: number } | null | undefined): number {
    const size = Math.min(Math.abs(width), Math.abs(height));
    if (!roundness) return 0;
    if (roundness.type === ROUNDNESS_LEGACY || roundness.type === ROUNDNESS_PROPORTIONAL) return size * PROPORTIONAL_RADIUS;
    if (roundness.type !== ROUNDNESS_ADAPTIVE) return 0;
    const fixed = roundness.value ?? ADAPTIVE_RADIUS;
    return size <= fixed / PROPORTIONAL_RADIUS ? size * PROPORTIONAL_RADIUS : fixed;
}

/** Real roots of `a s^2 + b s + c = 0` (also for `a = 0`). */
function quadraticRoots(a: number, b: number, c: number): number[] {
    if (Math.abs(a) < 1e-12) return Math.abs(b) > 1e-12 ? [-c / b] : [];
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

/**
 * Exit distance through a rounded corner. Excalidraw draws each corner as a
 * quadratic Bezier curve from `(hw - r, hh)` over the control point `(hw, hh)`
 * to `(hw, hh - r)` (mirrored per quadrant), not as a circular arc. In the
 * corner's quadrant the curve is `x = hw - r(1 - s)^2, y = hh - r s^2`, so the
 * ray `o + t u` meets it at a root of a quadratic in `s`.
 */
function cornerExit(corner: { hw: number; hh: number; r: number }, o: Point, u: Point): number | undefined {
    const { hw, hh, r } = corner;
    // u.y (hw - r(1-s)^2 - o.x) = u.x (hh - r s^2 - o.y)
    const roots = quadraticRoots(r * (u.x - u.y), 2 * r * u.y, u.y * (hw - r - o.x) - u.x * (hh - o.y));
    let best: number | undefined;
    for (const s of roots) {
        if (s < -1e-9 || s > 1 + 1e-9) continue;
        const t = Math.abs(u.x) >= Math.abs(u.y)
            ? (hw - r * (1 - s) * (1 - s) - o.x) / u.x
            : (hh - r * s * s - o.y) / u.y;
        if (t >= 0 && (best === undefined || t < best)) best = t;
    }
    return best;
}

/**
 * Distance from an inner point along a unit direction to the node's visible
 * outline: the core's `exitDistance` for ellipses and sharp rectangles, and
 * the Excalidraw corner curve for rounded rectangles.
 *
 * @param node Graph node.
 * @param radius Corner radius of the drawn rectangle (0 = sharp).
 * @param offset Start point relative to the node center.
 * @param direction Unit direction of the ray.
 * @returns The distance, at least 0.
 */
export function outlineExit(node: TreeNode, radius: number, offset: Point, direction: Point): number {
    const box = exitDistance(node, offset.x, offset.y, direction.x, direction.y);
    if (node.shape !== "rectangle" || radius <= 0) return box;
    const hw = (node.width ?? 0) / 2;
    const hh = (node.height ?? 0) / 2;
    const r = Math.min(radius, hw, hh);
    const px = offset.x + direction.x * box;
    const py = offset.y + direction.y * box;
    if (Math.abs(px) <= hw - r + 1e-9 || Math.abs(py) <= hh - r + 1e-9) return box;
    // mirror into the corner quadrant (+x, +y)
    const sx = Math.sign(px) || 1;
    const sy = Math.sign(py) || 1;
    const t = cornerExit({ hw, hh, r }, { x: sx * offset.x, y: sy * offset.y }, { x: sx * direction.x, y: sy * direction.y });
    return t === undefined ? box : Math.min(t, box);
}

/**
 * Distances from the anchors to the visible node outlines along the current
 * anchor-to-anchor direction (`outlineExit` at both ends). A gap of `-exit`
 * puts the line end on the anchor.
 */
export function edgeExits(graph: TreeEdgeGraph, edge: AnchoredTreeEdge, radii: CornerRadii = NO_RADII): { parent: number; child: number } {
    const parent = graph.getNode(edge.parentId)!;
    const child = graph.getNode(edge.childId)!;
    const { length, ux, uy } = segmentDirection(graph, edge);
    if (length <= EPSILON) return { parent: 0, child: 0 };
    return {
        parent: outlineExit(parent, radii.get(parent.id) ?? 0, edge.parentOffset, { x: ux, y: uy }),
        child: outlineExit(child, radii.get(child.id) ?? 0, edge.childOffset, { x: -ux, y: -uy }),
    };
}

export interface LineGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
    points: [number, number][];
}

const EPSILON = 1e-6;

/**
 * Returns the absolute end points of a line or arrow.
 *
 * @param element Scene element.
 * @returns First and last point in scene coordinates, or undefined for other elements.
 */
export function lineEndpoints(element: ExcalidrawElement): { start: Point; end: Point } | undefined {
    if (element.type !== "line" && element.type !== "arrow") return undefined;
    const points = (element as ExcalidrawElement & { points?: readonly (readonly [number, number])[] }).points;
    if (!points || points.length < 2) return undefined;
    const first = points[0];
    const last = points[points.length - 1];
    return {
        start: { x: element.x + first[0], y: element.y + first[1] },
        end: { x: element.x + last[0], y: element.y + last[1] },
    };
}

/** Offset from `center` to the point of the infinite line (p, q) closest to `center`. */
function footOffset(center: Point, p: Point, q: Point): Point {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < EPSILON) return { x: 0, y: 0 };
    const t = ((center.x - p.x) * dx + (center.y - p.y) * dy) / lengthSquared;
    return { x: p.x + dx * t - center.x, y: p.y + dy * t - center.y };
}

function segmentDirection(graph: TreeEdgeGraph, edge: AnchoredTreeEdge): { a: Point; b: Point; length: number; ux: number; uy: number } {
    const { a, b } = graph.getSegment(edge);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    return { a, b, length, ux: length > EPSILON ? dx / length : 0, uy: length > EPSILON ? dy / length : 0 };
}

/**
 * Derives the edge anchors and boundary gaps from a drawn line.
 *
 * Every line is modelled by its chord. Each anchor is the point of the chord's
 * extension closest to the node center, projected into the anchor region by
 * `graph.setOffset`: a line aiming at the center has offset 0, and the
 * anchor-to-anchor segment stays on the drawn line unless the region clamps it.
 * The gaps record how far the drawn end lies from the visible outline. They
 * are informational only: the write-back draws every end on the outline
 * (gap 0, `layout.ts`) unless the reparse check needs another position.
 *
 * @param graph Graph already containing both nodes; offsets are written to its edge.
 * @param line Line ID, child ID, and parent end to bind.
 * @param parentPoint Line end at the parent in graph coordinates.
 * @param childPoint Line end at the child in graph coordinates.
 * @param radii Corner radii of rounded rectangle nodes.
 * @returns The binding, or undefined when the graph has no such edge.
 */
export function bindLineToEdge(
    graph: TreeEdgeGraph,
    line: { lineId: string; childId: string; parentEnd: LineEnd },
    parentPoint: Point,
    childPoint: Point,
    radii: CornerRadii = NO_RADII,
): EdgeBinding | undefined {
    const edge = graph.getEdge(line.childId);
    const parent = edge && graph.getNode(edge.parentId);
    const child = graph.getNode(line.childId);
    if (!edge || !parent || !child) return undefined;
    const parentFoot = footOffset(parent.pos, parentPoint, childPoint);
    const childFoot = footOffset(child.pos, parentPoint, childPoint);
    graph.setOffset(edge, "parent", parentFoot.x, parentFoot.y);
    graph.setOffset(edge, "child", childFoot.x, childFoot.y);
    const { a, b, ux, uy } = segmentDirection(graph, edge);
    const parentReach = (parentPoint.x - a.x) * ux + (parentPoint.y - a.y) * uy;
    const childReach = (b.x - childPoint.x) * ux + (b.y - childPoint.y) * uy;
    const exits = edgeExits(graph, edge, radii);
    return {
        lineId: line.lineId,
        parentId: edge.parentId,
        childId: line.childId,
        parentEnd: line.parentEnd,
        parentGap: parentReach - exits.parent,
        childGap: childReach - exits.child,
    };
}

/**
 * Computes where the drawn line must end for the graph's current layout.
 *
 * The line lies on the anchor-to-anchor segment and ends at the visible node
 * outlines (`outlineExit`: rectangle, Excalidraw rounded rectangle, or
 * ellipse) plus the given gaps (`layout.ts: restGaps`). Positive gaps shrink
 * so that at least half of the free space between the outlines stays visible
 * (`fitGaps`). When the nodes are so close that nothing would be visible, the
 * line spans the anchors.
 *
 * @param graph Graph holding positions and offsets.
 * @param edge Edge to draw.
 * @param gaps Signed distances of the line ends from the outlines (0 = on the outline).
 * @param radii Corner radii of rounded rectangle nodes.
 * @returns Line ends at parent and child in graph coordinates.
 */
export function edgeEndpoints(
    graph: TreeEdgeGraph,
    edge: AnchoredTreeEdge,
    gaps: EdgeGaps,
    radii: CornerRadii = NO_RADII,
): { parent: Point; child: Point } {
    const { a, b, length, ux, uy } = segmentDirection(graph, edge);
    if (length <= EPSILON) return { parent: a, child: b };
    const exits = edgeExits(graph, edge, radii);
    const { parentGap, childGap } = fitGaps(length - exits.parent - exits.child, gaps);
    const parentReach = exits.parent + parentGap;
    const childReach = exits.child + childGap;
    if (parentReach + childReach >= length) return { parent: a, child: b };
    return {
        parent: { x: a.x + ux * parentReach, y: a.y + uy * parentReach },
        child: { x: b.x - ux * childReach, y: b.y - uy * childReach },
    };
}

/**
 * Shrinks positive gaps that would leave less than half of the free space
 * between the outlines visible, so that close nodes still get a short line.
 * Negative gaps (ends inside a node) stay unchanged.
 */
function fitGaps(free: number, gaps: EdgeGaps): EdgeGaps {
    const outward = Math.max(0, gaps.parentGap) + Math.max(0, gaps.childGap);
    if (free <= 0 || outward <= free / 2) return gaps;
    const scale = free / 2 / outward;
    return {
        parentGap: gaps.parentGap > 0 ? gaps.parentGap * scale : gaps.parentGap,
        childGap: gaps.childGap > 0 ? gaps.childGap * scale : gaps.childGap,
    };
}

/**
 * Moves a line's ends and keeps the shape of intermediate points.
 *
 * All points go through the rotation and scaling that maps the old chord onto
 * the new one, so bends and curves keep their form.
 *
 * @param absolutePoints Current points in scene coordinates.
 * @param newStart New first point in scene coordinates.
 * @param newEnd New last point in scene coordinates.
 * @returns Geometry for the element, with its first point at (0, 0).
 */
export function reshapeLine(absolutePoints: readonly Point[], newStart: Point, newEnd: Point): LineGeometry {
    const oldStart = absolutePoints[0];
    const oldEnd = absolutePoints[absolutePoints.length - 1];
    const oldX = oldEnd.x - oldStart.x;
    const oldY = oldEnd.y - oldStart.y;
    const newX = newEnd.x - newStart.x;
    const newY = newEnd.y - newStart.y;
    const oldSquared = oldX * oldX + oldY * oldY;
    // Complex division newChord / oldChord; a degenerate old chord only translates.
    const re = oldSquared < EPSILON ? 1 : (newX * oldX + newY * oldY) / oldSquared;
    const im = oldSquared < EPSILON ? 0 : (newY * oldX - newX * oldY) / oldSquared;
    const points = absolutePoints.map((point): [number, number] => {
        const x = point.x - oldStart.x;
        const y = point.y - oldStart.y;
        return [x * re - y * im, x * im + y * re];
    });
    points[0] = [0, 0];
    points[points.length - 1] = [newX, newY];
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return {
        x: newStart.x,
        y: newStart.y,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        points,
    };
}

/**
 * Serializes an edge and its binding for the line's `customData`.
 *
 * @param edge Edge holding the current offsets.
 * @param binding The edge's line binding.
 * @param gaps Gaps of the drawn line, if they differ from the binding (after a write-back).
 * @returns The persistent `mindmapEdge` value.
 */
export function edgeMetadata(edge: AnchoredTreeEdge, binding: EdgeBinding, gaps: EdgeGaps = binding): MindmapEdgeMetadata {
    return {
        parentId: binding.parentId,
        childId: binding.childId,
        parentEnd: binding.parentEnd,
        parentOffset: { x: edge.parentOffset.x, y: edge.parentOffset.y },
        childOffset: { x: edge.childOffset.x, y: edge.childOffset.y },
        parentGap: gaps.parentGap,
        childGap: gaps.childGap,
    };
}
