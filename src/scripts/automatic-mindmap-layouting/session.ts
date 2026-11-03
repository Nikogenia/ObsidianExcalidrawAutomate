import type { App, EventRef, TFile } from "obsidian";
import { removeTemporaryElementsNow, TransactionQueue } from "./scene";

type ExcalidrawView = NonNullable<ExcalidrawAutomate["targetView"]>;

/**
 * Why a session ended.
 * - `modal-close`: the user closed the main modal; the view is alive.
 * - `view-unload`: the drawing's view is closing; called synchronously from
 *   `onViewUnloadHook`, before the view's final save.
 * - `ea-destroy`: the script EA was destroyed (after the view's final save).
 * - `file-switch`: another file was opened in the same leaf; the view now shows
 *   a different drawing.
 * - `rollback`: the drawing is about to be closed and restored from a backup.
 * - `replaced`: the script was started again for the same view.
 */
export type TeardownReason = "modal-close" | "view-unload" | "ea-destroy" | "file-switch" | "rollback" | "replaced";

export interface SessionCallbacks {
    /** Debounced scene change; never called while the pointer is down. */
    onSceneChange: () => void;
    /** Called once when the session ends, after indicators were removed. */
    onTeardown: (reason: TeardownReason) => void;
}

const SCENE_CHANGE_DEBOUNCE_MS = 150;
const REGISTRY_KEY = "automaticMindmapLayoutingSessions";

function sessionRegistry(): WeakMap<object, WorkbenchSession> {
    const host = window as unknown as Record<string, WeakMap<object, WorkbenchSession> | undefined>;
    host[REGISTRY_KEY] ??= new WeakMap<object, WorkbenchSession>();
    return host[REGISTRY_KEY];
}

function sceneVersion(api: ExcalidrawAPI): string {
    const elements = api.getSceneElements();
    let sum = 0;
    for (const element of elements) sum += element.version;
    return `${elements.length}:${sum}`;
}

/**
 * Binds the workbench to one Excalidraw view and owns everything that must be
 * released with it.
 *
 * Close handling relies on three facts about Obsidian and the Excalidraw plugin:
 * 1. `View.close()` runs `unload()` synchronously and then awaits `onClose()`.
 *    `ExcalidrawView.onClose()` saves the drawing (`forceSaveIfRequired`) and
 *    only afterwards destroys the script EA instances (`removeViewEAs`), which
 *    is when `ea.registerCleanup` callbacks run - too late to keep indicators
 *    out of the file.
 * 2. `ExcalidrawView.onunload()` calls `onViewUnloadHook` on the view's hook
 *    server only. The hook server is `window.ExcalidrawAutomate` unless an EA
 *    calls `registerThisAsViewEA()`; a hook set on the script's own EA is
 *    otherwise never called.
 * 3. Obsidian's `Component.unload()` clears `_loaded` before `onunload()`, so
 *    inside the hook every EA view method fails with "targetView not set". The
 *    React editor is still mounted, so the imperative API captured at startup
 *    removes the indicators synchronously before the save.
 */
export class WorkbenchSession {
    readonly view: ExcalidrawView;
    readonly api: ExcalidrawAPI;
    readonly file: TFile;
    readonly app: App;
    readonly queue = new TransactionQueue();
    private isAlive = true;
    private pointerDown = false;
    private lastVersion = "";
    private changeTimer: number | undefined;
    private readonly disposers: (() => void)[] = [];
    private readonly previousUnloadHook: ExcalidrawAutomate["onViewUnloadHook"] | null;
    private readonly hookServerRegistered: boolean;

    private constructor(
        private readonly ea: ExcalidrawAutomate,
        view: ExcalidrawView,
        api: ExcalidrawAPI,
        file: TFile,
        private readonly callbacks: SessionCallbacks,
    ) {
        this.view = view;
        this.api = api;
        this.file = file;
        this.app = ea.plugin.app;
        this.previousUnloadHook = ea.onViewUnloadHook as ExcalidrawAutomate["onViewUnloadHook"] | null;
        this.hookServerRegistered = ea.registerThisAsViewEA();
        ea.onViewUnloadHook = (closingView) => {
            if (closingView === this.view) this.teardown("view-unload");
            if (typeof this.previousUnloadHook === "function") this.previousUnloadHook(closingView);
        };
        this.subscribe();
        this.disposers.push(ea.registerCleanup(() => this.teardown("ea-destroy")));
    }

    /**
     * Starts a session for the EA's current target view.
     *
     * @param ea Script EA bound to the drawing.
     * @param callbacks Scene and teardown callbacks.
     * @returns The session, or undefined when no drawing is available.
     */
    static start(ea: ExcalidrawAutomate, callbacks: SessionCallbacks): WorkbenchSession | undefined {
        const view = ea.targetView;
        const api = ea.getExcalidrawAPI();
        const file = view?.file;
        if (!view || !api || !file) return undefined;
        sessionRegistry().get(view)?.teardown("replaced");
        const session = new WorkbenchSession(ea, view, api, file, callbacks);
        sessionRegistry().set(view, session);
        return session;
    }

    /** True until teardown started. Every async continuation must check it. */
    get alive(): boolean {
        return this.isAlive;
    }

    /** Whether onViewUnloadHook is wired; false means close cleanup cannot run before the save. */
    get closeHookActive(): boolean {
        return this.hookServerRegistered;
    }

    /**
     * Runs a scene transaction in the session queue; skipped after teardown.
     *
     * @param transaction Transaction body.
     * @returns The transaction result, or undefined when skipped.
     */
    run<T>(transaction: () => Promise<T>): Promise<T | undefined> {
        return this.queue.run(async () => (this.isAlive ? transaction() : undefined));
    }

    /**
     * Ends the session once. Idempotent and synchronous.
     *
     * @param reason Why the session ends.
     */
    teardown(reason: TeardownReason): void {
        if (!this.isAlive) return;
        this.isAlive = false;
        if (this.changeTimer !== undefined) window.clearTimeout(this.changeTimer);
        for (const dispose of this.disposers.splice(0)) dispose();
        if (reason !== "file-switch") {
            removeTemporaryElementsNow(this.api);
            // A transaction that was already awaiting addElementsToView may still
            // add indicators; remove them once more after the queue drained.
            if (reason !== "view-unload" && reason !== "ea-destroy") {
                void this.queue.run(async () => removeTemporaryElementsNow(this.api));
            }
        }
        this.releaseHookServer(reason);
        if (sessionRegistry().get(this.view) === this) sessionRegistry().delete(this.view);
        this.callbacks.onTeardown(reason);
    }

    private subscribe(): void {
        this.lastVersion = sceneVersion(this.api);
        this.disposers.push(this.api.onChange(() => {
            if (!this.pointerDown) this.scheduleSceneChange(SCENE_CHANGE_DEBOUNCE_MS);
        }));
        this.disposers.push(this.api.onPointerDown(() => {
            this.pointerDown = true;
        }));
        this.disposers.push(this.api.onPointerUp(() => {
            this.pointerDown = false;
            this.scheduleSceneChange(0);
        }));
        const fileOpen: EventRef = this.app.workspace.on("file-open", () => {
            if (this.view.file !== this.file) this.teardown("file-switch");
        });
        this.disposers.push(() => this.app.workspace.offref(fileOpen));
    }

    private scheduleSceneChange(delay: number): void {
        if (this.changeTimer !== undefined) window.clearTimeout(this.changeTimer);
        this.changeTimer = window.setTimeout(() => {
            this.changeTimer = undefined;
            if (!this.isAlive || this.pointerDown || this.api.isDestroyed) return;
            const version = sceneVersion(this.api);
            if (version === this.lastVersion) return;
            this.lastVersion = version;
            this.callbacks.onSceneChange();
        }, delay);
    }

    /**
     * Gives hook dispatch back to `window.ExcalidrawAutomate` while the view
     * stays open. `deregisterThisAsViewEA()` in plugin 2.27.x re-registers the
     * calling EA instead of resetting it, so the view's own `setHookServer()`
     * (no argument resets to the plugin EA) is used when available. Hooks set
     * by this session are removed in any case.
     */
    private releaseHookServer(reason: TeardownReason): void {
        this.ea.onViewUnloadHook = this.previousUnloadHook as ExcalidrawAutomate["onViewUnloadHook"];
        if (!this.hookServerRegistered || reason === "view-unload" || reason === "ea-destroy") return;
        const view = this.view as ExcalidrawView & { setHookServer?: (ea?: ExcalidrawAutomate) => void };
        if (typeof view.setHookServer === "function") view.setHookServer();
        else this.ea.deregisterThisAsViewEA();
    }
}
