import localforage from 'localforage';
import { extendPrototype as extendPrototypeSet } from 'localforage-setitems';
extendPrototypeSet(localforage);
import { extendPrototype as extendPrototypeGet } from 'localforage-getitems';
extendPrototypeGet(localforage);

import { type EditorState } from "@codemirror/state";
import { debounce, type EventRef, Events, type Plugin, TFile } from 'obsidian';
// @ts-expect-error (if somebody knows how to get rid of this TS error, please do share, allowSyntheticDefaultImports does not work)
import Indexer from './indexer.worker';

export type DatabaseItem<T> = { data: T, mtime: number };
export type DatabaseEntry<T> = [string, DatabaseItem<T>];

type MemoryDatabaseItem<T> = { data: T, mtime: number, dirty?: boolean };


export class EventComponent extends Events {
    _events: (() => void)[] = [];

    onunload() { }

    unload() {
        while (this._events.length > 0) {
            this._events.pop()!();
        }
    }

    register(event_unload: () => void) {
        this._events.push(event_unload);
    }

    registerEvent(event: EventRef) {
        // @ts-ignore (Eventref contains reference to the Events object it was attached to)
        this.register(() => event.e.offref(event));
    }
}


/**
 * Generic database class for storing data in indexedDB, automatically updates on file changes
 */
export class Database<T> extends EventComponent {
    /**
     * In-memory cache of the database
     */
    memory: Map<string, MemoryDatabaseItem<T>> = new Map();

    /**
     * IndexedDB instance for persisting data
     */
    persist: typeof localforage;

    private testtime: number = 0;

    /**
     * List of keys that have been deleted from the in-memory cache, but not yet from indexedDB
     * @private
     */
    private deleted_keys: Set<string> = new Set();


    /**
     * Trigger database update after a short delay, also trigger database flush after a longer delay
     */
    databaseUpdate = debounce(() => {
        this.trigger('database-update', this.allEntries());
        this.flushChanges();
    }, 100, true);

    /**
     * Flush changes of memory database to indexedDB buffer
     */
    flushChanges = debounce(async () => {
        await this.persistMemory();
        this.trigger('database-update', this.allEntries());
    }, 1000, true);

    public on(name: 'database-update' | 'database-create', callback: (update: DatabaseEntry<T>[]) => void, ctx?: any): EventRef;
    public on(name: 'database-migrate', callback: () => void, ctx?: any): EventRef;

    on(name: string, callback: (...args: any[]) => void, ctx?: any): EventRef {
        return super.on(name, callback, ctx);
    }


    /**
     * Constructor for the database
     * @param plugin The plugin that owns the database
     * @param name Name of the database within indexedDB
     * @param title Title of the database
     * @param version Version of the database
     * @param description Description of the database
     * @param defaultValue Constructor for the default value of the database
     * @param extractValue Provide new values for database on file modification
     * @param workers Number of workers to use for parsing files
     * @param loadValue On loading value from indexedDB, run this function on the value (useful for re-adding prototypes)
     */
    constructor(
        public plugin: Plugin,
        public name: string,
        public title: string,
        public version: number,
        public description: string,
        private defaultValue: () => T,
        private extractValue: (file: TFile, state?: EditorState) => Promise<T>,
        public workers: number = 2,
        private loadValue: (data: T) => T = (data: T) => data,
    ) {
        super();

        // localforage does not offer a method for accessing the database version, so we store it separately
        const oldVersion = parseInt(this.plugin.app.loadLocalStorage(name + '-version')) || null;

        this.persist = localforage.createInstance({
            name: this.name + `/${this.plugin.app.appId}`,
            driver: localforage.INDEXEDDB,
            description,
            version,
        });

        this.plugin.app.workspace.onLayoutReady(async () => {
            await this.persist.ready(async () => {
                await this.loadDatabase();

                this.trigger('database-update', this.allEntries());

                const operation_label = oldVersion !== null && oldVersion < version ? "migrating" :
                    this.isEmpty() ? "initializing" : "syncing";

                if (oldVersion !== null && oldVersion < version && !this.isEmpty()) {
                    await this.clearDatabase();
                    await this.rebuildDatabase();
                    this.trigger('database-migrate');
                } else if (this.isEmpty()) {
                    await this.rebuildDatabase();
                    this.trigger('database-create');
                } else {
                    await this.syncDatabase();
                }

                // Alternatives: use 'this.editorExtensions.push(EditorView.updateListener.of(async (update) => {'
                // 	for instant View updates, but this requires the file to be read into the file cache first
                this.registerEvent(this.plugin.app.vault.on('modify', async (file) => {
                    if (file instanceof TFile && file.extension === "md") {
                        const current_editor = this.plugin.app.workspace.activeEditor;
                        const state = (current_editor && current_editor.file?.path === file.path && current_editor.editor) ? current_editor.editor.cm.state : undefined;
                        this.storeKey(file.path, await this.extractValue(file, state), file.stat.mtime);
                    }
                }));

                this.registerEvent(this.plugin.app.vault.on('delete', async (file) => {
                    if (file instanceof TFile && file.extension === "md") this.deleteKey(file.path);
                }));

                this.registerEvent(this.plugin.app.vault.on('rename', async (file, oldPath) => {
                    if (file instanceof TFile && file.extension === "md") this.renameKey(oldPath, file.path, file.stat.mtime);
                }));

                this.registerEvent(this.plugin.app.vault.on('create', async (file) => {
                    if (file instanceof TFile && file.extension === "md") this.storeKey(file.path, this.defaultValue(), file.stat.mtime);
                }));
            });
        });
    }

    /**
     * Load database from indexedDB
     */
    async loadDatabase() {
        this.memory = new Map(
            Object.entries(await this.persist.getItems() as Record<string, DatabaseItem<T>>)
                .map(([key, value]) => {
                    value.data = this.loadValue(value.data);
                    return [key, value];
                })
        );
    }

    /**
     * Extract values from files and store them in the database
     * @remark Expensive, this function will block the main thread
     * @param files Files to extract values from and store/update in the database
     */
    async regularParseFiles(files: TFile[]) {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const value = this.getItem(file.path);
            if (value === null || value.mtime < file.stat.mtime)
                this.storeKey(file.path, await this.extractValue(file), file.stat.mtime, true);
        }
    }

    /**
     * Extract values from files and store them in the database using workers
     * @remark Prefer usage of this function over regularParseFiles
     * @param files Files to extract values from and store/update in the database
     */
    async workerParseFiles(files: TFile[]) {
        const read_files = await Promise.all(files.map(async file => await this.plugin.app.vault.cachedRead(file)));
        const chunk_size = Math.ceil(files.length / this.workers);

        for (let i = 0; i < this.workers; i++) {
            const worker: Worker = new Indexer(null, { name: this.title + " indexer " + (i + 1)});
            const files_chunk = files.slice(i * chunk_size, (i + 1) * chunk_size);
            const read_files_chunk = read_files.slice(i * chunk_size, (i + 1) * chunk_size);
            worker.onmessage = (event: {data: T[]}) => {
                for (let i = 0; i < files_chunk.length; i++) {
                    const file = files_chunk[i];
                    const extracted_value = this.loadValue(event.data[i]);
                    this.storeKey(file.path, extracted_value, file.stat.mtime, true);
                }
                worker.terminate();
            }
            worker.postMessage(read_files_chunk);
        }

        this.plugin.app.saveLocalStorage(this.name + '-version', this.version.toString());
    }

    /**
     * Synchronize database with vault contents
     */
    async syncDatabase() {
        const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
        this.allKeys().forEach(key => {
            if (!markdownFiles.some(file => file.path === key))
                this.deleteKey(key);
        });

        const filesToParse = markdownFiles
            .filter(file => !this.memory.has(file.path) || this.memory.get(file.path)!.mtime < file.stat.mtime);
        if (filesToParse.length <= 100)
            await this.regularParseFiles(filesToParse);
        else
            await this.workerParseFiles(filesToParse);

        this.plugin.app.saveLocalStorage(this.name + '-version', this.version.toString());
    }

    /**
     * Rebuild database from scratch by parsing all files in the vault
     */
    async rebuildDatabase() {
        await this.workerParseFiles(this.plugin.app.vault.getMarkdownFiles());
        this.plugin.app.saveLocalStorage(this.name + '-version', this.version.toString());
    }

    /**
     * Persist in-memory database to indexedDB
     * @remark Prefer usage of flushChanges over this function to reduce the number of writes to indexedDB
     */
    async persistMemory() {
        const to_set: Record<string, DatabaseItem<T>> = {};
        for (const [key, value] of this.memory.entries()) {
            if (value.dirty) {
                to_set[key] = { data: value.data, mtime: value.mtime };
                this.memory.set(key, { data: value.data, mtime: value.mtime, dirty: false });
            }
        }

        await this.persist.setItems(to_set);
        await Promise.all(Array.from(this.deleted_keys.values()).map(async (key) => await this.persist.removeItem(key)));
        this.deleted_keys.clear();
    }

    storeKey(key: string, value: T, mtime?: number, dirty = true) {
        this.memory.set(key, { data: value, mtime: mtime ?? Date.now(), dirty });
        this.databaseUpdate();
    }

    deleteKey(key: string) {
        const value = this.getItem(key) as MemoryDatabaseItem<T>;
        if (value == null) throw new Error('Key does not exist');

        this.memory.delete(key);
        this.deleted_keys.add(key);

        this.databaseUpdate();
    }

    renameKey(oldKey: string, newKey: string, mtime?: number) {
        const value = this.getItem(oldKey);
        if (value == null) throw new Error('Key does not exist');

        this.storeKey(newKey, value.data, mtime);
        this.deleteKey(oldKey);
        this.databaseUpdate();
    }

    allKeys(): string[] {
        return Array.from(this.memory.keys());
    }

    getValue(key: string): T | null {
        return this.memory.get(key)?.data ?? null;
    }

    allValues(): T[] {
        return Array.from(this.memory.values()).map(value => value.data);
    }

    getItem(key: string): DatabaseItem<T> | null {
        return this.memory.get(key) ?? null;
    }

    allItems(): DatabaseItem<T>[] {
        return Array.from(this.memory.values());
    }

    allEntries(): DatabaseEntry<T>[] | null {
        return Array.from(this.memory.entries());
    }

    /**
     * Clear in-memory cache, and completely remove database from indexedDB (and all references in localStorage)
     */
    async dropDatabase() {
        this.memory.clear();
        await localforage.dropInstance({
            name: this.name + `/${this.plugin.app.appId}`,
        });
        localStorage.removeItem(this.plugin.app.appId + '-' + this.name + '-version');
    }

    /**
     * Rebuild database from scratch
     * @remark Useful for fixing incorrectly set version numbers
     */
    async reinitializeDatabase() {
        await this.dropDatabase();
        this.persist = localforage.createInstance({
            name: this.name + `/${this.plugin.app.appId}`,
            driver: localforage.INDEXEDDB,
            version: this.version,
            description: this.description,
        });
        await this.rebuildDatabase();
        this.trigger('database-update', this.allEntries());
    }

    /**
     * Clear in-memory cache, and clear database contents from indexedDB
     */
    async clearDatabase() {
        this.memory.clear();
        await this.persist.clear();
    }

    /**
     * Check if database is empty
     * @remark Run after `loadDatabase()`
     */
    isEmpty(): boolean {
        return this.memory.size === 0;
    }
}

