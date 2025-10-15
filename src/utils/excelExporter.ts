import * as XLSX from "xlsx";

export interface VariableNodeExportRow {
    NodeId: string;
    DisplayName: string;
    BrowseName: string;
    DataType: string;
}

interface SummaryRow {
    Property: string;
    Value: string | number | undefined;
}

export interface VariableExportOptions {
    sheetName?: string;
    summary?: SummaryRow[];
}

function normalizeRow(row: VariableNodeExportRow): VariableNodeExportRow {
    return {
        NodeId: row.NodeId ?? "",
        DisplayName: row.DisplayName ?? "",
        BrowseName: row.BrowseName ?? "",
        DataType: row.DataType ?? ""
    };
}

function buildWorksheet(rows: VariableNodeExportRow[]): XLSX.WorkSheet {
    const normalizedRows = rows.map(normalizeRow);
    const worksheet = XLSX.utils.json_to_sheet(normalizedRows);
    worksheet["!cols"] = [
        { wch: 30 }, // NodeId
        { wch: 25 }, // DisplayName
        { wch: 25 }, // BrowseName
        { wch: 20 }  // DataType
    ];
    return worksheet;
}

function appendSummarySheet(workbook: XLSX.WorkBook, summary: SummaryRow[]): void {
    if (summary.length === 0) {
        return;
    }
    const sheet = XLSX.utils.json_to_sheet(summary);
    sheet["!cols"] = [{ wch: 24 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(workbook, sheet, "Summary");
}

function createDefaultSummary(total: number): SummaryRow[] {
    return [
        { Property: "Total Variable Nodes", Value: total },
        { Property: "Export Date", Value: new Date().toISOString() }
    ];
}

export async function exportVariableRowsToExcel(
    rows: VariableNodeExportRow[],
    filePath: string,
    options: VariableExportOptions = {}
): Promise<void> {
    try {
        const workbook = XLSX.utils.book_new();
        const worksheet = buildWorksheet(rows);
        const sheetName = (options.sheetName ?? "Variable Nodes").substring(0, 31);

        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

        const summaryRows = options.summary ?? createDefaultSummary(rows.length);
        appendSummarySheet(workbook, summaryRows);

        XLSX.writeFile(workbook, filePath);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to export variable nodes to Excel: ${message}`);
    }
}

