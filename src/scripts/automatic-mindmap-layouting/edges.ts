import { exitDistance } from "./core/graph/shapes";
import type { AnchoredTreeEdge, TreeEdgeGraph } from "./core/graph/TreeEdgeGraph";
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
 * The gaps record how far the drawn end lies from the node boundary, so that
 * `edgeEndpoints` reproduces the original line for an unchanged layout.
 *
 * @param graph Graph already containing both nodes; offsets are written to its edge.
 * @param line Line ID, child ID, and parent end to bind.
 * @param parentPoint Line end at the parent in graph coordinates.
 * @param childPoint Line end at the child in graph coordinates.
 * @returns The binding, or undefined when the graph has no such edge.
 */
export function bindLineToEdge(
    graph: TreeEdgeGraph,
    line: { lineId: string; childId: string; parentEnd: LineEnd },
    parentPoint: Point,
    childPoint: Point,
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
    return {
        lineId: line.lineId,
        parentId: edge.parentId,
        childId: line.childId,
        parentEnd: line.parentEnd,
        parentGap: parentReach - exitDistance(parent, edge.parentOffset.x, edge.parentOffset.y, ux, uy),
        childGap: childReach - exitDistance(child, edge.childOffset.x, edge.childOffset.y, -ux, -uy),
    };
}

/**
 * Computes where the drawn line must end for the graph's current layout.
 *
 * The line lies on the anchor-to-anchor segment and starts at the node
 * boundaries (plus the recorded gaps), like the core renderer's visible edge
 * part. When the nodes are so close that nothing would be visible, the line
 * spans the anchors.
 *
 * @param graph Graph holding positions and offsets.
 * @param edge Edge to draw.
 * @param binding The edge's line binding.
 * @returns Line ends at parent and child in graph coordinates.
 */
export function edgeEndpoints(
    graph: TreeEdgeGraph,
    edge: AnchoredTreeEdge,
    binding: EdgeBinding,
): { parent: Point; child: Point } {
    const parent = graph.getNode(edge.parentId)!;
    const child = graph.getNode(edge.childId)!;
    const { a, b, length, ux, uy } = segmentDirection(graph, edge);
    if (length <= EPSILON) return { parent: a, child: b };
    const parentReach = exitDistance(parent, edge.parentOffset.x, edge.parentOffset.y, ux, uy) + binding.parentGap;
    const childReach = exitDistance(child, edge.childOffset.x, edge.childOffset.y, -ux, -uy) + binding.childGap;
    if (parentReach + childReach >= length) return { parent: a, child: b };
    return {
        parent: { x: a.x + ux * parentReach, y: a.y + uy * parentReach },
        child: { x: b.x - ux * childReach, y: b.y - uy * childReach },
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
 * @returns The persistent `mindmapEdge` value.
 */
export function edgeMetadata(edge: AnchoredTreeEdge, binding: EdgeBinding): MindmapEdgeMetadata {
    return {
        parentId: binding.parentId,
        childId: binding.childId,
        parentEnd: binding.parentEnd,
        parentOffset: { x: edge.parentOffset.x, y: edge.parentOffset.y },
        childOffset: { x: edge.childOffset.x, y: edge.childOffset.y },
        parentGap: binding.parentGap,
        childGap: binding.childGap,
    };
}
