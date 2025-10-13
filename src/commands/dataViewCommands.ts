import * as vscode from 'vscode';
import { NodeClass } from 'node-opcua';
import { ConnectionManager } from '../opcua/connectionManager';
import { DataViewManager } from '../providers/dataViewManager';
import { OpcuaNode } from '../providers/opcuaTreeDataProvider';
import { VariableNodeCollectionResult } from '../opcua/opcuaClient';

interface DataViewAdditionResult {
    total: number;
    added: number;
    skipped: number;
    failed: number;
    truncated?: boolean;
}

const MAX_VARIABLE_NODES = 500;

export async function addNodeToDataViewCommand(
    connectionManager: ConnectionManager,
    dataViewManager: DataViewManager,
    node?: OpcuaNode
): Promise<DataViewAdditionResult | undefined> {
    if (!(node instanceof OpcuaNode)) {
        vscode.window.showWarningMessage('Please select a node to add to Data View.');
        return undefined;
    }

    const client = connectionManager.getConnection(node.connectionId);
    if (!client || !client.isConnected) {
        vscode.window.showErrorMessage('Connection is not active. Please connect before adding nodes to Data View.');
        return undefined;
    }

    if (node.nodeClass === NodeClass.Object) {
        return await handleObjectNodeAddition(node, client, dataViewManager);
    }

    return await addSingleNode(node, dataViewManager);
}

async function handleObjectNodeAddition(
    node: OpcuaNode,
    client: NonNullable<ReturnType<ConnectionManager['getConnection']>>,
    dataViewManager: DataViewManager
): Promise<DataViewAdditionResult | undefined> {
    const addAllOption = '加入全部子节点';
    const onlySelfOption = '仅加入当前节点';

    const nodeLabel = node.displayName || node.label || node.nodeId;

    const choice = await vscode.window.showInformationMessage(
        `节点 "${nodeLabel}" 是对象。是否将其下所有点位加入 Data View？`,
        { modal: true },
        addAllOption,
        onlySelfOption
    );

    if (!choice) {
        return undefined;
    }

    if (choice === onlySelfOption) {
        return await addSingleNode(node, dataViewManager);
    }

    try {
        const result = await vscode.window.withProgress<DataViewAdditionResult | undefined>(
            {
                location: vscode.ProgressLocation.Notification,
                title: `正在添加 "${nodeLabel}" 的子节点到 Data View...`,
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: '正在搜索子节点...' });
                const collected = await client.collectVariableDescendantNodes(node.nodeId, {
                    maxNodes: MAX_VARIABLE_NODES
                });

                if (collected.nodes.length === 0) {
                    vscode.window.showInformationMessage('未找到可监控的子节点。');
                    return undefined;
                }

                progress.report({ message: `发现 ${collected.nodes.length} 个节点，正在添加...` });
                return await addMultipleNodes(
                    node.connectionId,
                    collected,
                    dataViewManager,
                    progress
                );
            }
        );

        if (!result) {
            return undefined;
        }

        showAdditionSummary(result);
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`添加对象子节点到 Data View 失败：${message}`);
        return undefined;
    }
}

async function addMultipleNodes(
    connectionId: string,
    collected: VariableNodeCollectionResult,
    dataViewManager: DataViewManager,
    progress: vscode.Progress<{ message?: string; increment?: number; }>
): Promise<DataViewAdditionResult> {
    let added = 0;
    let skipped = 0;
    let failed = 0;
    const total = collected.nodes.length;

    for (let index = 0; index < collected.nodes.length; index++) {
        const nodeInfo = collected.nodes[index];
        progress.report({
            message: `正在添加 ${index + 1}/${total}：${nodeInfo.displayName || nodeInfo.nodeId}`
        });

        const alreadyTracked = dataViewManager.hasNode(connectionId, nodeInfo.nodeId);

        try {
            await dataViewManager.addNode(connectionId, nodeInfo.nodeId);
            if (alreadyTracked) {
                skipped += 1;
            } else {
                added += 1;
            }
        } catch (error) {
            failed += 1;
            console.error(`Failed to add node ${nodeInfo.nodeId} to Data View:`, error);
        }
    }

    if (collected.truncated) {
        vscode.window.showWarningMessage(
            `已达到 ${MAX_VARIABLE_NODES} 个节点的上限，部分子节点未被添加。`
        );
    }

    if (failed > 0) {
        vscode.window.showWarningMessage(`有 ${failed} 个节点添加失败，请查看输出日志。`);
    }

    return {
        total,
        added,
        skipped,
        failed,
        truncated: collected.truncated
    };
}

async function addSingleNode(
    node: OpcuaNode,
    dataViewManager: DataViewManager
): Promise<DataViewAdditionResult | undefined> {
    try {
        const alreadyTracked = dataViewManager.hasNode(node.connectionId, node.nodeId);
        const entry = await dataViewManager.addNode(node.connectionId, node.nodeId);

        if (!alreadyTracked) {
            const name = entry.displayName || entry.nodeId;
            vscode.window.showInformationMessage(`已添加 "${name}" 到 Data View。`);
            return {
                total: 1,
                added: 1,
                skipped: 0,
                failed: 0
            };
        }

        vscode.window.showInformationMessage('该节点已在 Data View 中。');
        return {
            total: 1,
            added: 0,
            skipped: 1,
            failed: 0
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to add node to Data View: ${message}`);
        return undefined;
    }
}

function showAdditionSummary(result: DataViewAdditionResult): void {
    if (result.total === 1) {
        if (result.added === 1) {
            vscode.window.showInformationMessage('已添加 1 个节点到 Data View。');
        } else if (result.skipped === 1) {
            vscode.window.showInformationMessage('该节点已在 Data View 中。');
        }
        return;
    }

    if (result.total <= 0) {
        return;
    }

    const parts: string[] = [];

    if (result.added > 0) {
        parts.push(`新增 ${result.added}`);
    }
    if (result.skipped > 0) {
        parts.push(`已存在 ${result.skipped}`);
    }
    if (result.failed > 0) {
        parts.push(`失败 ${result.failed}`);
    }

    const summary = parts.length > 0 ? parts.join('，') : '未添加任何节点';
    vscode.window.showInformationMessage(`共处理 ${result.total} 个节点：${summary}。`);
}

export async function removeNodeFromDataViewCommand(
    dataViewManager: DataViewManager,
    entryId: string
): Promise<void> {
    await dataViewManager.removeNode(entryId);
}

export async function clearDataViewCommand(
    dataViewManager: DataViewManager
): Promise<void> {
    await dataViewManager.clear();
}
