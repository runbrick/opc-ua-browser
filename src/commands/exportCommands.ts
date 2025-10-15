import * as vscode from "vscode";
import { ConnectionManager } from "../opcua/connectionManager";
import { OpcuaNode } from "../providers/opcuaTreeDataProvider";
import { exportVariableRowsToExcel, VariableNodeExportRow } from "../utils/excelExporter";
import { formatDataType } from "../utils/dataTypeMapper";

const CANCELLED_ERROR_MESSAGE = "Operation cancelled";
const PROGRESS_UPDATE_INTERVAL_MS = 300;
const VARIABLE_NODE_CLASS = "variable";
const NO_VARIABLE_NODES_MESSAGE = "No Variable nodes found to export.";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message === CANCELLED_ERROR_MESSAGE;
}

function normalizeDataType(dataType?: string): string {
    if (!dataType) {
        return "";
    }
    const formatted = formatDataType(dataType);
    return formatted || dataType;
}

function isVariableNodeLike(node: { nodeClass?: string | null }): boolean {
    if (!node || typeof node.nodeClass !== "string") {
        return false;
    }
    return node.nodeClass.toLowerCase() === VARIABLE_NODE_CLASS;
}

function toVariableExportRow(node: { nodeId?: string; displayName?: string; browseName?: string; dataType?: string }): VariableNodeExportRow {
    return {
        NodeId: node.nodeId ?? "",
        DisplayName: node.displayName ?? "",
        BrowseName: node.browseName ?? "",
        DataType: normalizeDataType(node.dataType)
    };
}

function collectVariableRows(entry: any, rows: VariableNodeExportRow[]): void {
    if (!entry) {
        return;
    }

    if (isVariableNodeLike(entry) && typeof entry.nodeId === "string" && entry.nodeId.length > 0) {
        rows.push(toVariableExportRow(entry));
    }

    if (Array.isArray(entry.children)) {
        for (const child of entry.children) {
            collectVariableRows(child, rows);
        }
    }
}

export async function exportNodeCommand(
    connectionManager: ConnectionManager,
    node: OpcuaNode
): Promise<void> {
    try {
        const label = node.displayName || node.label || node.nodeId;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${label}.json`),
            filters: {
                "JSON Files": ["json"],
                "All Files": ["*"]
            }
        });

        if (!uri) {
            return;
        }

        const recursive = await vscode.window.showQuickPick(
            [
                { label: "Export node only", value: false },
                { label: "Export node and all children (recursive)", value: true }
            ],
            { placeHolder: "Select export mode" }
        );

        if (!recursive) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Exporting "${label}" to JSON...`,
                cancellable: true
            },
            async (progress, token) => {
                const client = connectionManager.getConnection(node.connectionId);
                if (!client || !client.isConnected) {
                    throw new Error("Not connected to OPC UA server");
                }

                token.onCancellationRequested(() => {
                    progress.report({ message: "Cancelling export..." });
                });

                let exportRows: VariableNodeExportRow[] = [];
                if (recursive.value) {
                    progress.report({ message: "Collecting node tree..." });
                    let lastReported = 0;
                    const treeData = await client.recursiveBrowse(node.nodeId, {
                        maxDepth: 10,
                        concurrency: 6,
                        cancellationToken: token,
                        progress: ({ processed }) => {
                            const now = Date.now();
                            if (processed === 1 || now - lastReported >= PROGRESS_UPDATE_INTERVAL_MS) {
                                progress.report({ message: `Collected ${processed} nodes...` });
                                lastReported = now;
                            }
                        }
                    });

                    if (!treeData) {
                        throw new Error("Unable to collect node data for export.");
                    }

                    const rows: VariableNodeExportRow[] = [];
                    collectVariableRows(treeData, rows);
                    exportRows = rows;
                } else {
                    progress.report({ message: "Reading node attributes..." });
                    const nodeInfo = await client.readNodeAttributes(node.nodeId);
                    if (isVariableNodeLike(nodeInfo)) {
                        exportRows = [toVariableExportRow(nodeInfo)];
                    }
                }

                if (token.isCancellationRequested) {
                    throw new Error(CANCELLED_ERROR_MESSAGE);
                }

                if (exportRows.length === 0) {
                    throw new Error(NO_VARIABLE_NODES_MESSAGE);
                }

                progress.report({ message: "Writing JSON file..." });
                const content = JSON.stringify(exportRows, null, 2);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));

                progress.report({ message: "Export complete." });
                await delay(700);
            }
        );

        vscode.window.setStatusBarMessage(`$(check) JSON export saved: ${uri.fsPath}`, 5000);
        vscode.window.showInformationMessage("Node export completed", {
            detail: uri.fsPath
        });
    } catch (error) {
        if (isCancellationError(error)) {
            vscode.window.setStatusBarMessage("Node export cancelled.", 3000);
            return;
        }

        if (error instanceof Error && error.message === NO_VARIABLE_NODES_MESSAGE) {
            vscode.window.showWarningMessage("No Variable nodes found for the selected scope.");
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to export node: ${message}`);
    }
}

export async function exportNodeToExcelCommand(
    connectionManager: ConnectionManager,
    node: OpcuaNode
): Promise<void> {
    try {
        const label = node.displayName || node.label || node.nodeId;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${label}.xlsx`),
            filters: {
                "Excel Files": ["xlsx"],
                "All Files": ["*"]
            }
        });

        if (!uri) {
            return;
        }

        const recursive = await vscode.window.showQuickPick(
            [
                { label: "Export node only", value: false },
                { label: "Export node and all children (recursive)", value: true }
            ],
            { placeHolder: "Select export mode" }
        );

        if (!recursive) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Exporting "${label}" to Excel...`,
                cancellable: true
            },
            async (progress, token) => {
                const client = connectionManager.getConnection(node.connectionId);
                if (!client || !client.isConnected) {
                    throw new Error("Not connected to OPC UA server");
                }

                token.onCancellationRequested(() => {
                    progress.report({ message: "Cancelling export..." });
                });

                let exportRows: VariableNodeExportRow[] = [];
                let summaryRootLabel: string | undefined = label;
                let summaryRootNodeId: string | undefined = node.nodeId;

                if (recursive.value) {
                    progress.report({ message: "Collecting node tree..." });
                    let lastReported = 0;
                    const treeData = await client.recursiveBrowse(node.nodeId, {
                        maxDepth: 10,
                        concurrency: 6,
                        cancellationToken: token,
                        progress: ({ processed }) => {
                            const now = Date.now();
                            if (processed === 1 || now - lastReported >= PROGRESS_UPDATE_INTERVAL_MS) {
                                progress.report({ message: `Collected ${processed} nodes...` });
                                lastReported = now;
                            }
                        }
                    });

                    if (!treeData) {
                        throw new Error("Unable to collect node data for export.");
                    }

                    const rows: VariableNodeExportRow[] = [];
                    collectVariableRows(treeData, rows);
                    exportRows = rows;
                    summaryRootLabel = treeData.displayName || treeData.browseName || treeData.nodeId || label;
                    summaryRootNodeId = treeData.nodeId ?? summaryRootNodeId;
                } else {
                    progress.report({ message: "Reading node attributes..." });
                    const nodeInfo = await client.readNodeAttributes(node.nodeId);
                    if (isVariableNodeLike(nodeInfo)) {
                        exportRows = [toVariableExportRow(nodeInfo)];
                    }
                    summaryRootLabel = nodeInfo.displayName || nodeInfo.browseName || nodeInfo.nodeId || label;
                    summaryRootNodeId = nodeInfo.nodeId ?? summaryRootNodeId;
                }

                if (token.isCancellationRequested) {
                    throw new Error(CANCELLED_ERROR_MESSAGE);
                }

                if (exportRows.length === 0) {
                    throw new Error(NO_VARIABLE_NODES_MESSAGE);
                }

                progress.report({ message: "Writing Excel file..." });
                const summaryRows: Array<{ Property: string; Value: string | number | undefined }> = [
                    { Property: "Total Variable Nodes", Value: exportRows.length },
                    ...(summaryRootLabel ? [{ Property: "Root Node", Value: summaryRootLabel }] : []),
                    ...(summaryRootNodeId ? [{ Property: "Root NodeId", Value: summaryRootNodeId }] : []),
                    { Property: "Export Date", Value: new Date().toISOString() }
                ];

                await exportVariableRowsToExcel(exportRows, uri.fsPath, {
                    sheetName: summaryRootLabel ?? "Variable Nodes",
                    summary: summaryRows
                });

                progress.report({ message: "Export complete." });
                await delay(700);
            }
        );

        vscode.window.setStatusBarMessage(`$(check) Excel export saved: ${uri.fsPath}`, 5000);
        vscode.window.showInformationMessage("Node export to Excel completed", {
            detail: uri.fsPath
        });
    } catch (error) {
        if (isCancellationError(error)) {
            vscode.window.setStatusBarMessage("Excel export cancelled.", 3000);
            return;
        }

        if (error instanceof Error && error.message === NO_VARIABLE_NODES_MESSAGE) {
            vscode.window.showWarningMessage("No Variable nodes found for the selected scope.");
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to export node to Excel: ${message}`);
    }
}
