import type { App, TFile, TFolder } from "obsidian";

export interface MindmapBackup {
    file: TFile;
    run: number;
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

/** Returns backups belonging exactly to the active drawing file. */
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
    const existingRuns = new Set(matchingBackups(app, file).map((backup) => backup.run));
    let run = 1;
    while (existingRuns.has(run)) run++;
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

/** Restores and then consumes the newest backup for the active drawing. */
export async function rollbackLatestMindmapBackup(
    app: App,
    file: TFile,
    afterRestore?: (content: string) => Promise<void>,
): Promise<boolean> {
    const backup = matchingBackups(app, file)[0];
    if (!backup) return false;
    const content = await app.vault.read(backup.file);
    await app.vault.modify(file, content);
    if (afterRestore) await afterRestore(content);
    await app.vault.delete(backup.file);
    const folder = emptyBackupFolder(app, backupFolderPath(file));
    if (folder) {
        await app.vault.delete(folder, true);
    }
    return true;
}

/** Removes only this drawing's backups and their folder when it becomes empty. */
export async function clearMindmapBackups(app: App, file: TFile): Promise<void> {
    const backups = matchingBackups(app, file);
    for (const backup of backups) await app.vault.delete(backup.file);
    const folder = emptyBackupFolder(app, backupFolderPath(file));
    if (folder) {
        await app.vault.delete(folder, true);
    }
}
