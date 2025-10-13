import * as vscode from 'vscode';
import { Buffer } from 'buffer';
import { ConnectionManager } from '../opcua/connectionManager';
import { DataViewManager, DataViewEntry } from '../providers/dataViewManager';
import { NodeValueSnapshot } from '../opcua/opcuaClient';

interface DataViewRow {
    id: string;
    connectionId: string;
    connectionName: string;
    nodeId: string;
    displayName?: string;
    dataType?: string;
    description?: string;
    nodeClass?: string;
    value?: unknown;
    statusCode?: string;
    sourceTimestamp?: string;
    serverTimestamp?: string;
    error?: string;
}

interface ColumnDefinition {
    id: string;
    label: string;
    default: boolean;
}

export class DataViewPanel {
    private static currentPanel: DataViewPanel | undefined;
    private static readonly VIEW_TYPE = 'opcuaDataView';
    private static readonly COLUMN_DEFINITIONS: ColumnDefinition[] = [
        { id: 'displayName', label: 'Display Name', default: true },
        { id: 'value', label: 'Value', default: true },
        { id: 'dataType', label: 'Data Type', default: true },
        { id: 'statusCode', label: 'Status', default: false },
        { id: 'sourceTimestamp', label: 'Source Timestamp', default: true },
        { id: 'serverTimestamp', label: 'Server Timestamp', default: false },
        { id: 'connectionName', label: 'Connection', default: true },
        { id: 'nodeId', label: 'Node Id', default: true },
        { id: 'description', label: 'Description', default: false },
        { id: 'nodeClass', label: 'Node Class', default: false }
    ];

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private columnPreferences: string[];
    private readonly managerListener: vscode.Disposable;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly connectionManager: ConnectionManager,
        private readonly dataViewManager: DataViewManager
    ) {
        this.panel = panel;
        this.columnPreferences = this.resolveColumnPreferences();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.managerListener = this.dataViewManager.onDidChange(async () => {
            await this.handleEntriesChanged();
        });
        this.disposables.push(this.managerListener);

        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'requestData':
                    await this.handleDataRequest();
                    break;
                case 'removeNode':
                    if (message.entryId) {
                        await this.dataViewManager.removeNode(message.entryId);
                    }
                    break;
                case 'clearAll':
                    await this.dataViewManager.clear();
                    break;
                case 'updateColumns':
                    if (Array.isArray(message.columns)) {
                        const nextColumns = Array.isArray(message.columns)
                            ? message.columns.filter((value: unknown): value is string => typeof value === 'string')
                            : [];
                        this.columnPreferences = nextColumns.length > 0
                            ? nextColumns
                            : this.getDefaultColumns();
                        await this.dataViewManager.setColumnPreferences(this.columnPreferences);
                    }
                    break;
            }
        }, null, this.disposables);
    }

    public static async show(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        dataViewManager: DataViewManager
    ): Promise<void> {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DataViewPanel.currentPanel) {
            DataViewPanel.currentPanel.panel.reveal(column ?? vscode.ViewColumn.Two);
        } else {
            const panel = vscode.window.createWebviewPanel(
                DataViewPanel.VIEW_TYPE,
                'OPC UA Data View',
                column ?? vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
                }
            );

            DataViewPanel.currentPanel = new DataViewPanel(
                panel,
                extensionUri,
                connectionManager,
                dataViewManager
            );
        }

        await DataViewPanel.currentPanel.update();
    }

    private async update(): Promise<void> {
        this.columnPreferences = this.resolveColumnPreferences();
        const entries = this.dataViewManager.getEntries();
        this.panel.title = 'OPC UA Data View';
        this.panel.webview.html = this.getHtml(entries, this.columnPreferences);
    }

    private async handleEntriesChanged(): Promise<void> {
        if (!this.panel.visible) {
            return;
        }

        this.columnPreferences = this.resolveColumnPreferences();
        const entries = this.dataViewManager.getEntries();

        await this.panel.webview.postMessage({
            command: 'entries',
            entries,
            columnPreferences: this.columnPreferences
        });

        await this.handleDataRequest();
    }

    private async handleDataRequest(): Promise<void> {
        const entries = this.dataViewManager.getEntries();

        if (entries.length === 0) {
            await this.panel.webview.postMessage({
                command: 'data',
                rows: [] as DataViewRow[]
            });
            return;
        }

        const rows: DataViewRow[] = [];
        const groupedByConnection = this.groupEntriesByConnection(entries);

        for (const [connectionId, items] of groupedByConnection.entries()) {
            const client = this.connectionManager.getConnection(connectionId);

            if (!client || !client.isConnected) {
                for (const entry of items) {
                    rows.push(this.buildRow(entry, {
                        nodeId: entry.nodeId,
                        error: 'Not connected to server'
                    }));
                }
                continue;
            }

            try {
                const snapshots = await client.readNodeSnapshots(items.map(item => item.nodeId));

                for (let i = 0; i < items.length; i++) {
                    const entry = items[i];
                    const snapshot = snapshots[i] ?? { nodeId: entry.nodeId, error: 'No data' };
                    rows.push(this.buildRow(entry, snapshot));
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                for (const entry of items) {
                    rows.push(this.buildRow(entry, {
                        nodeId: entry.nodeId,
                        error: message
                    }));
                }
            }
        }

        await this.panel.webview.postMessage({
            command: 'data',
            rows
        });
    }

    private buildRow(entry: DataViewEntry, snapshot: Partial<NodeValueSnapshot>): DataViewRow {
        return {
            id: entry.id,
            connectionId: entry.connectionId,
            connectionName: entry.connectionName,
            nodeId: entry.nodeId,
            displayName: snapshot.displayName || entry.displayName || entry.nodeId,
            dataType: snapshot.dataType || entry.dataType,
            description: entry.description,
            nodeClass: snapshot.nodeClass || entry.nodeClass,
            value: this.sanitizeValue(snapshot.value),
            statusCode: snapshot.statusCode,
            sourceTimestamp: snapshot.sourceTimestamp,
            serverTimestamp: snapshot.serverTimestamp,
            error: snapshot.error
        };
    }

    private groupEntriesByConnection(entries: DataViewEntry[]): Map<string, DataViewEntry[]> {
        const grouped = new Map<string, DataViewEntry[]>();
        for (const entry of entries) {
            if (!grouped.has(entry.connectionId)) {
                grouped.set(entry.connectionId, []);
            }
            grouped.get(entry.connectionId)?.push(entry);
        }
        return grouped;
    }

    private sanitizeValue(value: unknown, depth: number = 0): unknown {
        if (value === null || value === undefined) {
            return value;
        }

        if (typeof value === 'bigint') {
            return value.toString();
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (Buffer.isBuffer(value)) {
            return `Buffer(${value.length})`;
        }

        if (Array.isArray(value)) {
            if (depth > 2) {
                return `[Array(${value.length})]`;
            }
            return value.map((item) => this.sanitizeValue(item, depth + 1));
        }

        if (value instanceof Map) {
            return Array.from(value.entries()).map(([key, val]) => [key, this.sanitizeValue(val, depth + 1)]);
        }

        if (value instanceof Set) {
            return Array.from(value.values()).map((item) => this.sanitizeValue(item, depth + 1));
        }

        if (typeof value === 'object') {
            if (depth > 2) {
                return '[Object]';
            }
            const result: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
                result[key] = this.sanitizeValue(val, depth + 1);
            }
            return result;
        }

        return value;
    }

    private getHtml(entries: DataViewEntry[], columnPreferences: string[]): string {
        const nonce = this.getNonce();
        const columns = this.serializeForWebview(DataViewPanel.COLUMN_DEFINITIONS);
        const entriesSerialized = this.serializeForWebview(entries);
        const preferencesSerialized = this.serializeForWebview(columnPreferences.length > 0 ? columnPreferences : this.getDefaultColumns());

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <title>OPC UA Data View</title>
    <style nonce="${nonce}">
        :root {
            color-scheme: light dark;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        button {
            all: unset;
            padding: 4px 12px;
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .column-selector {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            padding: 8px 12px;
            border-radius: 6px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border, transparent);
        }

        .column-selector label {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
        }

        .table-wrapper {
            overflow: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 600px;
        }

        thead {
            background: var(--vscode-editorWidget-background);
        }

        th, td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
            max-width: 400px;
            word-break: break-word;
            white-space: pre-wrap;
        }

        tbody tr:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .cell-actions {
            width: 36px;
            text-align: center;
        }

        .remove-btn {
            all: unset;
            width: 24px;
            height: 24px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            cursor: pointer;
            color: var(--vscode-errorForeground);
        }

        .remove-btn:hover {
            background: var(--vscode-editorHoverWidget-background);
        }

        .status {
            flex: 1;
            min-width: 200px;
            color: var(--vscode-descriptionForeground);
        }

        .status.error {
            color: var(--vscode-errorForeground);
        }

        .empty-state {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 32px 0;
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 6px;
        }

        .row-error {
            color: var(--vscode-errorForeground);
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button data-action="refresh">Refresh Now</button>
        <button data-action="clear">Clear All</button>
        <span class="status" id="status"></span>
    </div>
    <div class="column-selector" id="columnSelector"></div>
    <div class="table-wrapper">
        <table>
            <thead id="tableHeader"></thead>
            <tbody id="tableBody"></tbody>
        </table>
    </div>
    <div class="empty-state" id="emptyState" style="display: none;">
        No monitored nodes yet. Use the explorer context menu to add nodes to the Data View.
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const COLUMN_DEFINITIONS = ${columns};
        const DEFAULT_COLUMNS = COLUMN_DEFINITIONS.filter(col => col.default).map(col => col.id);
        let entries = ${entriesSerialized};
        let activeColumns = ${preferencesSerialized};
        let latestRows = [];
        let refreshTimer;

        const state = vscode.getState();
        if (state?.activeColumns && Array.isArray(state.activeColumns) && state.activeColumns.length > 0) {
            activeColumns = state.activeColumns;
        }

        function saveState() {
            vscode.setState({
                activeColumns,
                entries
            });
        }

        function ensureColumnSelection() {
            if (!Array.isArray(activeColumns) || activeColumns.length === 0) {
                activeColumns = DEFAULT_COLUMNS.slice();
            }
        }

        function normalizeColumns(columnIds) {
            return columnIds.filter((id) => COLUMN_DEFINITIONS.some((col) => col.id === id));
        }

        activeColumns = normalizeColumns(activeColumns);
        ensureColumnSelection();

        const columnSelector = document.getElementById('columnSelector');
        const tableHeader = document.getElementById('tableHeader');
        const tableBody = document.getElementById('tableBody');
        const statusElement = document.getElementById('status');
        const emptyState = document.getElementById('emptyState');

        function setStatus(message, isError = false) {
            statusElement.textContent = message;
            statusElement.classList.toggle('error', isError);
        }

        function renderColumnSelector() {
            columnSelector.innerHTML = '';
            COLUMN_DEFINITIONS.forEach((column) => {
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = column.id;
                checkbox.checked = activeColumns.includes(column.id);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        if (!activeColumns.includes(column.id)) {
                            activeColumns.push(column.id);
                        }
                    } else {
                        activeColumns = activeColumns.filter((id) => id !== column.id);
                        if (activeColumns.length === 0) {
                            activeColumns = DEFAULT_COLUMNS.slice();
                        }
                    }
                    activeColumns = normalizeColumns(activeColumns);
                    renderTable();
                    saveState();
                    vscode.postMessage({ command: 'updateColumns', columns: activeColumns });
                });

                label.appendChild(checkbox);
                const text = document.createElement('span');
                text.textContent = column.label;
                label.appendChild(text);
                columnSelector.appendChild(label);
            });
        }

        function renderTable() {
            tableHeader.innerHTML = '';
            const headerRow = document.createElement('tr');
            activeColumns.forEach((columnId) => {
                const definition = COLUMN_DEFINITIONS.find((col) => col.id === columnId);
                if (!definition) {
                    return;
                }
                const th = document.createElement('th');
                th.textContent = definition.label;
                headerRow.appendChild(th);
            });
            const actionHeader = document.createElement('th');
            actionHeader.classList.add('cell-actions');
            headerRow.appendChild(actionHeader);
            tableHeader.appendChild(headerRow);

            renderRows();
        }

        function formatCellValue(columnId, row) {
            const value = row[columnId];
            if (value === null || value === undefined) {
                return '';
            }
            if (typeof value === 'object') {
                try {
                    return JSON.stringify(value);
                } catch (error) {
                    return String(value);
                }
            }
            return String(value);
        }

        function renderRows() {
            tableBody.innerHTML = '';
            const rowById = new Map(latestRows.map((row) => [row.id, row]));
            if (entries.length === 0) {
                emptyState.style.display = 'block';
                return;
            }
            emptyState.style.display = 'none';

            entries.forEach((entry) => {
                const row = rowById.get(entry.id) ?? {
                    id: entry.id,
                    connectionId: entry.connectionId,
                    connectionName: entry.connectionName,
                    nodeId: entry.nodeId
                };

                const tr = document.createElement('tr');
                if (row.error) {
                    tr.classList.add('row-error');
                }

                activeColumns.forEach((columnId) => {
                    const td = document.createElement('td');
                    const text = columnId in row ? formatCellValue(columnId, row) : '';
                    td.textContent = text;
                    tr.appendChild(td);
                });

                const actionCell = document.createElement('td');
                actionCell.classList.add('cell-actions');
                const removeButton = document.createElement('button');
                removeButton.classList.add('remove-btn');
                removeButton.title = 'Remove from Data View';
                removeButton.textContent = '✕';
                removeButton.dataset.entryId = entry.id;
                actionCell.appendChild(removeButton);
                tr.appendChild(actionCell);

                tableBody.appendChild(tr);
            });
        }

        tableBody.addEventListener('click', (event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.matches('.remove-btn')) {
                const entryId = target.dataset.entryId;
                if (entryId) {
                    vscode.postMessage({ command: 'removeNode', entryId });
                }
            }
        });

        function requestData() {
            vscode.postMessage({ command: 'requestData' });
        }

        document.querySelector('[data-action=\"refresh\"]').addEventListener('click', () => {
            requestData();
        });

        document.querySelector('[data-action=\"clear\"]').addEventListener('click', () => {
            vscode.postMessage({ command: 'clearAll' });
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) {
                return;
            }

            switch (message.command) {
                case 'data':
                    latestRows = Array.isArray(message.rows) ? message.rows : [];
                    const validRows = latestRows.filter((row) => !row.error);
                    const timestamp = new Date().toLocaleTimeString();
                    const statusMessage = validRows.length === entries.length
                        ? \`Updated \${validRows.length} items at \${timestamp}\`
                        : \`Updated at \${timestamp} (some errors)\`;
                    setStatus(statusMessage, validRows.length !== entries.length);
                    renderRows();
                    saveState();
                    break;
                case 'entries':
                    entries = Array.isArray(message.entries) ? message.entries : [];
                    if (Array.isArray(message.columnPreferences) && message.columnPreferences.length > 0) {
                        activeColumns = normalizeColumns(message.columnPreferences);
                        ensureColumnSelection();
                        renderColumnSelector();
                        renderTable();
                    } else {
                        renderColumnSelector();
                        renderTable();
                    }
                    saveState();
                    break;
                case 'error':
                    setStatus(message.message || 'An error occurred while updating data.', true);
                    break;
            }
        });

        function initialize() {
            renderColumnSelector();
            renderTable();
            requestData();
            refreshTimer = setInterval(() => requestData(), 2000);
        }

        window.addEventListener('unload', () => {
            if (refreshTimer) {
                clearInterval(refreshTimer);
            }
        });

        initialize();
    </script>
</body>
</html>`;
    }

    private resolveColumnPreferences(): string[] {
        const stored = this.dataViewManager.getColumnPreferences();
        if (!stored || stored.length === 0) {
            return this.getDefaultColumns();
        }
        const valid = stored.filter((id) =>
            DataViewPanel.COLUMN_DEFINITIONS.some((column) => column.id === id)
        );
        return valid.length > 0 ? valid : this.getDefaultColumns();
    }

    private getDefaultColumns(): string[] {
        return DataViewPanel.COLUMN_DEFINITIONS
            .filter((column) => column.default)
            .map((column) => column.id);
    }

    private serializeForWebview(value: unknown): string {
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'bigint') {
                return val.toString();
            }
            if (val instanceof Date) {
                return val.toISOString();
            }
            return val;
        })
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
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
        DataViewPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
