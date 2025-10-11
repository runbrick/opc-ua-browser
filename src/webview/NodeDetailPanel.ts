import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaNodeInfo, OpcuaReference } from '../types';
import { formatDataType } from '../utils/dataTypeMapper';

export class NodeDetailPanel {
    private static currentPanel: NodeDetailPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly connectionManager: ConnectionManager
    ) {
        this.panel = panel;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        // Handle refresh if needed
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static async show(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        connectionId: string,
        nodeId: string
    ): Promise<void> {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (NodeDetailPanel.currentPanel) {
            NodeDetailPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'opcuaNodeDetails',
                'OPC UA Node Details',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
                }
            );

            NodeDetailPanel.currentPanel = new NodeDetailPanel(
                panel,
                extensionUri,
                connectionManager
            );
        }

        await NodeDetailPanel.currentPanel.update(connectionId, nodeId);
    }

    private async update(connectionId: string, nodeId: string): Promise<void> {
        this.panel.title = 'OPC UA Node Details';

        try {
            const client = this.connectionManager.getConnection(connectionId);
            if (!client || !client.isConnected) {
                this.panel.webview.html = this.getErrorHtml('Not connected to OPC UA server');
                return;
            }

            // 获取节点属性
            const nodeInfo = await client.readNodeAttributes(nodeId);

            // 获取节点引用
            const references = await client.getReferences(nodeId);

            this.panel.webview.html = this.getHtml(nodeInfo, references);
        } catch (error) {
            this.panel.webview.html = this.getErrorHtml(`Error loading node details: ${error}`);
        }
    }

    private getHtml(nodeInfo: OpcuaNodeInfo, references: OpcuaReference[]): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <title>Node Details</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }

        h1 {
            font-size: 1.5em;
            margin-bottom: 10px;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 10px;
        }

        h2 {
            font-size: 1.2em;
            margin-top: 30px;
            margin-bottom: 15px;
            color: var(--vscode-foreground);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
            background-color: var(--vscode-editor-background);
        }

        th, td {
            padding: 10px;
            text-align: left;
            border: 1px solid var(--vscode-widget-border);
        }

        th {
            background-color: var(--vscode-editor-selectionBackground);
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        tr:nth-child(even) {
            background-color: var(--vscode-list-hoverBackground);
        }

        .value-cell {
            font-family: var(--vscode-editor-font-family);
            word-break: break-all;
        }

        .section {
            margin-bottom: 30px;
        }

        .node-class-badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 0.85em;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .empty-message {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 10px;
        }
    </style>
</head>
<body>
    <h1>${this.escapeHtml(nodeInfo.displayName || nodeInfo.browseName)}</h1>

    <div class="section">
        <h2>Attributes</h2>
        <table>
            <tr>
                <th>Attribute</th>
                <th>Value</th>
            </tr>
            <tr>
                <td>Node ID</td>
                <td class="value-cell">${this.escapeHtml(nodeInfo.nodeId)}</td>
            </tr>
            <tr>
                <td>Browse Name</td>
                <td class="value-cell">${this.escapeHtml(nodeInfo.browseName)}</td>
            </tr>
            <tr>
                <td>Display Name</td>
                <td class="value-cell">${this.escapeHtml(nodeInfo.displayName)}</td>
            </tr>
            <tr>
                <td>Node Class</td>
                <td><span class="node-class-badge">${this.escapeHtml(nodeInfo.nodeClass)}</span></td>
            </tr>
            ${nodeInfo.description ? `
            <tr>
                <td>Description</td>
                <td class="value-cell">${this.escapeHtml(nodeInfo.description)}</td>
            </tr>
            ` : ''}
            ${nodeInfo.value !== undefined ? `
            <tr>
                <td>Value</td>
                <td class="value-cell">${this.formatValue(nodeInfo.value)}</td>
            </tr>
            ` : ''}
            ${nodeInfo.dataType ? `
            <tr>
                <td>Data Type</td>
                <td class="value-cell">
                    <strong>${this.escapeHtml(formatDataType(nodeInfo.dataType))}</strong>
                    ${nodeInfo.dataType !== formatDataType(nodeInfo.dataType) ?
                        `<br><span style="color: var(--vscode-descriptionForeground); font-size: 0.9em;">NodeId: ${this.escapeHtml(nodeInfo.dataType)}</span>` :
                        ''}
                </td>
            </tr>
            ` : ''}
            ${nodeInfo.accessLevel !== undefined ? `
            <tr>
                <td>Access Level</td>
                <td class="value-cell">${nodeInfo.accessLevel}</td>
            </tr>
            ` : ''}
            ${nodeInfo.userAccessLevel !== undefined ? `
            <tr>
                <td>User Access Level</td>
                <td class="value-cell">${nodeInfo.userAccessLevel}</td>
            </tr>
            ` : ''}
        </table>
    </div>

    <div class="section">
        <h2>References (${references.length})</h2>
        ${references.length > 0 ? `
        <table>
            <tr>
                <th>Reference Type</th>
                <th>Direction</th>
                <th>Node ID</th>
                <th>Browse Name</th>
                <th>Display Name</th>
                <th>Node Class</th>
            </tr>
            ${references.map(ref => `
            <tr>
                <td class="value-cell">${this.escapeHtml(ref.referenceTypeId)}</td>
                <td>${ref.isForward ? 'Forward' : 'Inverse'}</td>
                <td class="value-cell">${this.escapeHtml(ref.nodeId)}</td>
                <td class="value-cell">${this.escapeHtml(ref.browseName)}</td>
                <td class="value-cell">${this.escapeHtml(ref.displayName)}</td>
                <td><span class="node-class-badge">${this.escapeHtml(ref.nodeClass)}</span></td>
            </tr>
            `).join('')}
        </table>
        ` : '<p class="empty-message">No references found.</p>'}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Add any interactive functionality here
    </script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
    <title>Error</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }

        .error-container {
            text-align: center;
            color: var(--vscode-errorForeground);
        }

        .error-icon {
            font-size: 48px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-icon">⚠️</div>
        <p>${this.escapeHtml(message)}</p>
    </div>
</body>
</html>`;
    }

    private formatValue(value: any): string {
        if (value === null || value === undefined) {
            return '<em>null</em>';
        }

        if (typeof value === 'object') {
            return `<pre>${this.escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
        }

        return this.escapeHtml(String(value));
    }

    private escapeHtml(text: string): string {
        const div = { textContent: text } as any;
        const textNode = { data: text };
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        NodeDetailPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
