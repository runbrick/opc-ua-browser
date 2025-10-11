import { NodeId } from 'node-opcua';

export interface OpcuaConnectionConfig {
    id: string;
    name: string;
    endpointUrl: string;
    securityMode: string;
    securityPolicy: string;
    authType: 'Anonymous' | 'UserPassword';
    username?: string;
    password?: string;
}

export interface OpcuaNodeInfo {
    nodeId: string;
    browseName: string;
    displayName: string;
    nodeClass: string;
    value?: any;
    dataType?: string;
    accessLevel?: number;
    userAccessLevel?: number;
    description?: string;
}

export interface OpcuaReference {
    referenceTypeId: string;
    isForward: boolean;
    nodeId: string;
    browseName: string;
    displayName: string;
    nodeClass: string;
}

export enum ConnectionStatus {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error'
}
