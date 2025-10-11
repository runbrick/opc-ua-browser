import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaConnectionConfig, ConnectionStatus } from '../types';
import { ReferenceDescription, NodeClass } from 'node-opcua';

export class OpcuaTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private connectionManager: ConnectionManager) {}

    refresh(element?: TreeNode): void {
        this._onDidChangeTreeData.fire(element);
    }

    refreshConnection(connectionId: string): void {
        // 刷新特定连接节点
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // 返回所有连接
            return this.getConnectionNodes();
        }

        if (element instanceof ConnectionNode) {
            // 返回服务器的根节点
            return this.getRootNodes(element.connectionId);
        }

        if (element instanceof OpcuaNode) {
            // 返回节点的子节点
            return this.getChildNodes(element.connectionId, element.nodeId);
        }

        return [];
    }

    private getConnectionNodes(): TreeNode[] {
        const nodes: TreeNode[] = [];
        const connections = this.connectionManager.getAllConnections();

        for (const [id, client] of connections.entries()) {
            const config = this.connectionManager.getConnectionConfig(id);
            if (config) {
                nodes.push(new ConnectionNode(config, client.status));
            }
        }

        return nodes;
    }

    private async getRootNodes(connectionId: string): Promise<TreeNode[]> {
        try {
            console.log(`getRootNodes called for connection: ${connectionId}`);
            const client = this.connectionManager.getConnection(connectionId);
            if (!client) {
                console.log('Client not found');
                return [];
            }

            console.log(`Client status: ${client.status}, isConnected: ${client.isConnected}`);
            if (!client.isConnected) {
                console.log('Client not connected');
                return [];
            }

            console.log('Browsing RootFolder...');
            const references = await client.browse('RootFolder');
            console.log(`Found ${references.length} root nodes`);

            return references.map(ref => new OpcuaNode(
                connectionId,
                ref.nodeId.toString(),
                ref.displayName.text || ref.browseName.name || '',
                ref.nodeClass,
                true
            ));
        } catch (error) {
            console.error('Error getting root nodes:', error);
            return [];
        }
    }

    private async getChildNodes(connectionId: string, nodeId: string): Promise<TreeNode[]> {
        try {
            const client = this.connectionManager.getConnection(connectionId);
            if (!client || !client.isConnected) {
                return [];
            }

            const references = await client.browse(nodeId);
            return references.map(ref => new OpcuaNode(
                connectionId,
                ref.nodeId.toString(),
                ref.displayName.text || ref.browseName.name || '',
                ref.nodeClass,
                this.hasChildren(ref)
            ));
        } catch (error) {
            console.error('Error getting child nodes:', error);
            return [];
        }
    }

    private hasChildren(ref: ReferenceDescription): boolean {
        // 对象和文件夹通常有子节点
        return ref.nodeClass === NodeClass.Object;
    }
}

export abstract class TreeNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}

export class ConnectionNode extends TreeNode {
    constructor(
        public readonly config: OpcuaConnectionConfig,
        public readonly status: ConnectionStatus
    ) {
        super(
            config.name || config.endpointUrl,
            status === ConnectionStatus.Connected
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.tooltip = config.endpointUrl;
        this.description = this.getStatusText(status);
        this.iconPath = this.getStatusIcon(status);
        this.contextValue = status === ConnectionStatus.Connected
            ? 'opcua-server-connected'
            : 'opcua-server-disconnected';
    }

    get connectionId(): string {
        return this.config.id;
    }

    private getStatusText(status: ConnectionStatus): string {
        switch (status) {
            case ConnectionStatus.Connected:
                return 'Connected';
            case ConnectionStatus.Connecting:
                return 'Connecting...';
            case ConnectionStatus.Error:
                return 'Error';
            default:
                return 'Disconnected';
        }
    }

    private getStatusIcon(status: ConnectionStatus): vscode.ThemeIcon {
        switch (status) {
            case ConnectionStatus.Connected:
                return new vscode.ThemeIcon('vm-connect', new vscode.ThemeColor('charts.green'));
            case ConnectionStatus.Connecting:
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
            case ConnectionStatus.Error:
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('vm-outline');
        }
    }
}

export class OpcuaNode extends TreeNode {
    constructor(
        public readonly connectionId: string,
        public readonly nodeId: string,
        public readonly displayName: string,
        public readonly nodeClass: number,
        private readonly hasChildNodes: boolean
    ) {
        super(
            displayName,
            hasChildNodes
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.tooltip = `NodeId: ${nodeId}`;
        this.description = this.getNodeClassText(nodeClass);
        this.iconPath = this.getNodeIcon(nodeClass);
        this.contextValue = 'opcua-node';

        // 设置点击命令
        this.command = {
            command: 'opcua.showNodeDetails',
            title: 'Show Node Details',
            arguments: [this]
        };
    }

    private getNodeClassText(nodeClass: number): string {
        const nodeClassNames: { [key: number]: string } = {
            1: 'Object',
            2: 'Variable',
            4: 'Method',
            8: 'ObjectType',
            16: 'VariableType',
            32: 'ReferenceType',
            64: 'DataType',
            128: 'View'
        };
        return nodeClassNames[nodeClass] || 'Unknown';
    }

    private getNodeIcon(nodeClass: number): vscode.ThemeIcon {
        switch (nodeClass) {
            case 1: // Object
                return new vscode.ThemeIcon('folder');
            case 2: // Variable
                return new vscode.ThemeIcon('symbol-variable');
            case 4: // Method
                return new vscode.ThemeIcon('symbol-method');
            case 8: // ObjectType
                return new vscode.ThemeIcon('symbol-class');
            case 16: // VariableType
                return new vscode.ThemeIcon('symbol-interface');
            case 32: // ReferenceType
                return new vscode.ThemeIcon('references');
            case 64: // DataType
                return new vscode.ThemeIcon('symbol-enum');
            case 128: // View
                return new vscode.ThemeIcon('eye');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}
