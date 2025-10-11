import * as XLSX from 'xlsx';
import { OpcuaNodeInfo } from '../types';
import { formatDataType } from './dataTypeMapper';

/**
 * OPC UA 节点的 Excel 导出格式
 */
interface ExcelNodeRow {
    NodeId: string;
    DisplayName: string;
    BrowseName: string;
    NodeClass: string;
    DataType?: string;
    Value?: string;
    AccessLevel?: string;
    Description?: string;
}

/**
 * 将 OPC UA 节点信息转换为 Excel 行格式
 */
function nodeToExcelRow(node: OpcuaNodeInfo): ExcelNodeRow {
    const row: ExcelNodeRow = {
        NodeId: node.nodeId,
        DisplayName: node.displayName || '',
        BrowseName: node.browseName || '',
        NodeClass: node.nodeClass || ''
    };

    // 添加可选字段
    if (node.dataType) {
        row.DataType = formatDataType(node.dataType);
    }

    if (node.value !== undefined && node.value !== null) {
        try {
            row.Value = typeof node.value === 'object'
                ? JSON.stringify(node.value)
                : String(node.value);
        } catch (error) {
            row.Value = '[Complex Value]';
        }
    }

    if (node.accessLevel !== undefined) {
        row.AccessLevel = String(node.accessLevel);
    }

    if (node.description) {
        row.Description = node.description;
    }

    // 注意：writeMask 和 userWriteMask 可能在某些节点中不可用
    // 如果需要这些属性，需要在 OpcuaNodeInfo 接口中添加它们

    return row;
}

/**
 * 导出单个节点到 Excel
 */
export async function exportNodeToExcel(node: OpcuaNodeInfo, filePath: string): Promise<void> {
    try {
        // 创建工作簿
        const workbook = XLSX.utils.book_new();

        // 将节点转换为行数据
        const row = nodeToExcelRow(node);
        const worksheetData = [row];

        // 创建工作表
        const worksheet = XLSX.utils.json_to_sheet(worksheetData);

        // 设置列宽
        const columnWidths = [
            { wch: 30 }, // NodeId
            { wch: 25 }, // DisplayName
            { wch: 25 }, // BrowseName
            { wch: 15 }, // NodeClass
            { wch: 15 }, // DataType
            { wch: 30 }, // Value
            { wch: 15 }, // AccessLevel
            { wch: 40 }  // Description
        ];
        worksheet['!cols'] = columnWidths;

        // 添加工作表到工作簿
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Node Details');

        // 写入文件
        XLSX.writeFile(workbook, filePath);
    } catch (error) {
        throw new Error(`Failed to export node to Excel: ${error}`);
    }
}

/**
 * 导出节点树到 Excel（递归）
 */
export async function exportNodeTreeToExcel(
    rootNode: OpcuaNodeInfo,
    childNodes: OpcuaNodeInfo[],
    filePath: string
): Promise<void> {
    try {
        // 创建工作簿
        const workbook = XLSX.utils.book_new();

        // 收集所有节点（根节点 + 子节点）
        const allNodes = [rootNode, ...childNodes];

        // 转换为 Excel 行格式
        const worksheetData = allNodes.map(node => nodeToExcelRow(node));

        // 创建工作表
        const worksheet = XLSX.utils.json_to_sheet(worksheetData);

        // 设置列宽
        const columnWidths = [
            { wch: 30 }, // NodeId
            { wch: 25 }, // DisplayName
            { wch: 25 }, // BrowseName
            { wch: 15 }, // NodeClass
            { wch: 15 }, // DataType
            { wch: 30 }, // Value
            { wch: 15 }, // AccessLevel
            { wch: 40 }  // Description
        ];
        worksheet['!cols'] = columnWidths;

        // 添加工作表到工作簿
        const sheetName = rootNode.displayName || rootNode.browseName || 'Node Tree';
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.substring(0, 31)); // Excel sheet name limit

        // 添加摘要工作表
        const summary = [
            { Property: 'Total Nodes', Value: allNodes.length },
            { Property: 'Root Node', Value: rootNode.displayName || rootNode.browseName },
            { Property: 'Root NodeId', Value: rootNode.nodeId },
            { Property: 'Export Date', Value: new Date().toISOString() }
        ];
        const summarySheet = XLSX.utils.json_to_sheet(summary);
        summarySheet['!cols'] = [{ wch: 20 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

        // 写入文件
        XLSX.writeFile(workbook, filePath);
    } catch (error) {
        throw new Error(`Failed to export node tree to Excel: ${error}`);
    }
}

/**
 * 导出多个节点到 Excel（分组显示）
 */
export async function exportNodesToExcel(
    nodes: OpcuaNodeInfo[],
    filePath: string,
    groupByNodeClass: boolean = false
): Promise<void> {
    try {
        // 创建工作簿
        const workbook = XLSX.utils.book_new();

        if (groupByNodeClass && nodes.length > 0) {
            // 按 NodeClass 分组
            const grouped = new Map<string, OpcuaNodeInfo[]>();
            for (const node of nodes) {
                const nodeClass = node.nodeClass || 'Unknown';
                if (!grouped.has(nodeClass)) {
                    grouped.set(nodeClass, []);
                }
                grouped.get(nodeClass)!.push(node);
            }

            // 为每个组创建工作表
            for (const [nodeClass, groupNodes] of grouped.entries()) {
                const worksheetData = groupNodes.map(node => nodeToExcelRow(node));
                const worksheet = XLSX.utils.json_to_sheet(worksheetData);
                worksheet['!cols'] = [
                    { wch: 30 }, { wch: 25 }, { wch: 25 }, { wch: 15 },
                    { wch: 15 }, { wch: 30 }, { wch: 15 }, { wch: 40 }
                ];
                XLSX.utils.book_append_sheet(workbook, worksheet, nodeClass);
            }
        } else {
            // 单个工作表包含所有节点
            const worksheetData = nodes.map(node => nodeToExcelRow(node));
            const worksheet = XLSX.utils.json_to_sheet(worksheetData);
            worksheet['!cols'] = [
                { wch: 30 }, { wch: 25 }, { wch: 25 }, { wch: 15 },
                { wch: 15 }, { wch: 30 }, { wch: 15 }, { wch: 40 }
            ];
            XLSX.utils.book_append_sheet(workbook, worksheet, 'All Nodes');
        }

        // 添加摘要
        const summary = [
            { Property: 'Total Nodes', Value: nodes.length },
            { Property: 'Export Date', Value: new Date().toISOString() }
        ];
        const summarySheet = XLSX.utils.json_to_sheet(summary);
        summarySheet['!cols'] = [{ wch: 20 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

        // 写入文件
        XLSX.writeFile(workbook, filePath);
    } catch (error) {
        throw new Error(`Failed to export nodes to Excel: ${error}`);
    }
}
