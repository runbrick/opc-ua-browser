import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaNode } from '../providers/opcuaTreeDataProvider';
import { exportNodeToExcel, exportNodeTreeToExcel } from '../utils/excelExporter';
import { OpcuaNodeInfo } from '../types';

/**
 * 导出节点为 JSON 格式
 */
export async function exportNodeCommand(
    connectionManager: ConnectionManager,
    node: OpcuaNode
): Promise<void> {
    try {
        // 显示保存对话框
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${node.displayName}.json`),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            }
        });

        if (!uri) {
            return;
        }

        // 询问是否递归导出
        const recursive = await vscode.window.showQuickPick(
            [
                { label: 'Export node only', value: false },
                { label: 'Export node and all children (recursive)', value: true }
            ],
            { placeHolder: 'Select export mode' }
        );

        if (!recursive) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Exporting node to JSON...',
                cancellable: false
            },
            async (progress) => {
                const client = connectionManager.getConnection(node.connectionId);
                if (!client || !client.isConnected) {
                    throw new Error('Not connected to OPC UA server');
                }

                let exportData: any;

                if (recursive.value) {
                    // 递归导出
                    progress.report({ message: 'Recursively browsing nodes...' });
                    exportData = await client.recursiveBrowse(node.nodeId, 10);
                } else {
                    // 仅导出当前节点
                    progress.report({ message: 'Reading node attributes...' });
                    const nodeInfo = await client.readNodeAttributes(node.nodeId);
                    const references = await client.getReferences(node.nodeId);

                    exportData = {
                        ...nodeInfo,
                        references: references
                    };
                }

                // 写入文件
                progress.report({ message: 'Writing to file...' });
                const content = JSON.stringify(exportData, null, 2);
                await vscode.workspace.fs.writeFile(
                    uri,
                    Buffer.from(content, 'utf8')
                );

                vscode.window.showInformationMessage(
                    `Node exported successfully to ${uri.fsPath}`
                );

                // 询问是否打开文件
                const openFile = await vscode.window.showInformationMessage(
                    'Export complete. Would you like to open the file?',
                    'Open',
                    'Cancel'
                );

                if (openFile === 'Open') {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(document);
                }
            }
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export node: ${error}`);
    }
}

/**
 * 导出节点为 Excel 格式
 */
export async function exportNodeToExcelCommand(
    connectionManager: ConnectionManager,
    node: OpcuaNode
): Promise<void> {
    try {
        // 显示保存对话框
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${node.displayName}.xlsx`),
            filters: {
                'Excel Files': ['xlsx'],
                'All Files': ['*']
            }
        });

        if (!uri) {
            return;
        }

        // 询问是否递归导出
        const recursive = await vscode.window.showQuickPick(
            [
                { label: 'Export node only', value: false },
                { label: 'Export node and all children (recursive)', value: true }
            ],
            { placeHolder: 'Select export mode' }
        );

        if (!recursive) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Exporting node to Excel...',
                cancellable: false
            },
            async (progress) => {
                const client = connectionManager.getConnection(node.connectionId);
                if (!client || !client.isConnected) {
                    throw new Error('Not connected to OPC UA server');
                }

                if (recursive.value) {
                    // 递归导出
                    progress.report({ message: 'Recursively browsing nodes...' });
                    const treeData = await client.recursiveBrowse(node.nodeId, 10);

                    // 收集所有节点
                    const allNodes: OpcuaNodeInfo[] = [];

                    function collectNodes(data: any): void {
                        if (data.nodeId) {
                            allNodes.push(data);
                        }
                        if (data.children && Array.isArray(data.children)) {
                            data.children.forEach((child: any) => collectNodes(child));
                        }
                    }

                    collectNodes(treeData);

                    // 导出到 Excel
                    progress.report({ message: 'Writing to Excel file...' });
                    const rootNode = allNodes.shift()!;
                    await exportNodeTreeToExcel(rootNode, allNodes, uri.fsPath);
                } else {
                    // 仅导出当前节点
                    progress.report({ message: 'Reading node attributes...' });
                    const nodeInfo = await client.readNodeAttributes(node.nodeId);

                    // 导出到 Excel
                    progress.report({ message: 'Writing to Excel file...' });
                    await exportNodeToExcel(nodeInfo, uri.fsPath);
                }

                vscode.window.showInformationMessage(
                    `Node exported successfully to ${uri.fsPath}`
                );

                // 询问是否打开文件
                const openFile = await vscode.window.showInformationMessage(
                    'Export complete. Would you like to open the file?',
                    'Open',
                    'Cancel'
                );

                if (openFile === 'Open') {
                    await vscode.env.openExternal(uri);
                }
            }
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export node to Excel: ${error}`);
    }
}
