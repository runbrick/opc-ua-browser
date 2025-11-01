/**
 * OPC UA standard data type mapping
 * Map NodeId to readable data type names
 */

export const OPC_UA_DATA_TYPES: { [key: string]: string } = {
    // Basic data types
    'i=1': 'Boolean',
    'i=2': 'SByte',
    'i=3': 'Byte',
    'i=4': 'Int16',
    'i=5': 'UInt16',
    'i=6': 'Int32',
    'i=7': 'UInt32',
    'i=8': 'Int64',
    'i=9': 'UInt64',
    'i=10': 'Float',
    'i=11': 'Double',
    'i=12': 'String',
    'i=13': 'DateTime',
    'i=14': 'Guid',
    'i=15': 'ByteString',
    'i=16': 'XmlElement',
    'i=17': 'NodeId',
    'i=18': 'ExpandedNodeId',
    'i=19': 'StatusCode',
    'i=20': 'QualifiedName',
    'i=21': 'LocalizedText',
    'i=22': 'ExtensionObject',
    'i=23': 'DataValue',
    'i=24': 'Variant',
    'i=25': 'DiagnosticInfo',

    // Complex data types
    'i=26': 'Number',
    'i=27': 'Integer',
    'i=28': 'UInteger',
    'i=29': 'Enumeration',
    'i=256': 'IdType',
    'i=257': 'NodeClass',
    'i=290': 'Duration',
    'i=294': 'UtcTime',
    'i=295': 'LocaleId',
    'i=296': 'Argument',
    'i=297': 'StatusResult',
    'i=298': 'MessageSecurityMode',
    'i=299': 'UserTokenPolicy',
    'i=300': 'ApplicationType',
    'i=301': 'ApplicationDescription',
    'i=302': 'EndpointDescription',
    'i=303': 'SecurityTokenRequestType',
    'i=304': 'UserTokenType',
    'i=305': 'UserIdentityToken',
    'i=306': 'AnonymousIdentityToken',
    'i=307': 'UserNameIdentityToken',
    'i=308': 'X509IdentityToken',
    'i=309': 'EndpointConfiguration',
    'i=310': 'BuildInfo',
    'i=311': 'SoftwareCertificate',
    'i=312': 'SignedSoftwareCertificate',
    'i=316': 'AddNodesItem',
    'i=338': 'DeleteNodesItem', // Previously duplicate: ServerStatusDataType
    'i=344': 'AddReferencesItem',
    'i=348': 'DeleteReferencesItem',
    'i=339': 'ServerState',
    'i=371': 'RedundancySupport',
    'i=372': 'ServerDiagnosticsSummaryDataType',
    'i=376': 'Argument', // Previously duplicate: ServiceCounterDataType
    'i=377': 'SessionDiagnosticsDataType',
    'i=378': 'SessionSecurityDiagnosticsDataType',
    'i=432': 'SessionCounterDataType',
    'i=521': 'ContinuationPoint',
    'i=537': 'Range',
    'i=540': 'EUInformation',
    'i=659': 'EnumValueType',
    'i=851': 'TimeZoneDataType',
    'i=852': 'IntegerId',
    'i=873': 'SubscriptionDiagnosticsDataType',
    'i=884': 'AxisInformation',
    'i=885': 'XVType',
    'i=887': 'ProgramDiagnosticDataType',
    'i=888': 'Annotation',
    'i=890': 'ExceptionDeviationFormat',
    'i=891': 'ImageBMP',
    'i=892': 'ImageGIF',
    'i=893': 'ImageJPG',
    'i=894': 'ImagePNG',
    'i=896': 'AudioDataType',
    'i=897': 'BitFieldMaskDataType',
    'i=919': 'SemanticChangeStructureDataType',
    'i=920': 'ModelChangeStructureDataType',

    // Array types (common)
    'i=7617': 'EnumDefinition',
    'i=7594': 'StructureDefinition',
    'i=12755': 'UABinaryFileDataType',
    'i=14533': 'PubSubKeyPushTargetDataType',
    'i=15634': 'NetworkAddressDataType',
    'i=15631': 'SimpleAttributeOperand'
};

/**
 * Parse data type NodeId to readable name
 * @param dataTypeNodeId Data type NodeId (e.g. 'i=10')
 * @returns Readable type name (e.g. 'Float')
 */
export function parseDataType(dataTypeNodeId: string | undefined): string {
    if (!dataTypeNodeId) {
        return 'Unknown';
    }

    // Clean NodeId string
    const cleanNodeId = dataTypeNodeId.trim();

    // Find standard type
    if (OPC_UA_DATA_TYPES[cleanNodeId]) {
        return OPC_UA_DATA_TYPES[cleanNodeId];
    }

    // If numeric NodeId (ns=0;i=xxx), try simplified format
    const match = cleanNodeId.match(/(?:ns=0;)?i=(\d+)/);
    if (match) {
        const simpleId = `i=${match[1]}`;
        if (OPC_UA_DATA_TYPES[simpleId]) {
            return OPC_UA_DATA_TYPES[simpleId];
        }
    }

    // For custom types, return NodeId itself
    return `${cleanNodeId} (Custom)`;
}

/**
 * Format data type display
 * @param dataTypeNodeId Data type NodeId
 * @returns Formatted display string
 */
export function formatDataType(dataTypeNodeId: string | undefined): string {
    if (!dataTypeNodeId) {
        return 'N/A';
    }

    const typeName = parseDataType(dataTypeNodeId);

    // If standard type, show name only
    if (!typeName.includes('Custom')) {
        return typeName;
    }

    // Custom type shows name and NodeId
    return typeName;
}

/**
 * Check if array type
 * @param dataTypeNodeId Data type NodeId
 * @returns Whether it is an array
 */
export function isArrayType(dataTypeNodeId: string | undefined): boolean {
    if (!dataTypeNodeId) {
        return false;
    }

    // Simple check, can be extended as needed
    return dataTypeNodeId.toLowerCase().includes('array');
}

/**
 * Get list of all supported data types
 * @returns Array of data type names
 */
export function getAllDataTypes(): string[] {
    return Object.values(OPC_UA_DATA_TYPES).sort();
}
