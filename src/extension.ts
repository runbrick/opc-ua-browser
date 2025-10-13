import * as vscode from 'vscode';
import { ConnectionManager } from './opcua/connectionManager';
import { OpcuaTreeDataProvider, OpcuaNode, ConnectionNode } from './providers/opcuaTreeDataProvider';
import { NodeDetailPanel } from './webview/NodeDetailPanel';
import {
    addConnectionCommand,
    connectCommand,
    disconnectCommand,
    deleteConnectionCommand,
    editConnectionCommand,
    refreshConnectionsCommand
} from './commands/connectionCommands';
import { exportNodeCommand, exportNodeToExcelCommand } from './commands/exportCommands';
import { searchNodeCommand, searchNodeInConnectionCommand } from './commands/searchCommands';

export function activate(context: vscode.ExtensionContext) {
    console.log('OPC UA Browser extension is now active!');

    // 初始化连接管理器
    const connectionManager = new ConnectionManager(context);

    // 初始化树视图数据提供者
    const treeDataProvider = new OpcuaTreeDataProvider(connectionManager);

    // 注册树视图
    const treeView = vscode.window.createTreeView('opcuaConnections', {
        treeDataProvider: treeDataProvider,
        showCollapseAll: true
    });

    // 注册命令：添加连接
    const addConnectionCmd = vscode.commands.registerCommand(
        'opcua.addConnection',
        async () => {
            await addConnectionCommand(connectionManager, treeDataProvider);
        }
    );

    // 注册命令：刷新连接列表
    const refreshConnectionsCmd = vscode.commands.registerCommand(
        'opcua.refreshConnections',
        () => {
            refreshConnectionsCommand(treeDataProvider);
        }
    );

    // 注册命令：连接到服务器
    const connectCmd = vscode.commands.registerCommand(
        'opcua.connect',
        async (node) => {
            await connectCommand(connectionManager, treeDataProvider, node);
        }
    );

    // 注册命令：断开连接
    const disconnectCmd = vscode.commands.registerCommand(
        'opcua.disconnect',
        async (node) => {
            await disconnectCommand(connectionManager, treeDataProvider, node);
        }
    );

    // 注册命令：删除连接
    const deleteConnectionCmd = vscode.commands.registerCommand(
        'opcua.deleteConnection',
        async (node) => {
            await deleteConnectionCommand(connectionManager, treeDataProvider, node);
        }
    );
    const editConnectionCmd = vscode.commands.registerCommand(
        'opcua.editConnection',
        async (node) => {
            await editConnectionCommand(connectionManager, treeDataProvider, node);
        }
    );

    // 注册命令：显示节点详情
    const showNodeDetailsCmd = vscode.commands.registerCommand(
        'opcua.showNodeDetails',
        async (node: OpcuaNode) => {
            if (node instanceof OpcuaNode) {
                await NodeDetailPanel.show(
                    context.extensionUri,
                    connectionManager,
                    node.connectionId,
                    node.nodeId
                );
            }
        }
    );

    // 注册命令：导出节点为 JSON
    const exportNodeCmd = vscode.commands.registerCommand(
        'opcua.exportNode',
        async (node: OpcuaNode) => {
            if (node instanceof OpcuaNode) {
                await exportNodeCommand(connectionManager, node);
            }
        }
    );

    // 注册命令：导出节点为 Excel
    const exportNodeToExcelCmd = vscode.commands.registerCommand(
        'opcua.exportNodeToExcel',
        async (node: OpcuaNode) => {
            if (node instanceof OpcuaNode) {
                await exportNodeToExcelCommand(connectionManager, node);
            }
        }
    );

    // 注册命令：搜索节点
    const searchNodesCmd = vscode.commands.registerCommand(
        'opcua.searchNodes',
        async () => {
            await searchNodeCommand(connectionManager, treeDataProvider, treeView);
        }
    );

    const searchNodesForConnectionCmd = vscode.commands.registerCommand(
        'opcua.searchNodesForConnection',
        async (node: ConnectionNode) => {
            await searchNodeInConnectionCommand(connectionManager, treeDataProvider, treeView, node);
        }
    );

    // 将所有命令和资源添加到订阅中
    context.subscriptions.push(
        treeView,
        addConnectionCmd,
        refreshConnectionsCmd,
        connectCmd,
        disconnectCmd,
        deleteConnectionCmd,
        editConnectionCmd,
        showNodeDetailsCmd,
        exportNodeCmd,
        exportNodeToExcelCmd,
        searchNodesCmd,
        searchNodesForConnectionCmd
    );

    // 欢迎消息
    vscode.window.showInformationMessage('OPC UA Browser is ready!');
}

export function deactivate() {
    console.log('OPC UA Browser extension is now deactivated.');
}
