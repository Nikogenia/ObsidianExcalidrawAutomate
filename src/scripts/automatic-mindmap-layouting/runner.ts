import type { NikogeniaAlgorithmV1 } from "./core/algorithms/nikogenia/NikogeniaAlgorithm1";
import type { ReparseCheck } from "./layout";
import type { ParsedMindmap } from "./parser";

/** Computation per slice before control returns to Obsidian. */
const SLICE_MS = 12;

export type RunOutcome = "completed" | "stopped";

export interface RunHooks {
    /** Read before every slice, so a changed Steps Per Render applies to the running run. */
    stepsPerRender: () => number;
    /** Writes the current graph to the scene; returning false stops the run (session ended). */
    render: () => Promise<boolean>;
    /** Called after every render with the run's state. */
    progress: (run: LayoutRun) => void;
}

/**
 * Yields one macrotask. A `MessageChannel` message is not clamped to 4 ms like
 * nested `setTimeout(0)` calls, and the browser may paint and handle input
 * events before it is delivered.
 */
function yieldToUi(): Promise<void> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

/**
 * One layout run: an initialized algorithm working on its own graph.
 *
 * Execution is cooperative and time-sliced on the main thread: steps run for
 * at most `SLICE_MS`, then control returns to Obsidian, so the editor stays
 * responsive. Stopping sets a flag that is checked before every step, after
 * every slice, and before every render, so `stop()` takes effect within one
 * step and nothing of the run survives it (there is no worker to terminate).
 * A stopped run that was not completed can be continued with `run` or `step`.
 */
export class LayoutRun {
    readonly algorithm: NikogeniaAlgorithmV1;
    readonly mindmap: ParsedMindmap;
    /** Content version of the scene after the run's last write (see `contentVersion`). */
    writtenVersion = "";
    /** Reparse check of the run's last write (`writeGraphToScene`). */
    reparse: ReparseCheck | undefined;
    private stopRequested = false;
    private active = false;

    constructor(algorithm: NikogeniaAlgorithmV1, mindmap: ParsedMindmap) {
        this.algorithm = algorithm;
        this.mindmap = mindmap;
    }

    get running(): boolean {
        return this.active;
    }

    get completed(): boolean {
        return this.algorithm.isCompleted();
    }

    /** Requests the run to stop; synchronous and idempotent. */
    stop(): void {
        this.stopRequested = true;
    }

    /**
     * Runs until the algorithm completes or `stop()` is called, rendering after
     * every `stepsPerRender` steps and once at the end.
     *
     * @param hooks Render and progress callbacks.
     * @returns Whether the run completed or was stopped.
     */
    async run(hooks: RunHooks): Promise<RunOutcome> {
        if (this.active) throw new Error("The layout run is already running.");
        this.active = true;
        this.stopRequested = false;
        let sinceRender = 0;
        try {
            while (!this.stopRequested && !this.algorithm.isCompleted()) {
                const limit = Math.max(1, hooks.stepsPerRender());
                const sliceStart = performance.now();
                while (!this.stopRequested && !this.algorithm.isCompleted() && sinceRender < limit
                    && performance.now() - sliceStart < SLICE_MS) {
                    this.algorithm.step();
                    sinceRender++;
                }
                if (this.stopRequested) break;
                if (sinceRender >= limit || this.algorithm.isCompleted()) {
                    sinceRender = 0;
                    if (!await hooks.render()) this.stopRequested = true;
                    else hooks.progress(this);
                }
                await yieldToUi();
            }
            // Show the last computed steps of a stopped run as well.
            if (sinceRender > 0 && await hooks.render()) hooks.progress(this);
            return this.algorithm.isCompleted() ? "completed" : "stopped";
        } finally {
            this.active = false;
            clearStepTimings();
        }
    }

    /**
     * Performs exactly one algorithm step and renders it.
     *
     * @param hooks Render and progress callbacks.
     */
    async step(hooks: Pick<RunHooks, "render" | "progress">): Promise<void> {
        if (this.active || this.algorithm.isCompleted()) return;
        this.algorithm.step();
        clearStepTimings();
        if (await hooks.render()) hooks.progress(this);
    }
}

/**
 * `NikogeniaAlgorithmV1.step` records a User Timing mark and measure per step,
 * which the global performance timeline would otherwise keep forever.
 */
function clearStepTimings(): void {
    performance.clearMarks("step-start");
    performance.clearMeasures("step-duration");
}

/**
 * Cheap version of the persistent scene content: temporary indicators are
 * excluded, so restoring them does not count as a change. Used to decide
 * whether a stopped run may be continued or the layout was edited meanwhile.
 *
 * @param elements Current scene elements.
 * @returns A version string.
 */
export function contentVersion(elements: readonly ExcalidrawElement[]): string {
    let count = 0;
    let sum = 0;
    for (const element of elements) {
        if ((element.customData as Record<string, unknown> | undefined)?.isMindmapTemporary === true) continue;
        count++;
        sum += element.version;
    }
    return `${count}:${sum}`;
}

/**
 * Formats the step timings of the algorithm (milliseconds, despite the core's
 * field name `stepNanoseconds`).
 *
 * @param algorithm Algorithm of the run.
 * @returns "now | min | avg | max ms", or dashes before the first step.
 */
export function stepTimings(algorithm: NikogeniaAlgorithmV1): string {
    const times = algorithm.stepNanoseconds;
    if (times.length === 0) return "Now - | Min - | Average - | Max -";
    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (const time of times) {
        min = Math.min(min, time);
        max = Math.max(max, time);
        sum += time;
    }
    const format = (value: number): string => value.toFixed(1);
    return `Now ${format(times[times.length - 1])} | Min ${format(min)} | Average ${format(sum / times.length)} | Max ${format(max)}`;
}
