import type { App, TFile, TFolder, WorkspaceLeaf } from "obsidian";

export interface MindmapBackup {
    file: TFile;
    run: number;
}

/**
 * Creation time of a backup. `TFile.stat.ctime` is set by `Vault.create` and
 * survives a vault reload, unlike anything kept in memory.
 *
 * @param backup Backup file.
 * @returns Localized date and time.
 */
export function backupCreatedAt(backup: MindmapBackup): string {
    return new Date(backup.file.stat.ctime).toLocaleString();
}

function directoryOf(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
}

function basenameOf(path: string): string {
    const separator = path.lastIndexOf("/");
    return path.slice(separator + 1);
}

function backupFolderPath(file: TFile): string {
    const directory = directoryOf(file.path);
    return directory ? `${directory}/mindmap-backup` : "mindmap-backup";
}

function backupPattern(file: TFile): RegExp {
    const escapedName = basenameOf(file.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedName}\\.run(\\d+)\\.backup$`);
}

function matchingBackups(app: App, file: TFile): MindmapBackup[] {
    const folder = `${backupFolderPath(file)}/`;
    const pattern = backupPattern(file);
    return app.vault.getFiles()
        .filter((candidate) => candidate.path.startsWith(folder))
        .flatMap((candidate) => {
            const match = pattern.exec(candidate.path.slice(folder.length));
            return match ? [{ file: candidate, run: Number(match[1]) }] : [];
        })
        .sort((left, right) => right.run - left.run);
}

function emptyBackupFolder(app: App, path: string): TFolder | undefined {
    const folder = app.vault.getAbstractFileByPath(path);
    if (!folder || !("children" in folder)) return undefined;
    const hasFiles = app.vault.getFiles().some((file) => file.path.startsWith(`${path}/`));
    return !hasFiles ? folder as TFolder : undefined;
}

/** Returns backups belonging exactly to the active drawing file, newest (highest run) first. */
export function listMindmapBackups(app: App, file: TFile): MindmapBackup[] {
    return matchingBackups(app, file);
}

/**
 * Saves the complete drawing before the first persistent layout mutation.
 * `Vault.create` is used for collision detection instead of overwriting a file.
 */
export async function createMindmapBackup(app: App, file: TFile): Promise<MindmapBackup> {
    const folderPath = backupFolderPath(file);
    if (!app.vault.getAbstractFileByPath(folderPath)) await app.vault.createFolder(folderPath);
    const content = await app.vault.read(file);
    // Highest run + 1 rather than the first free number: after an older backup was
    // restored (and consumed), a reused number would sort before newer backups.
    let run = (matchingBackups(app, file)[0]?.run ?? 0) + 1;
    while (true) {
        const path = `${folderPath}/${basenameOf(file.path)}.run${run}.backup`;
        try {
            const backup = await app.vault.create(path, content);
            return { file: backup, run };
        } catch (error) {
            if (app.vault.getAbstractFileByPath(path)) {
                run++;
                continue;
            }
            throw error;
        }
    }
}

export interface RollbackHooks {
    /**
     * Runs after the backup was read and before the drawing file is written.
     * Must close every open editor of the file (see `closeViewsOfFile`).
     */
    beforeWrite: () => Promise<void>;
    /** Runs after the write attempt, also a failed one, typically to reopen the drawing. */
    afterWrite: () => Promise<void>;
}

/** Longer than the plugin's 200 ms deferred final save plus the time the write takes. */
const FILE_QUIET_MS = 750;
const FILE_QUIET_LIMIT_MS = 5000;
const RESTORE_ATTEMPTS = 3;

/**
 * Resolves once `file` was not modified for `FILE_QUIET_MS` (at most `FILE_QUIET_LIMIT_MS`).
 *
 * A closing Excalidraw view does not write its final save immediately:
 * `performSave` schedules `vault.modify` with a 200 ms timeout while
 * `semaphores.viewunload` is set, and that timer outlives the awaited
 * `View.close()`. Writing the backup before it fired lets it overwrite the
 * restored file.
 */
function waitForFileQuiet(app: App, file: TFile): Promise<void> {
    return new Promise((resolve) => {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
            if (quietTimer !== undefined) clearTimeout(quietTimer);
            clearTimeout(limitTimer);
            app.vault.offref(modifyRef);
            resolve();
        };
        const restartQuietTimer = (): void => {
            if (quietTimer !== undefined) clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, FILE_QUIET_MS);
        };
        const limitTimer = setTimeout(finish, FILE_QUIET_LIMIT_MS);
        const modifyRef = app.vault.on("modify", (changed) => {
            if (changed.path === file.path) restartQuietTimer();
        });
        restartQuietTimer();
    });
}

/** Writes `content` and verifies it is still there after the file went quiet. */
async function writeAndVerify(app: App, file: TFile, content: string): Promise<void> {
    for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
        await app.vault.modify(file, content);
        await waitForFileQuiet(app, file);
        if (await app.vault.read(file) === content) return;
    }
    throw new Error(`"${file.path}" kept being overwritten while restoring the backup.`);
}

/**
 * Closes every workspace leaf that currently shows `file` and returns the
 * leaves so one of them can reopen the restored drawing.
 *
 * An open Excalidraw view must not see the restore: when a view saved within
 * the last five minutes, the plugin handles an external `modify` with
 * `synchronizeWithData`, a merge that keeps whichever element has the higher
 * `version`. Backup elements are older, so the live scene wins, and the dirty
 * view then autosaves the merged scene over the restored file.
 * `setViewState` awaits `View.close()`, which schedules the view's final save
 * (see `waitForFileQuiet`) and destroys its script EA instances.
 */
export async function closeViewsOfFile(app: App, file: TFile): Promise<WorkspaceLeaf[]> {
    const leaves: WorkspaceLeaf[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as { file?: TFile | null };
        if (view.file === file) leaves.push(leaf);
    });
    for (const leaf of leaves) await leaf.setViewState({ type: "empty" });
    return leaves;
}

/**
 * Restores and then consumes one backup of the drawing (the newest one for a
 * plain Rollback, an older one when chosen in the dialog). Newer backups are
 * kept.
 *
 * The backup is read before anything is changed and deleted only after the
 * restored content was verified and the drawing reopened, so a failure never
 * loses the only recoverable copy. No editor is open between closing and
 * reopening, so verifying the file there cannot mistake a legitimate save of the
 * reopened view for an overwrite.
 */
export async function rollbackMindmapBackup(
    app: App,
    file: TFile,
    backup: MindmapBackup,
    hooks: RollbackHooks,
): Promise<boolean> {
    if (!matchingBackups(app, file).some((candidate) => candidate.file.path === backup.file.path)) return false;
    const content = await app.vault.read(backup.file);
    await hooks.beforeWrite();
    await waitForFileQuiet(app, file);
    try {
        await writeAndVerify(app, file, content);
    } finally {
        await hooks.afterWrite();
    }
    await app.vault.delete(backup.file);
    const folder = emptyBackupFolder(app, backupFolderPath(file));
    if (folder) {
        await app.vault.delete(folder, true);
    }
    return true;
}

/**
 * Removes only this drawing's backups and their folder when it becomes empty.
 *
 * @returns The number of deleted backups.
 */
export async function clearMindmapBackups(app: App, file: TFile): Promise<number> {
    const backups = matchingBackups(app, file);
    for (const backup of backups) await app.vault.delete(backup.file);
    const folder = emptyBackupFolder(app, backupFolderPath(file));
    if (folder) {
        await app.vault.delete(folder, true);
    }
    return backups.length;
}
