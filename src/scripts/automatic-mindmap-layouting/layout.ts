import { containerIdOf, resolveAnchorId } from "./groups";
import {
    edgeEndpoints,
    edgeExits,
    edgeMetadata,
    lineEndpoints,
    reshapeLine,
    type EdgeBinding,
    type EdgeGaps,
    type LineGeometry,
    type Point,
} from "./edges";
import {
    graphToScenePoint,
    nodeCandidates,
    parseLines,
    parseScene,
    targetOf,
    traverseLines,
    type ParseCandidate,
    type ParseLine,
    type ParsedMindmap,
    type ParseTarget,
    type TraversedEdge,
} from "./parser";
import { CAPTURE_NEVER } from "./scene";

type CaptureUpdate = NonNullable<Parameters<ExcalidrawAutomate["addElementsToView"]>[4]>;

interface Shift {
    dx: number;
    dy: number;
}

interface LineChange {
    binding: EdgeBinding;
    geometry: LineGeometry;
    /** Gaps of the drawn line, stored in `mindmapEdge`. */
    gaps: EdgeGaps;
}

/** One tracked line as it will be written: binding, current element, gaps in use, and new ends. */
interface PlannedLine {
    binding: EdgeBinding;
    line: ExcalidrawElement;
    current: { start: Point; end: Point };
    gaps: EdgeGaps;
    /** Preferred gaps (`restGaps`); the reparse check departs from them only where needed. */
    rest: EdgeGaps;
    /** New first and last point in scene coordinates (`parentEnd` honored). */
    start: Point;
    end: Point;
}

/** Result of the reparse check of one write (`ensureReparsable`). */
export interface ReparseCheck {
    /** Edges that a parse of the written drawing must recover (bound and reachable from the root). */
    expected: number;
    /** Child IDs whose line ends could not keep their preferred gaps (`restGaps`). */
    adjusted: string[];
    /** Child IDs whose edge a parse would still not recover (or recover with another parent or line). */
    failed: string[];
}

const MIN_CHANGE = 0.01;

/**
 * Gap between a line end and a visible node outline. Slightly outside reads
 * better than a line tip poking into the node.
 */
export const OUTLINE_GAP = 1;

/** Line distances of a write-back. */
export interface WriteDistances {
    /** Parsing Connection Distance a later parse will use. */
    parsing: number;
    /** Rendering Connection Distance: gap at nodes without a visible outline. */
    rendering: number;
}

/**
 * Preferred gaps of a line: `OUTLINE_GAP` at nodes with a visible outline
 * (`ParsedMindmap.outlinedIds`), the Rendering Connection Distance at the
 * bounds of nodes without one (plain text, images).
 */
function restGaps(mindmap: ParsedMindmap, binding: EdgeBinding, rendering: number): EdgeGaps {
    const gap = (id: string): number => (mindmap.outlinedIds.has(id) ? OUTLINE_GAP : rendering);
    return { parentGap: gap(binding.parentId), childGap: gap(binding.childId) };
}

function sameGaps(a: EdgeGaps, b: EdgeGaps): boolean {
    return Math.abs(a.parentGap - b.parentGap) < MIN_CHANGE && Math.abs(a.childGap - b.childGap) < MIN_CHANGE;
}

function absolutePoints(element: ExcalidrawElement): Point[] {
    const points = (element as ExcalidrawElement & { points: readonly (readonly [number, number])[] }).points;
    return points.map(([x, y]) => ({ x: element.x + x, y: element.y + y }));
}

/** Collects the offset of every node member; tracked lines are placed separately. */
function nodeShifts(
    ea: ExcalidrawAutomate,
    mindmap: ParsedMindmap,
    scene: readonly ExcalidrawElement[],
    lineIds: ReadonlySet<string>,
): Map<string, Shift> {
    const shifts = new Map<string, Shift>();
    for (const node of mindmap.graph.getAllNodes()) {
        const logical = resolveAnchorId(ea, node.id, scene);
        if (!logical) continue;
        const target = graphToScenePoint(node.pos, mindmap.coordinateSpace);
        const dx = target.x - (logical.bounds.x + logical.bounds.width / 2);
        const dy = target.y - (logical.bounds.y + logical.bounds.height / 2);
        if (Math.abs(dx) < MIN_CHANGE && Math.abs(dy) < MIN_CHANGE) continue;
        for (const member of logical.elements) {
            if (!lineIds.has(member.id)) shifts.set(member.id, { dx, dy });
        }
    }
    return shifts;
}

/** Places a planned line for the given gaps (sets `gaps`, `start`, `end`). */
function placeLine(mindmap: ParsedMindmap, planned: PlannedLine, gaps: EdgeGaps): void {
    const edge = mindmap.graph.getEdge(planned.binding.childId)!;
    const ends = edgeEndpoints(mindmap.graph, edge, gaps, mindmap.cornerRadii);
    const parent = graphToScenePoint(ends.parent, mindmap.coordinateSpace);
    const child = graphToScenePoint(ends.child, mindmap.coordinateSpace);
    planned.gaps = gaps;
    const [start, end] = planned.binding.parentEnd === "start" ? [parent, child] : [child, parent];
    planned.start = start;
    // The element stores `x + (end - start)` (`reshapeLine`); check exactly that value, not `end`.
    planned.end = { x: start.x + (end.x - start.x), y: start.y + (end.y - start.y) };
}

/**
 * Plans every tracked line with its preferred gaps (`restGaps`): just outside
 * visible node outlines, the Rendering Connection Distance away from nodes
 * without one. The gaps recorded when the line was parsed (hand-drawn lines
 * often stop short of a node or reach into it) are not reproduced, so every
 * written line meets its nodes cleanly.
 */
function planLines(mindmap: ParsedMindmap, scene: readonly ExcalidrawElement[], rendering: number): PlannedLine[] {
    const byId = new Map(scene.map((element) => [element.id, element]));
    const planned: PlannedLine[] = [];
    for (const binding of mindmap.edges.values()) {
        const line = byId.get(binding.lineId);
        const current = line && lineEndpoints(line);
        if (!line || !current || !mindmap.graph.getEdge(binding.childId)) continue;
        const rest = restGaps(mindmap, binding, rendering);
        const entry: PlannedLine = { binding, line, current, gaps: rest, rest, start: current.start, end: current.end };
        placeLine(mindmap, entry, rest);
        planned.push(entry);
    }
    return planned;
}

/** Converts the planned lines to element geometry and shifts each line label by the moved midpoint. */
function lineChanges(planned: readonly PlannedLine[], scene: readonly ExcalidrawElement[], shifts: Map<string, Shift>): LineChange[] {
    return planned.map(({ binding, line, current, start, end, gaps }) => {
        const dx = (start.x + end.x - current.start.x - current.end.x) / 2;
        const dy = (start.y + end.y - current.start.y - current.end.y) / 2;
        for (const element of scene) {
            if (containerIdOf(element) === binding.lineId) shifts.set(element.id, { dx, dy });
        }
        return { binding, geometry: reshapeLine(absolutePoints(line), start, end), gaps };
    });
}

// REPARSE CHECK

interface ReparseScore {
    /** Exactly recovered expected edges, summed over all checked connection distances. */
    matched: number;
    /** Accepted edges that are not expected edges (wrong parent, wrong line, or extra nodes). */
    wrong: number;
    /** Child IDs of tracked lines whose ends may fix a mismatch. */
    failing: string[];
    /** Expected child IDs not recovered at some checked connection distance. */
    failed: Set<string>;
}

function better(a: ReparseScore, b: ReparseScore): boolean {
    return a.matched > b.matched || (a.matched === b.matched && a.wrong < b.wrong);
}

/**
 * Gaps for one end, in order of preference: the preferred gap, half the
 * Connection Distance outside (only when the preferred gap is larger, so a
 * too large Rendering Connection Distance shrinks no more than needed), on
 * the outline, a quarter of the Connection Distance outside, halfway to the
 * anchor, half the Connection Distance outside, the anchor. The fallbacks are
 * needed where nodes touch or overlap a neighbour (an end at the outline then
 * also lies on or inside the neighbour; moving it out into the free space or
 * deeper into its own node makes its owner unique again) and where the
 * Rendering Connection Distance exceeds what the parse accepts. Inside a
 * rectangle the parser distance is 0; inside an ellipse it grows with the
 * depth.
 */
function gapLevels(rest: number, exit: number, connectionDistance: number): number[] {
    const half = connectionDistance / 2;
    const levels = [rest, ...(rest > half ? [half] : []), 0, connectionDistance / 4, -exit / 2, half, -exit];
    return levels.filter((level, index) => levels.findIndex((other) => Math.abs(other - level) < MIN_CHANGE) === index);
}

/** All fallback gap pairs except the preferred one, ordered by how far they depart from it. */
function gapCandidates(mindmap: ParsedMindmap, planned: PlannedLine, connectionDistance: number): EdgeGaps[] {
    const exits = edgeExits(mindmap.graph, mindmap.graph.getEdge(planned.binding.childId)!, mindmap.cornerRadii);
    const parentLevels = gapLevels(planned.rest.parentGap, exits.parent, connectionDistance);
    const childLevels = gapLevels(planned.rest.childGap, exits.child, connectionDistance);
    const pairs: { gaps: EdgeGaps; rank: number; worst: number }[] = [];
    parentLevels.forEach((parentGap, i) => childLevels.forEach((childGap, j) => {
        if (i + j > 0) pairs.push({ gaps: { parentGap, childGap }, rank: i + j, worst: Math.max(i, j) });
    }));
    return pairs.sort((a, b) => a.rank - b.rank || a.worst - b.worst).map(({ gaps }) => gaps);
}

/** Everything the reparse check needs besides the planned line ends. */
interface ReparseInput {
    root: ParseTarget;
    /** Node candidates at their written positions. */
    candidates: ParseCandidate[];
    /** Every line at its written position except the planned lines, which are inserted per evaluation. */
    lines: ParseLine[];
    planned: readonly PlannedLine[];
    plannedByLine: Map<string, PlannedLine>;
    /** Edges a parse must recover, keyed by child ID. */
    expected: Map<string, PlannedLine>;
    /** Connection distances to check (the configured one minus and plus a margin). */
    distances: number[];
}

function shiftPoint(point: Point, shift: Shift | undefined): Point {
    return shift ? { x: point.x + shift.dx, y: point.y + shift.dy } : point;
}

/** Bound edges whose whole path to the root consists of bound edges between existing nodes. */
function expectedEdges(rootId: string, planned: readonly PlannedLine[], nodeIds: ReadonlySet<string>): Map<string, PlannedLine> {
    const byChild = new Map(planned.map((entry) => [entry.binding.childId, entry]));
    const reachable = (childId: string, depth: number): boolean => {
        const entry = byChild.get(childId);
        if (!entry || depth > planned.length || !nodeIds.has(childId)) return false;
        return entry.binding.parentId === rootId || reachable(entry.binding.parentId, depth + 1);
    };
    return new Map(planned.filter((entry) => reachable(entry.binding.childId, 0)).map((entry) => [entry.binding.childId, entry]));
}

/**
 * Builds the scene as a later parse will see it after this write: node
 * candidates moved by their shifts, lines that are not tracked at their place
 * (or moved with the node group they belong to).
 */
function reparseInput(
    ea: ExcalidrawAutomate,
    write: { mindmap: ParsedMindmap; scene: readonly ExcalidrawElement[]; shifts: ReadonlyMap<string, Shift> },
    planned: readonly PlannedLine[],
    connectionDistance: number,
): ReparseInput | undefined {
    const { mindmap, shifts } = write;
    const elements = parseScene(write.scene, mindmap.borderIds);
    const candidates: ParseCandidate[] = nodeCandidates(elements, ea).map(({ logical, order }) => {
        const target = targetOf(logical);
        const corner = shiftPoint(target.bounds, shifts.get(target.id));
        return { target: { ...target, bounds: { ...target.bounds, x: corner.x, y: corner.y } }, order };
    });
    const root = candidates.find(({ target }) => target.id === mindmap.graph.rootId)?.target;
    const expected = expectedEdges(mindmap.graph.rootId, planned, new Set(candidates.map(({ target }) => target.id)));
    if (!root || expected.size === 0) return undefined;
    const lines = parseLines(elements).map((line) => {
        const shift = shifts.get(line.id);
        return { id: line.id, start: shiftPoint(line.start, shift), end: shiftPoint(line.end, shift) };
    });
    const margin = Math.min(1, connectionDistance / 4);
    return {
        root,
        candidates,
        lines,
        planned,
        plannedByLine: new Map(planned.map((entry) => [entry.binding.lineId, entry])),
        expected,
        distances: [connectionDistance - margin, connectionDistance + margin],
    };
}

function sameEdge(edge: TraversedEdge | undefined, binding: EdgeBinding): boolean {
    return edge?.parentId === binding.parentId && edge.lineId === binding.lineId && edge.parentEnd === binding.parentEnd;
}

/** Runs the parser traversal on the current planned line ends and scores the result. */
function evaluateReparse(input: ReparseInput): ReparseScore {
    const lines = input.lines.map((line) => {
        const entry = input.plannedByLine.get(line.id);
        return entry ? { id: line.id, start: entry.start, end: entry.end } : line;
    });
    const score: ReparseScore = { matched: 0, wrong: 0, failing: [], failed: new Set() };
    const failing = new Set<string>();
    for (const distance of input.distances) {
        const accepted = traverseLines(input.root, input.candidates, lines, distance);
        const reached = new Set([input.root.id, ...accepted.map(({ childId }) => childId)]);
        const byChild = new Map(accepted.map((edge) => [edge.childId, edge]));
        for (const [childId, { binding }] of input.expected) {
            if (sameEdge(byChild.get(childId), binding)) {
                score.matched++;
                continue;
            }
            score.failed.add(childId);
            // Only a line whose parent is reached can be fixed now; its subtree follows.
            if (reached.has(binding.parentId)) failing.add(childId);
        }
        for (const edge of accepted) {
            const entry = input.expected.get(edge.childId);
            if (entry && sameEdge(edge, entry.binding)) continue;
            score.wrong++;
            // A tracked line attaching the wrong node: its ends are the culprit.
            const culprit = input.plannedByLine.get(edge.lineId);
            if (culprit) failing.add(culprit.binding.childId);
        }
    }
    score.failing = [...failing];
    return score;
}

/**
 * Tries the gap candidates of each failing line and keeps the first one that
 * improves the score (one line per call).
 *
 * @returns The improved score, or undefined when no failing line could be improved.
 */
function improveOnce(mindmap: ParsedMindmap, input: ReparseInput, best: ReparseScore, connectionDistance: number): ReparseScore | undefined {
    for (const childId of best.failing) {
        const entry = input.planned.find(({ binding }) => binding.childId === childId)!;
        const previous = entry.gaps;
        for (const gaps of gapCandidates(mindmap, entry, connectionDistance)) {
            placeLine(mindmap, entry, gaps);
            const score = evaluateReparse(input);
            if (better(score, best)) return score;
        }
        placeLine(mindmap, entry, previous);
    }
    return undefined;
}

/**
 * Makes sure that parsing the drawing after this write recovers the graph.
 *
 * The parser matches line ends by their distance to node boundaries (at most
 * the Connection Distance) and gives each end to its nearest element. Lines
 * are planned with their preferred gaps (`restGaps`); nodes moved close
 * together can make such an end ambiguous, and a Rendering Connection
 * Distance above the parsing one puts it out of reach. This runs the parser's own traversal
 * (`traverseLines`) on the geometry as it will be written (moved nodes,
 * planned lines, all other elements unchanged) and, while an expected edge is
 * not recovered exactly (same parent, child, line, and parent end), moves the
 * ends of the failing lines slightly outward or into the node (`gapCandidates`), keeping the first
 * candidate that improves the result. The check runs at the Connection
 * Distance minus and plus a small margin, so rounding cannot flip the result.
 * Every write starts again from the preferred gaps.
 */
function ensureReparsable(
    ea: ExcalidrawAutomate,
    write: { mindmap: ParsedMindmap; scene: readonly ExcalidrawElement[]; shifts: ReadonlyMap<string, Shift> },
    planned: readonly PlannedLine[],
    connectionDistance: number,
): ReparseCheck {
    const input = reparseInput(ea, write, planned, connectionDistance);
    if (!input) return { expected: 0, adjusted: [], failed: [] };
    const target = input.expected.size * input.distances.length;
    let best = evaluateReparse(input);
    for (let round = 0; round < 4 * planned.length && (best.matched < target || best.wrong > 0); round++) {
        const improved = improveOnce(write.mindmap, input, best, connectionDistance);
        if (!improved) break;
        best = improved;
    }
    const adjusted = planned
        .filter(({ gaps, rest }) => !sameGaps(gaps, rest))
        .map(({ binding }) => binding.childId);
    const failed = [...best.failed];
    if (failed.length > 0 || best.wrong > 0) {
        console.warn(
            `Mindmap layout: a reparse would not recover ${failed.length} of ${input.expected.size} edges`
            + ` (${best.wrong} wrong or extra connections).`,
            { failed },
        );
    }
    return { expected: input.expected.size, adjusted, failed };
}

/**
 * Writes a graph's layout back to the canvas in one transaction.
 *
 * Nodes move as complete logical elements, keeping their size, IDs, and
 * metadata. Tracked lines are redrawn from the anchors (`edgeEndpoints`) and
 * their `mindmapEdge` metadata receives the current offsets. Before writing,
 * `ensureReparsable` checks that parsing the result gives the same tree again
 * and adjusts line ends where it would not. Graph positions are converted with
 * the mindmap's coordinate space. The caller must run this inside the
 * workbench transaction queue, and the layout runner must keep its
 * `ParsedMindmap` while a run is active, because `hydrate` builds a new graph
 * after every scene change.
 *
 * @param ea Active ExcalidrawAutomate instance.
 * @param mindmap Graph, bindings, and coordinate space to write.
 * @param distances Parsing Connection Distance a later parse will use, and
 *   Rendering Connection Distance for nodes without a visible outline.
 * @param captureUpdate Undo capture; defaults to not undoable (rollback covers runs).
 * @returns The reparse check of this write.
 */
export async function writeGraphToScene(
    ea: ExcalidrawAutomate,
    mindmap: ParsedMindmap,
    distances: WriteDistances,
    captureUpdate: CaptureUpdate = CAPTURE_NEVER,
): Promise<ReparseCheck> {
    const scene = ea.getViewElements();
    const lineIds = new Set([...mindmap.edges.values()].map((binding) => binding.lineId));
    const shifts = nodeShifts(ea, mindmap, scene, lineIds);
    const planned = planLines(mindmap, scene, distances.rendering);
    const check = ensureReparsable(ea, { mindmap, scene, shifts }, planned, distances.parsing);
    const lines = lineChanges(planned, scene, shifts);
    const changedIds = new Set([...shifts.keys(), ...lines.map(({ binding }) => binding.lineId)]);
    const changed = scene.filter((element) => changedIds.has(element.id));
    if (changed.length === 0) return check;
    ea.clear();
    try {
        ea.copyViewElementsToEAforEditing(changed);
        for (const [id, { dx, dy }] of shifts) {
            const editable = ea.getElement(id);
            if (!editable) continue;
            editable.x += dx;
            editable.y += dy;
        }
        for (const { binding, geometry, gaps } of lines) {
            Object.assign(ea.getElement(binding.lineId), geometry);
            const edge = mindmap.graph.getEdge(binding.childId)!;
            ea.addAppendUpdateCustomData(binding.lineId, { mindmapEdge: edgeMetadata(edge, binding, gaps) });
        }
        await ea.addElementsToView(false, false, false, false, captureUpdate);
    } finally {
        ea.clear();
    }
    return check;
}
