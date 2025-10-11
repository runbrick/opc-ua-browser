import * as vscode from 'vscode';
import { OpcuaClient } from './opcuaClient';
import { OpcuaConnectionConfig, ConnectionStatus } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class ConnectionManager {
    private connections: Map<string, OpcuaClient> = new Map();
    private context: vscode.ExtensionContext;
    private static readonly STORAGE_KEY = 'opcua.connections';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadConnections();
    }

    private loadConnections(): void {
        const saved = this.context.globalState.get<OpcuaConnectionConfig[]>(
            ConnectionManager.STORAGE_KEY,
            []
        );

        for (const config of saved) {
            const client = new OpcuaClient(config);
            this.connections.set(config.id, client);
        }
    }

    private async saveConnections(): Promise<void> {
        const configs: OpcuaConnectionConfig[] = [];

        for (const [id, client] of this.connections.entries()) {
            const config = (client as any).config as OpcuaConnectionConfig;
            configs.push(config);
        }

        await this.context.globalState.update(ConnectionManager.STORAGE_KEY, configs);
    }

    async addConnection(config: OpcuaConnectionConfig): Promise<string> {
        if (!config.id) {
            config.id = uuidv4();
        }

        const client = new OpcuaClient(config);
        this.connections.set(config.id, client);
        await this.saveConnections();

        return config.id;
    }

    async removeConnection(connectionId: string): Promise<void> {
        const client = this.connections.get(connectionId);
        if (client) {
            if (client.isConnected) {
                await client.disconnect();
            }
            this.connections.delete(connectionId);
            await this.saveConnections();
        }
    }

    async connect(connectionId: string): Promise<void> {
        const client = this.connections.get(connectionId);
        if (!client) {
            throw new Error(`Connection ${connectionId} not found`);
        }

        if (client.isConnected) {
            return;
        }

        await client.connect();
    }

    async disconnect(connectionId: string): Promise<void> {
        const client = this.connections.get(connectionId);
        if (!client) {
            throw new Error(`Connection ${connectionId} not found`);
        }

        await client.disconnect();
    }

    getConnection(connectionId: string): OpcuaClient | undefined {
        return this.connections.get(connectionId);
    }

    getAllConnections(): Map<string, OpcuaClient> {
        return this.connections;
    }

    getConnectionConfig(connectionId: string): OpcuaConnectionConfig | undefined {
        const client = this.connections.get(connectionId);
        if (client) {
            return (client as any).config as OpcuaConnectionConfig;
        }
        return undefined;
    }

    getConnectionStatus(connectionId: string): ConnectionStatus {
        const client = this.connections.get(connectionId);
        return client ? client.status : ConnectionStatus.Disconnected;
    }

    async dispose(): Promise<void> {
        for (const [id, client] of this.connections.entries()) {
            if (client.isConnected) {
                await client.disconnect();
            }
        }
        this.connections.clear();
    }
}
