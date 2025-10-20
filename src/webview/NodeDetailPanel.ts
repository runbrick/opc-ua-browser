import * as vscode from 'vscode';
import { accessLevelFlagToString, type AccessLevelFlag } from 'node-opcua-data-model';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaNodeInfo, OpcuaReference, OpcuaNodePathSegment } from '../types';
import type { VariableNodeCollectionResult } from '../opcua/opcuaClient';
import { formatDataType } from '../utils/dataTypeMapper';
import { exportVariableRowsToExcel, type VariableNodeExportRow } from '../utils/excelExporter';

type HierarchySegment = OpcuaNodePathSegment & {
    isRoot?: boolean;
    isCurrent?: boolean;
};

export class NodeDetailPanel {
    private static currentPanel: NodeDetailPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private currentConnectionId: string | undefined;
    private currentNodeId: string | undefined;
    private isRefreshing = false;
    private currentNodeLabel: string | undefined;
    private currentHierarchySegments: HierarchySegment[] = [];

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
                    case 'openVariableNode':
                        if (typeof message.nodeId === 'string') {
                            await this.handleOpenVariableNode(message.nodeId);
                        }
                        break;
                    case 'exportVariableNodes':
                        await this.handleExportVariableNodes(message);
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
        this.currentHierarchySegments = [];

        try {
            const client = this.connectionManager.getConnection(connectionId);
            if (!client || !client.isConnected) {
                this.panel.webview.html = this.getErrorHtml('Not connected to OPC UA server');
                return;
            }

            const nodeInfo = await client.readNodeAttributes(nodeId);
            const references = await client.getReferences(nodeId);
            let variableDescendants: VariableNodeCollectionResult | undefined;
            let hierarchySegments: HierarchySegment[] = [];

            if (nodeInfo.nodeClass === 'Object') {
                try {
                    variableDescendants = await client.collectVariableDescendantNodes(nodeId, {
                        maxNodes: Number.MAX_SAFE_INTEGER
                    });
                } catch (error) {
                    console.error('Failed to collect variable descendants:', error);
                    variableDescendants = {
                        nodes: [],
                        truncated: false
                    };
                }
            }

            const enrichedNodeInfo = this.enrichNodeInfo(nodeInfo);
            this.currentNodeLabel =
                nodeInfo.displayName || nodeInfo.browseName || nodeInfo.nodeId || this.currentNodeId;
            try {
                const pathInfo = await client.findNodePathByNodeId(nodeId, { maxDepth: 50 });
                const pathSegments = pathInfo?.pathSegments ?? [];
                hierarchySegments = this.buildHierarchySegments(pathSegments, enrichedNodeInfo);
            } catch (error) {
                console.error('Failed to resolve node hierarchy path:', error);
                hierarchySegments = this.buildHierarchySegments([], enrichedNodeInfo);
            }

            this.currentHierarchySegments = hierarchySegments;

            this.panel.webview.html = this.getHtml(
                enrichedNodeInfo,
                references,
                variableDescendants,
                hierarchySegments
            );
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

    private async handleOpenVariableNode(nodeId: string): Promise<void> {
        if (!this.currentConnectionId || !nodeId) {
            return;
        }

        if (this.currentNodeId === nodeId) {
            return;
        }

        try {
            await this.update(this.currentConnectionId, nodeId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to open variable node: ${message}`);
        }
    }

    private async handleExportVariableNodes(message: {
        nodes?: Array<{ nodeId?: string; displayName?: string; browseName?: string; dataType?: string }>;
        filterText?: string;
        totalCount?: number;
    }): Promise<void> {
        if (!this.currentConnectionId) {
            void vscode.window.showWarningMessage('Unable to export variables: no active connection.');
            return;
        }

        const rawNodes = Array.isArray(message?.nodes) ? message.nodes : [];
        if (!rawNodes.length) {
            void vscode.window.showInformationMessage('No variables available to export for this view.');
            return;
        }

        const rows: VariableNodeExportRow[] = rawNodes.map((node) => ({
            NodeId: typeof node.nodeId === 'string' ? node.nodeId : '',
            DisplayName: typeof node.displayName === 'string' ? node.displayName : '',
            BrowseName: typeof node.browseName === 'string' ? node.browseName : '',
            DataType: typeof node.dataType === 'string' ? formatDataType(node.dataType) || node.dataType : ''
        }));

        const exportLabel = this.currentNodeLabel || this.currentNodeId || 'variables';
        const defaultFilename = `${this.sanitizeFilenameComponent(exportLabel)}_variables.xlsx`;
        const defaultUri = vscode.Uri.file(defaultFilename);

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                'Excel Files': ['xlsx'],
                'All Files': ['*']
            }
        });

        if (!saveUri) {
            return;
        }

        const summaryRows = this.buildExportSummary(
            rows.length,
            typeof message.totalCount === 'number' ? message.totalCount : undefined,
            message.filterText
        );

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting ${rows.length} variable nodes to Excel...`
                },
                async (progress) => {
                    progress.report({ message: 'Writing Excel file...' });
                    await exportVariableRowsToExcel(rows, saveUri.fsPath, {
                        sheetName: exportLabel.substring(0, 31),
                        summary: summaryRows
                    });
                }
            );

            vscode.window.setStatusBarMessage(`$(check) Export saved: ${saveUri.fsPath}`, 5000);
            void vscode.window.showInformationMessage('Variable descendants exported to Excel.', {
                detail: saveUri.fsPath
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to export variable nodes: ${message}`);
        }
    }

    private sanitizeFilenameComponent(value: string): string {
        const sanitized = value.replace(/[\\/:*?"<>|]+/g, '_').trim();
        return sanitized.length > 0 ? sanitized : 'variables';
    }

    private buildExportSummary(
        exportedCount: number,
        totalCount?: number,
        filterText?: string
    ): Array<{ Property: string; Value: string | number | undefined }> {
        const summary: Array<{ Property: string; Value: string | number | undefined }> = [
            { Property: 'Exported Variable Nodes', Value: exportedCount }
        ];

        if (typeof totalCount === 'number') {
            summary.push({ Property: 'Total Available Nodes', Value: totalCount });
        }

        if (filterText && filterText.trim().length > 0) {
            summary.push({ Property: 'Filter Applied', Value: filterText.trim() });
        }

        if (this.currentNodeLabel) {
            summary.push({ Property: 'Parent Node', Value: this.currentNodeLabel });
        }
        if (this.currentNodeId) {
            summary.push({ Property: 'Parent NodeId', Value: this.currentNodeId });
        }

        const connectionConfig = this.currentConnectionId
            ? this.connectionManager.getConnectionConfig(this.currentConnectionId)
            : undefined;
        if (connectionConfig?.name) {
            summary.push({ Property: 'Connection', Value: connectionConfig.name });
        } else if (connectionConfig?.endpointUrl) {
            summary.push({ Property: 'Connection Endpoint', Value: connectionConfig.endpointUrl });
        }

        summary.push({ Property: 'Export Date', Value: new Date().toISOString() });

        return summary;
    }

    private buildHierarchySegments(
        segments: OpcuaNodePathSegment[],
        fallbackNode?: OpcuaNodeInfo
    ): HierarchySegment[] {
        if (!Array.isArray(segments) || segments.length === 0) {
            if (!fallbackNode) {
                return [];
            }

            const label =
                fallbackNode.displayName ||
                fallbackNode.browseName ||
                fallbackNode.nodeId;

            return [
                {
                    nodeId: fallbackNode.nodeId,
                    displayName: label,
                    browseName: fallbackNode.browseName,
                    nodeClass: fallbackNode.nodeClass,
                    isCurrent: true
                }
            ];
        }

        const decorated: HierarchySegment[] = [
            {
                nodeId: 'RootFolder',
                displayName: 'Root',
                browseName: 'RootFolder',
                nodeClass: 'Object',
                isRoot: true,
                isCurrent: false
            }
        ];

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            decorated.push({
                nodeId: segment.nodeId,
                displayName: segment.displayName || segment.browseName || segment.nodeId,
                browseName: segment.browseName,
                nodeClass: segment.nodeClass,
                isCurrent: i === segments.length - 1
            });
        }

        decorated[decorated.length - 1].isCurrent = true;

        return decorated;
    }

    private enrichNodeInfo(
        nodeInfo: OpcuaNodeInfo
    ): OpcuaNodeInfo & {
        formattedDataType?: string;
        formattedAccessLevel?: string;
        formattedUserAccessLevel?: string;
    } {
        const formattedDataType = nodeInfo.dataType
            ? formatDataType(nodeInfo.dataType)
            : undefined;
        const formattedAccessLevel = this.formatAccessLevel(nodeInfo.accessLevel);
        const formattedUserAccessLevel = this.formatAccessLevel(nodeInfo.userAccessLevel);

        return {
            ...nodeInfo,
            formattedDataType,
            formattedAccessLevel,
            formattedUserAccessLevel
        };
    }

    private formatAccessLevel(value: number | undefined): string | undefined {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return undefined;
        }

        const flagsText = accessLevelFlagToString(value as AccessLevelFlag);
        if (!flagsText || flagsText === 'None') {
            return `${value} (None)`;
        }

        return `${flagsText} (${value})`;
    }

    private getHtml(
        nodeInfo: OpcuaNodeInfo & { formattedDataType?: string },
        references: OpcuaReference[],
        variableDescendants: VariableNodeCollectionResult | undefined,
        hierarchySegments: HierarchySegment[]
    ): string {
        const nonce = this.getNonce();
        const nodeInfoJson = this.serializeForWebview(nodeInfo);
        const referencesJson = this.serializeForWebview(references);
        const variableDescendantsJson = variableDescendants
            ? this.serializeForWebview(variableDescendants)
            : 'null';
        const hierarchyJson = this.serializeForWebview(hierarchySegments);

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

        .section-toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            margin-bottom: 12px;
        }

        .section-toolbar .search-input {
            flex: 1 1 220px;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }

        .section-toolbar .button {
            padding: 6px 12px;
            border-radius: 4px;
            border: 1px solid var(--vscode-button-border, transparent);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }

        .section-toolbar .button:hover {
            background-color: var(--vscode-button-hoverBackground, var(--vscode-button-background));
        }

        .section-toolbar .button:disabled {
            opacity: 0.5;
            cursor: default;
        }

        .section-note {
            margin-bottom: 10px;
        }

        .hierarchy-breadcrumb {
            margin: 0 0 16px 0;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
            font-size: 0.95em;
            color: var(--vscode-descriptionForeground);
        }

        .hierarchy-segment {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }

        .hierarchy-link {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 0;
            font: inherit;
            text-decoration: underline;
        }

        .hierarchy-link:hover {
            color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
        }

        .hierarchy-current {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .hierarchy-divider {
            opacity: 0.6;
            font-size: 0.85em;
        }

        .hierarchy-empty {
            font-style: italic;
        }

        .tab-container {
            margin-top: 20px;
        }

        .tab-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 16px;
        }

        .tab-button {
            padding: 6px 12px;
            border-radius: 4px;
            border: 1px solid transparent;
            background-color: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-foreground, var(--vscode-foreground));
            cursor: pointer;
        }

        .tab-button.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-border, transparent);
        }

        .tab-button:hover:not(.active) {
            background-color: var(
                --vscode-button-hoverBackground,
                var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.08))
            );
        }

        .tab-button[hidden] {
            display: none;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .link-button {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 0;
            font: inherit;
            text-decoration: underline;
        }

        .link-button:hover {
            color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
        }
    </style>
</head>
<body>
    <h1 id="node-title"></h1>
    <nav id="node-hierarchy" class="hierarchy-breadcrumb" aria-label="Node hierarchy"></nav>

    <div class="tab-container">
        <div class="tab-buttons">
            <button
                class="tab-button active"
                type="button"
                id="attributes-tab-button"
                data-target="attributes-tab"
                aria-controls="attributes-tab"
            >
                Attributes
            </button>
            <button
                class="tab-button"
                type="button"
                id="references-tab-button"
                data-target="references-tab"
                aria-controls="references-tab"
            >
                References
            </button>
            <button
                class="tab-button"
                type="button"
                id="variables-tab-button"
                data-target="variables-tab"
                aria-controls="variables-tab"
                hidden
            >
                Variable Descendants
            </button>
        </div>

        <div id="attributes-tab" class="tab-content active" role="tabpanel" aria-labelledby="attributes-tab-button">
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
        </div>

        <div id="references-tab" class="tab-content" role="tabpanel" aria-labelledby="references-tab-button">
            <div class="section">
                <h2>References <span id="references-count"></span></h2>
                <div id="references-container"></div>
            </div>
        </div>

        <div id="variables-tab" class="tab-content" role="tabpanel" aria-labelledby="variables-tab-button">
            <div class="section">
                <h2>Variable Descendants <span id="variables-count"></span></h2>
                <div class="section-toolbar" id="variables-toolbar">
                    <input
                        type="search"
                        id="variables-search"
                        class="search-input"
                        placeholder="Filter variables..."
                        aria-label="Search variables"
                    />
                    <button id="variables-export" class="button" type="button">Export to Excel</button>
                </div>
                <div id="variables-note" class="section-note meta-text"></div>
                <div id="variables-container"></div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const REFRESH_INTERVAL = 1000;
        const initialNodeInfo = ${nodeInfoJson};
        const initialReferences = ${referencesJson};
        const initialVariableDescendants = ${variableDescendantsJson};
        const initialHierarchy = ${hierarchyJson};
        let refreshTimer;

        const hierarchyContainer = document.getElementById('node-hierarchy');
        const statusMessageEl = document.getElementById('status-message');
        const variablesTabEl = document.getElementById('variables-tab');
        const variablesTabButton = document.getElementById('variables-tab-button');
        const variablesContainerEl = document.getElementById('variables-container');
        const variablesCountEl = document.getElementById('variables-count');
        const variablesSearchInputEl = document.getElementById('variables-search');
        const variablesSearchInput =
            variablesSearchInputEl instanceof HTMLInputElement ? variablesSearchInputEl : null;
        const variablesExportButtonEl = document.getElementById('variables-export');
        const variablesExportButton =
            variablesExportButtonEl instanceof HTMLButtonElement ? variablesExportButtonEl : null;
        const variablesNoteEl = document.getElementById('variables-note');
        const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-button'));
        const tabContents = Array.prototype.slice.call(document.querySelectorAll('.tab-content'));

        const variableNodes = Array.isArray(initialVariableDescendants?.nodes)
            ? initialVariableDescendants.nodes.slice()
            : [];
        const variablesTruncated = Boolean(initialVariableDescendants?.truncated);
        let filteredVariableNodes = variableNodes.slice();

        function activateTab(targetId) {
            if (!targetId) {
                return;
            }

            tabButtons.forEach((button) => {
                if (!(button instanceof HTMLElement)) {
                    return;
                }

                const buttonTarget = button.getAttribute('data-target');
                const isActive = buttonTarget === targetId;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-selected', isActive ? 'true' : 'false');
                button.tabIndex = isActive ? 0 : -1;
            });

            tabContents.forEach((content) => {
                if (!(content instanceof HTMLElement)) {
                    return;
                }
                content.classList.toggle('active', content.id === targetId);
            });
        }

        tabButtons.forEach((button) => {
            if (!(button instanceof HTMLElement)) {
                return;
            }
            button.setAttribute('aria-selected', button.classList.contains('active') ? 'true' : 'false');
            button.tabIndex = button.classList.contains('active') ? 0 : -1;
            button.addEventListener('click', () => {
                if (button.hidden || button.hasAttribute('disabled')) {
                    return;
                }
                const target = button.getAttribute('data-target');
                if (target) {
                    activateTab(target);
                }
            });
        });

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

        function renderHierarchy(segments) {
            if (!hierarchyContainer) {
                return;
            }

            const entries = Array.isArray(segments) ? segments : [];

            if (!entries.length) {
                hierarchyContainer.innerHTML =
                    '<span class="hierarchy-empty">Hierarchy information unavailable.</span>';
                return;
            }

            const parts = entries.map((segment, index) => {
                const labelSource =
                    segment?.displayName ||
                    segment?.browseName ||
                    segment?.nodeId ||
                    (index === 0 ? 'Root' : 'Node');
                const label = escapeHtml(labelSource);
                const nodeId = typeof segment?.nodeId === 'string' ? segment.nodeId : '';
                const isCurrent = Boolean(segment?.isCurrent);

                if (isCurrent || !nodeId) {
                    return (
                        '<span class="hierarchy-segment">' +
                        '<span class="hierarchy-current" aria-current="page">' +
                        label +
                        '</span>' +
                        '</span>'
                    );
                }

                return (
                    '<span class="hierarchy-segment">' +
                    '<button type="button" class="hierarchy-link" data-node-id="' +
                    escapeHtml(nodeId) +
                    '">' +
                    label +
                    '</button>' +
                    '</span>'
                );
            });

            let html = '';
            for (let i = 0; i < parts.length; i++) {
                html += parts[i];
                if (i < parts.length - 1) {
                    html += '<span class="hierarchy-divider">&rsaquo;</span>';
                }
            }

            hierarchyContainer.innerHTML = html;
        }

        function updateVariablesCount(visibleCount) {
            if (!variablesCountEl) {
                return;
            }

            if (!variableNodes.length) {
                variablesCountEl.textContent = '';
                return;
            }

            if (visibleCount === variableNodes.length) {
                variablesCountEl.textContent = '(' + variableNodes.length + ')';
            } else {
                variablesCountEl.textContent = '(' + visibleCount + '/' + variableNodes.length + ')';
            }
        }

        function updateVariablesNote() {
            if (!variablesNoteEl) {
                return;
            }

            if (variablesTruncated && variableNodes.length > 0) {
                variablesNoteEl.textContent =
                    'Showing first ' + variableNodes.length + ' variables (results truncated).';
                variablesNoteEl.style.display = 'block';
            } else {
                variablesNoteEl.textContent = '';
                variablesNoteEl.style.display = 'none';
            }
        }

        function renderVariableList() {
            if (!variablesTabEl || !variablesContainerEl || !initialVariableDescendants) {
                return;
            }

            if (!variableNodes.length) {
                variablesContainerEl.innerHTML =
                    '<p class="empty-message">No variable descendants found.</p>';
                updateVariablesCount(0);
                if (variablesExportButton) {
                    variablesExportButton.disabled = true;
                }
                updateVariablesNote();
                return;
            }

            if (!filteredVariableNodes.length) {
                variablesContainerEl.innerHTML =
                    '<p class="empty-message">No variables match the current filter.</p>';
                updateVariablesCount(0);
                if (variablesExportButton) {
                    variablesExportButton.disabled = true;
                }
                updateVariablesNote();
                return;
            }

            const rows = filteredVariableNodes
                .map((variable) => {
                    const nodeIdDisplay = escapeHtml(variable.nodeId || '');
                    const nodeIdAttr = escapeHtml(variable.nodeId || '');
                    const displayName = escapeHtml(variable.displayName || '');
                    const browseName = escapeHtml(variable.browseName || '');
                    return (
                        '<tr>' +
                        '<td class="value-cell">' + nodeIdDisplay + '</td>' +
                        '<td class="value-cell">' + displayName + '</td>' +
                        '<td class="value-cell">' + browseName + '</td>' +
                        '<td><button type="button" class="link-button variable-open" data-node-id="' +
                        nodeIdAttr +
                        '">Open</button></td>' +
                        '</tr>'
                    );
                })
                .join('');

            variablesContainerEl.innerHTML =
                '<table>' +
                '<tr>' +
                '<th>Node ID</th>' +
                '<th>Display Name</th>' +
                '<th>Browse Name</th>' +
                '<th></th>' +
                '</tr>' +
                rows +
                '</table>';

            updateVariablesCount(filteredVariableNodes.length);
            if (variablesExportButton) {
                variablesExportButton.disabled = filteredVariableNodes.length === 0;
            }
            updateVariablesNote();
        }

        function applyVariableFilter(term) {
            if (!variableNodes.length) {
                filteredVariableNodes = [];
                renderVariableList();
                return;
            }

            const normalized = term.trim().toLowerCase();

            if (!normalized) {
                filteredVariableNodes = variableNodes.slice();
            } else {
                filteredVariableNodes = variableNodes.filter((variable) => {
                    const nodeId = (variable.nodeId || '').toLowerCase();
                    const displayName = (variable.displayName || '').toLowerCase();
                    const browseName = (variable.browseName || '').toLowerCase();

                    return (
                        nodeId.includes(normalized) ||
                        displayName.includes(normalized) ||
                        browseName.includes(normalized)
                    );
                });
            }

            renderVariableList();
        }

        function exportVariablesToExcel() {
            const payloadNodes = filteredVariableNodes.map((variable) => ({
                nodeId: variable.nodeId || '',
                displayName: variable.displayName || '',
                browseName: variable.browseName || '',
                dataType: variable.dataType || ''
            }));

            vscode.postMessage({
                command: 'exportVariableNodes',
                nodes: payloadNodes,
                totalCount: variableNodes.length,
                filterText: variablesSearchInput?.value ?? ''
            });
        }

        function initializeVariableSection() {
            if (!variablesTabButton || !variablesTabEl) {
                return;
            }

            if (!initialVariableDescendants) {
                variablesTabButton.hidden = true;
                return;
            }

            variablesTabButton.hidden = false;
            variablesTabButton.setAttribute(
                'aria-selected',
                variablesTabButton.classList.contains('active') ? 'true' : 'false'
            );
            variablesTabButton.tabIndex = variablesTabButton.classList.contains('active') ? 0 : -1;

            renderVariableList();

            if (variablesSearchInput) {
                variablesSearchInput.addEventListener('input', () => {
                    applyVariableFilter(variablesSearchInput.value);
                });
            }

            if (variablesExportButton) {
                variablesExportButton.addEventListener('click', () => exportVariablesToExcel());
                variablesExportButton.disabled = filteredVariableNodes.length === 0;
            }

            if (variablesContainerEl) {
                variablesContainerEl.addEventListener('click', (event) => {
                    const target = event.target;
                    if (!(target instanceof Element)) {
                        return;
                    }
                    const buttonEl = target.closest('.variable-open');
                    if (!(buttonEl instanceof HTMLElement)) {
                        return;
                    }
                    const nodeId = buttonEl.getAttribute('data-node-id');
                    if (nodeId) {
                        vscode.postMessage({
                            command: 'openVariableNode',
                            nodeId
                        });
                    }
                });
            }
        }

        if (hierarchyContainer) {
            hierarchyContainer.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof Element)) {
                    return;
                }
                const link = target.closest('.hierarchy-link');
                if (!(link instanceof HTMLElement)) {
                    return;
                }
                const nodeId = link.getAttribute('data-node-id');
                if (nodeId) {
                    vscode.postMessage({
                        command: 'openVariableNode',
                        nodeId
                    });
                }
            });
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

            if (info.formattedAccessLevel || info.accessLevel !== undefined) {
                toggleRow('row-accessLevel', true);
                const accessLevelValue =
                    typeof info.accessLevel === 'number' ? String(info.accessLevel) : '';
                const accessLevelText =
                    info.formattedAccessLevel && info.formattedAccessLevel.length > 0
                        ? String(info.formattedAccessLevel)
                        : accessLevelValue;
                setText('attr-accessLevel', accessLevelText);
            } else {
                toggleRow('row-accessLevel', false);
                setText('attr-accessLevel', '');
            }

            if (info.formattedUserAccessLevel || info.userAccessLevel !== undefined) {
                toggleRow('row-userAccessLevel', true);
                const userAccessLevelValue =
                    typeof info.userAccessLevel === 'number' ? String(info.userAccessLevel) : '';
                const userAccessLevelText =
                    info.formattedUserAccessLevel && info.formattedUserAccessLevel.length > 0
                        ? String(info.formattedUserAccessLevel)
                        : userAccessLevelValue;
                setText('attr-userAccessLevel', userAccessLevelText);
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

        renderHierarchy(initialHierarchy);
        renderNodeDetails(initialNodeInfo);
        renderReferences(initialReferences);
        initializeVariableSection();
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
