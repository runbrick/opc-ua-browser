import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaNodeInfo, OpcuaReference } from '../types';
import { formatDataType } from '../utils/dataTypeMapper';

export class NodeDetailPanel {
    private static currentPanel: NodeDetailPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private currentConnectionId: string | undefined;
    private currentNodeId: string | undefined;
    private isRefreshing = false;

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
                    case 'requestNodeData':
                        await this.handleNodeDataRequest();
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
        this.currentConnectionId = connectionId;
        this.currentNodeId = nodeId;
        this.isRefreshing = false;

        try {
            const client = this.connectionManager.getConnection(connectionId);
            if (!client || !client.isConnected) {
                this.panel.webview.html = this.getErrorHtml('Not connected to OPC UA server');
                return;
            }

            const nodeInfo = await client.readNodeAttributes(nodeId);
            const references = await client.getReferences(nodeId);
            const enrichedNodeInfo = this.enrichNodeInfo(nodeInfo);

            this.panel.webview.html = this.getHtml(enrichedNodeInfo, references);
        } catch (error) {
            this.panel.webview.html = this.getErrorHtml(`Error loading node details: ${error}`);
        }
    }

    private async handleNodeDataRequest(): Promise<void> {
        if (this.isRefreshing) {
            return;
        }

        if (!this.currentConnectionId || !this.currentNodeId) {
            return;
        }

        const client = this.connectionManager.getConnection(this.currentConnectionId);
        if (!client || !client.isConnected) {
            await this.panel.webview.postMessage({
                command: 'nodeDataError',
                message: 'Not connected to OPC UA server'
            });
            return;
        }

        this.isRefreshing = true;

        try {
            const nodeInfo = await client.readNodeAttributes(this.currentNodeId);
            const enrichedNodeInfo = this.enrichNodeInfo(nodeInfo);
            await this.panel.webview.postMessage({
                command: 'nodeData',
                data: enrichedNodeInfo
            });
        } catch (error) {
            await this.panel.webview.postMessage({
                command: 'nodeDataError',
                message: error instanceof Error ? error.message : String(error)
            });
        } finally {
            this.isRefreshing = false;
        }
    }

    private enrichNodeInfo(
        nodeInfo: OpcuaNodeInfo
    ): OpcuaNodeInfo & { formattedDataType?: string } {
        const formattedDataType = nodeInfo.dataType
            ? formatDataType(nodeInfo.dataType)
            : undefined;

        return {
            ...nodeInfo,
            formattedDataType
        };
    }

    private getHtml(
        nodeInfo: OpcuaNodeInfo & { formattedDataType?: string },
        references: OpcuaReference[]
    ): string {
        const nonce = this.getNonce();
        const nodeInfoJson = this.serializeForWebview(nodeInfo);
        const referencesJson = this.serializeForWebview(references);

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
            word-break: break-word;
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

        .status-message {
            margin: 0 0 10px 0;
            display: none;
            color: var(--vscode-errorForeground);
        }

        .status-message.info {
            color: var(--vscode-descriptionForeground);
        }

        .meta-text {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <h1 id="node-title"></h1>

    <div class="section">
        <h2>Attributes</h2>
        <div id="status-message" class="status-message"></div>
        <table>
            <tr>
                <th>Attribute</th>
                <th>Value</th>
            </tr>
            <tr>
                <td>Node ID</td>
                <td id="attr-nodeId" class="value-cell"></td>
            </tr>
            <tr>
                <td>Browse Name</td>
                <td id="attr-browseName" class="value-cell"></td>
            </tr>
            <tr>
                <td>Display Name</td>
                <td id="attr-displayName" class="value-cell"></td>
            </tr>
            <tr>
                <td>Node Class</td>
                <td><span id="attr-nodeClass" class="node-class-badge"></span></td>
            </tr>
            <tr id="row-description">
                <td>Description</td>
                <td id="attr-description" class="value-cell"></td>
            </tr>
            <tr id="row-value">
                <td>Value</td>
                <td id="attr-value" class="value-cell"></td>
            </tr>
            <tr id="row-statusCode">
                <td>Status Code</td>
                <td id="attr-statusCode" class="value-cell"></td>
            </tr>
            <tr id="row-sourceTimestamp">
                <td>Source Timestamp</td>
                <td id="attr-sourceTimestamp" class="value-cell"></td>
            </tr>
            <tr id="row-serverTimestamp">
                <td>Server Timestamp</td>
                <td id="attr-serverTimestamp" class="value-cell"></td>
            </tr>
            <tr id="row-dataType">
                <td>Data Type</td>
                <td id="attr-dataType" class="value-cell"></td>
            </tr>
            <tr id="row-accessLevel">
                <td>Access Level</td>
                <td id="attr-accessLevel" class="value-cell"></td>
            </tr>
            <tr id="row-userAccessLevel">
                <td>User Access Level</td>
                <td id="attr-userAccessLevel" class="value-cell"></td>
            </tr>
        </table>
    </div>

    <div class="section">
        <h2>References <span id="references-count"></span></h2>
        <div id="references-container"></div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const REFRESH_INTERVAL = 1000;
        const initialNodeInfo = ${nodeInfoJson};
        const initialReferences = ${referencesJson};
        let refreshTimer;

        const statusMessageEl = document.getElementById('status-message');

        function escapeHtml(text) {
            if (text === null || text === undefined) {
                return '';
            }
            if (typeof text !== 'string') {
                text = String(text);
            }
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function formatValue(value) {
            if (value === null || value === undefined) {
                return '<em>null</em>';
            }
            if (typeof value === 'object') {
                try {
                    return '<pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
                } catch (error) {
                    return '<pre>' + escapeHtml(String(value)) + '</pre>';
                }
            }
            return escapeHtml(String(value));
        }

        function setText(id, text) {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = text ?? '';
            }
        }

        function setHtml(id, html) {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = html ?? '';
            }
        }

        function toggleRow(id, show) {
            const row = document.getElementById(id);
            if (row) {
                row.style.display = show ? 'table-row' : 'none';
            }
        }

        function showStatusMessage(message, type = 'error') {
            if (!statusMessageEl) {
                return;
            }

            if (!message) {
                statusMessageEl.textContent = '';
                statusMessageEl.className = 'status-message';
                statusMessageEl.style.display = 'none';
                return;
            }

            statusMessageEl.textContent = message;
            statusMessageEl.className = 'status-message ' + type;
            statusMessageEl.style.display = 'block';
        }

        function renderNodeDetails(info) {
            if (!info) {
                return;
            }

            setText('node-title', info.displayName || info.browseName || info.nodeId || 'Node Details');
            setText('attr-nodeId', info.nodeId || '');
            setText('attr-browseName', info.browseName || '');
            setText('attr-displayName', info.displayName || '');

            const nodeClassEl = document.getElementById('attr-nodeClass');
            if (nodeClassEl) {
                nodeClassEl.textContent = info.nodeClass || '';
            }

            if (info.description) {
                toggleRow('row-description', true);
                setHtml('attr-description', escapeHtml(info.description));
            } else {
                toggleRow('row-description', false);
                setHtml('attr-description', '');
            }

            if (info.value !== undefined) {
                toggleRow('row-value', true);
                setHtml('attr-value', formatValue(info.value));
            } else {
                toggleRow('row-value', false);
                setHtml('attr-value', '');
            }

            if (info.statusCode) {
                toggleRow('row-statusCode', true);
                setText('attr-statusCode', info.statusCode);
            } else {
                toggleRow('row-statusCode', false);
                setText('attr-statusCode', '');
            }

            if (info.sourceTimestamp) {
                toggleRow('row-sourceTimestamp', true);
                setText('attr-sourceTimestamp', info.sourceTimestamp);
            } else {
                toggleRow('row-sourceTimestamp', false);
                setText('attr-sourceTimestamp', '');
            }

            if (info.serverTimestamp) {
                toggleRow('row-serverTimestamp', true);
                setText('attr-serverTimestamp', info.serverTimestamp);
            } else {
                toggleRow('row-serverTimestamp', false);
                setText('attr-serverTimestamp', '');
            }

            if (info.dataType) {
                toggleRow('row-dataType', true);
                const formatted = info.formattedDataType || info.dataType;
                let html = '<strong>' + escapeHtml(formatted) + '</strong>';
                if (info.formattedDataType && info.dataType && info.formattedDataType !== info.dataType) {
                    html += '<br><span class="meta-text">NodeId: ' + escapeHtml(info.dataType) + '</span>';
                }
                setHtml('attr-dataType', html);
            } else {
                toggleRow('row-dataType', false);
                setHtml('attr-dataType', '');
            }

            if (info.accessLevel !== undefined) {
                toggleRow('row-accessLevel', true);
                setText('attr-accessLevel', String(info.accessLevel));
            } else {
                toggleRow('row-accessLevel', false);
                setText('attr-accessLevel', '');
            }

            if (info.userAccessLevel !== undefined) {
                toggleRow('row-userAccessLevel', true);
                setText('attr-userAccessLevel', String(info.userAccessLevel));
            } else {
                toggleRow('row-userAccessLevel', false);
                setText('attr-userAccessLevel', '');
            }
        }

        function renderReferences(refs) {
            const container = document.getElementById('references-container');
            const countEl = document.getElementById('references-count');
            const entries = Array.isArray(refs) ? refs : [];

            if (countEl) {
                countEl.textContent = '(' + entries.length + ')';
            }

            if (!container) {
                return;
            }

            if (!entries.length) {
                container.innerHTML = '<p class="empty-message">No references found.</p>';
                return;
            }

            const rows = entries
                .map((ref) => [
                    '<tr>',
                    '<td class="value-cell">' + escapeHtml(ref.referenceTypeId || '') + '</td>',
                    '<td>' + (ref.isForward ? 'Forward' : 'Inverse') + '</td>',
                    '<td class="value-cell">' + escapeHtml(ref.nodeId || '') + '</td>',
                    '<td class="value-cell">' + escapeHtml(ref.browseName || '') + '</td>',
                    '<td class="value-cell">' + escapeHtml(ref.displayName || '') + '</td>',
                    '<td><span class="node-class-badge">' + escapeHtml(ref.nodeClass || '') + '</span></td>',
                    '</tr>'
                ].join(''))
                .join('');

            container.innerHTML =
                '<table>' +
                '<tr>' +
                '<th>Reference Type</th>' +
                '<th>Direction</th>' +
                '<th>Node ID</th>' +
                '<th>Browse Name</th>' +
                '<th>Display Name</th>' +
                '<th>Node Class</th>' +
                '</tr>' +
                rows +
                '</table>';
        }

        renderNodeDetails(initialNodeInfo);
        renderReferences(initialReferences);
        showStatusMessage('');
        vscode.postMessage({ command: 'requestNodeData' });

        refreshTimer = setInterval(() => {
            vscode.postMessage({ command: 'requestNodeData' });
        }, REFRESH_INTERVAL);

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) {
                return;
            }

            switch (message.command) {
                case 'nodeData':
                    renderNodeDetails(message.data);
                    showStatusMessage('');
                    break;
                case 'nodeDataError':
                    showStatusMessage(message.message || 'Failed to refresh node data');
                    break;
            }
        });

        window.addEventListener('unload', () => {
            if (refreshTimer) {
                clearInterval(refreshTimer);
            }
        });
    </script>
</body>
</html>`;
    }

    private serializeForWebview(data: unknown): string {
        return JSON.stringify(
            data,
            (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
        )
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
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
