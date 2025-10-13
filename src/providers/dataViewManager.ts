import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';

interface StoredDataViewEntry {
    connectionId: string;
    nodeId: string;
    displayName?: string;
    dataType?: string;
    description?: string;
    nodeClass?: string;
}

export interface DataViewEntry extends StoredDataViewEntry {
    id: string;
    connectionName: string;
}

export class DataViewManager implements vscode.Disposable {
    private static readonly STORAGE_KEY = 'opcua.dataView.entries';
    private static readonly COLUMN_KEY = 'opcua.dataView.columns';

    private readonly entries = new Map<string, StoredDataViewEntry>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager
    ) {
        this.loadEntries();
    }

    public get onDidChange(): vscode.Event<void> {
        return this.changeEmitter.event;
    }

    public getEntries(): DataViewEntry[] {
        const list: DataViewEntry[] = [];
        for (const [id, entry] of this.entries.entries()) {
            list.push(this.toDataViewEntry(id, entry));
        }
        return list;
    }

    public async addNode(connectionId: string, nodeId: string): Promise<DataViewEntry> {
        const entryId = this.composeId(connectionId, nodeId);
        const existing = this.entries.get(entryId);
        if (existing) {
            return this.toDataViewEntry(entryId, existing);
        }

        const client = this.connectionManager.getConnection(connectionId);
        if (!client || !client.isConnected) {
            throw new Error('Connection is not active');
        }

        const nodeInfo = await client.readNodeAttributes(nodeId);
        const stored: StoredDataViewEntry = {
            connectionId,
            nodeId,
            displayName: nodeInfo.displayName || nodeInfo.browseName || nodeId,
            dataType: nodeInfo.dataType,
            description: nodeInfo.description,
            nodeClass: nodeInfo.nodeClass
        };

        this.entries.set(entryId, stored);
        await this.saveEntries();
        this.notifyChange();
        return this.toDataViewEntry(entryId, stored);
    }

    public async removeNode(entryId: string): Promise<void> {
        if (this.entries.delete(entryId)) {
            await this.saveEntries();
            this.notifyChange();
        }
    }

    public hasNode(connectionId: string, nodeId: string): boolean {
        return this.entries.has(this.composeId(connectionId, nodeId));
    }

    public async removeNodeByIdentity(connectionId: string, nodeId: string): Promise<void> {
        const entryId = this.composeId(connectionId, nodeId);
        await this.removeNode(entryId);
    }

    public async clear(): Promise<void> {
        if (this.entries.size === 0) {
            return;
        }
        this.entries.clear();
        await this.saveEntries();
        this.notifyChange();
    }

    public getColumnPreferences(): string[] | undefined {
        return this.context.globalState.get<string[]>(DataViewManager.COLUMN_KEY);
    }

    public async setColumnPreferences(columns: string[]): Promise<void> {
        await this.context.globalState.update(DataViewManager.COLUMN_KEY, columns);
        this.notifyChange();
    }

    public getEntry(entryId: string): DataViewEntry | undefined {
        const stored = this.entries.get(entryId);
        if (!stored) {
            return undefined;
        }
        return this.toDataViewEntry(entryId, stored);
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.changeEmitter.dispose();
    }

    private loadEntries(): void {
        const saved = this.context.globalState.get<StoredDataViewEntry[]>(DataViewManager.STORAGE_KEY, []);
        for (const entry of saved) {
            const entryId = this.composeId(entry.connectionId, entry.nodeId);
            this.entries.set(entryId, entry);
        }
    }

    private async saveEntries(): Promise<void> {
        await this.context.globalState.update(
            DataViewManager.STORAGE_KEY,
            Array.from(this.entries.values())
        );
    }

    private composeId(connectionId: string, nodeId: string): string {
        return `${connectionId}::${nodeId}`;
    }

    private toDataViewEntry(id: string, stored: StoredDataViewEntry): DataViewEntry {
        const config = this.connectionManager.getConnectionConfig(stored.connectionId);
        return {
            id,
            ...stored,
            connectionName: config?.name || config?.endpointUrl || stored.connectionId
        };
    }

    private notifyChange(): void {
        this.changeEmitter.fire();
    }
}
