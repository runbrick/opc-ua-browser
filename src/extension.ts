import * as vscode from 'vscode';
import { ConnectionManager } from './opcua/connectionManager';
import { OpcuaTreeDataProvider, OpcuaNode, ConnectionNode } from './providers/opcuaTreeDataProvider';
import { NodeDetailPanel } from './webview/NodeDetailPanel';
import { DataViewPanel } from './webview/DataViewPanel';
import {
    addConnectionCommand,
    connectCommand,
    disconnectCommand,
    deleteConnectionCommand,
    editConnectionCommand,
    refreshConnectionsCommand
} from './commands/connectionCommands';
import { exportNodeToExcelCommand } from './commands/exportCommands';
import { searchNodeCommand, searchNodeInConnectionCommand } from './commands/searchCommands';
import { DataViewManager } from './providers/dataViewManager';
import { addNodeToDataViewCommand } from './commands/dataViewCommands';

export function activate(context: vscode.ExtensionContext) {
    console.log('OPC UA Browser extension is now active!');

    // Initialize connection manager
    const connectionManager = new ConnectionManager(context);
    const dataViewManager = new DataViewManager(context, connectionManager);

    // Initialize tree view data provider
    const treeDataProvider = new OpcuaTreeDataProvider(connectionManager);

    // Register tree view
    const treeView = vscode.window.createTreeView('opcuaConnections', {
        treeDataProvider,
        showCollapseAll: true
    });

    // Register command: Add connection
    const addConnectionCmd = vscode.commands.registerCommand(
        'opcua.addConnection',
        async () => {
            await addConnectionCommand(context.extensionUri, connectionManager, treeDataProvider);
        }
    );

    // Register command: Refresh connection list
    const refreshConnectionsCmd = vscode.commands.registerCommand(
        'opcua.refreshConnections',
        () => {
            refreshConnectionsCommand(treeDataProvider);
        }
    );

    // Register command: Connect to server
    const connectCmd = vscode.commands.registerCommand(
        'opcua.connect',
        async (node) => {
            await connectCommand(connectionManager, treeDataProvider, node);
        }
    );

    // Register command: Disconnect
    const disconnectCmd = vscode.commands.registerCommand(
        'opcua.disconnect',
        async (node) => {
            await disconnectCommand(connectionManager, treeDataProvider, node);
        }
    );

    const toggleNonHierarchicalCmd = vscode.commands.registerCommand(
        'opcua.toggleNonHierarchicalReferences',
        (node?: ConnectionNode) => {
            if (!node) {
                vscode.window.showWarningMessage('Select a connection in the tree to toggle references.');
                return;
            }

            const connectionNode = node as ConnectionNode;
            const includeNonHierarchical = treeDataProvider.toggleNonHierarchicalReferences(connectionNode.connectionId);
            const displayName = connectionNode.label || connectionNode.config.name || connectionNode.config.endpointUrl;

            const message = includeNonHierarchical
                ? `Showing all references for "${displayName}".`
                : `Showing only hierarchical references for "${displayName}".`;

            vscode.window.showInformationMessage(message);
        }
    );

    // Register command: Delete connection
    const deleteConnectionCmd = vscode.commands.registerCommand(
        'opcua.deleteConnection',
        async (node) => {
            await deleteConnectionCommand(connectionManager, treeDataProvider, node);
        }
    );
    const editConnectionCmd = vscode.commands.registerCommand(
        'opcua.editConnection',
        async (node) => {
            await editConnectionCommand(context.extensionUri, connectionManager, treeDataProvider, node);
        }
    );

    // Register command: Show node details
    const showNodeDetailsCmd = vscode.commands.registerCommand(
        'opcua.showNodeDetails',
        async (node: OpcuaNode | { connectionId?: string; nodeId?: string }) => {
            const connectionId = node instanceof OpcuaNode ? node.connectionId : node?.connectionId;
            const nodeId = node instanceof OpcuaNode ? node.nodeId : node?.nodeId;

            if (!connectionId || !nodeId) {
                vscode.window.showWarningMessage('Unable to show node details: missing node information.');
                return;
            }

            await NodeDetailPanel.show(
                context.extensionUri,
                connectionManager,
                connectionId,
                nodeId
            );
        }
    );

    // Register command: Add monitored node to Data View
    const addNodeToDataViewCmd = vscode.commands.registerCommand(
        'opcua.dataView.addNode',
        async (node: OpcuaNode) => {
            const result = await addNodeToDataViewCommand(connectionManager, dataViewManager, node);
            if (result) {
                await DataViewPanel.show(context.extensionUri, connectionManager, dataViewManager);
            }
        }
    );

    const openDataViewCmd = vscode.commands.registerCommand(
        'opcua.openDataView',
        async () => {
            await DataViewPanel.show(context.extensionUri, connectionManager, dataViewManager);
        }
    );

    // Register command: Export node to Excel
    const exportNodeToExcelCmd = vscode.commands.registerCommand(
        'opcua.exportNodeToExcel',
        async (node: OpcuaNode) => {
            if (node instanceof OpcuaNode) {
                await exportNodeToExcelCommand(connectionManager, node);
            }
        }
    );

    // Register command: Search nodes
    const searchNodesCmd = vscode.commands.registerCommand(
        'opcua.searchNodes',
        async () => {
            await searchNodeCommand(connectionManager, treeDataProvider, treeView, context.extensionUri);
        }
    );

    const searchNodesForConnectionCmd = vscode.commands.registerCommand(
        'opcua.searchNodesForConnection',
        async (node: ConnectionNode) => {
            await searchNodeInConnectionCommand(
                connectionManager,
                treeDataProvider,
                treeView,
                node,
                context.extensionUri
            );
        }
    );

    // Add all commands and resources to subscriptions
    context.subscriptions.push(
        treeView,
        dataViewManager,
        addConnectionCmd,
        refreshConnectionsCmd,
        connectCmd,
        disconnectCmd,
        deleteConnectionCmd,
        editConnectionCmd,
        showNodeDetailsCmd,
        addNodeToDataViewCmd,
        openDataViewCmd,
        exportNodeToExcelCmd,
        searchNodesCmd,
        searchNodesForConnectionCmd,
        toggleNonHierarchicalCmd
    );

    // Welcome message
    vscode.window.showInformationMessage('OPC UA Browser is ready!');
}

export function deactivate() {
    console.log('OPC UA Browser extension is now deactivated.');
}
