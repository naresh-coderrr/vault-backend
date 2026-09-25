/**
 * Vault Distributed Object Storage — TypeScript SDK Client
 * Programmatic multi-part chunk partitioning, SHA-256 verification, and cluster telemetry.
 */

export interface VaultObject {
  id: string;
  filename: string;
  totalSize: number;
  totalChunks: number;
  replicationFactor: number;
  fileHash: string;
  status: 'ACTIVE' | 'DEGRADED' | 'REPAIRING' | 'CORRUPTED';
  createdAt: string;
}

export interface ClusterHealth {
  totalNodes: number;
  healthyNodes: number;
  healthScore: number;
  totalFiles: number;
  underReplicatedChunks: number;
}

export class VaultClient {
  private gatewayUrl: string;

  constructor(gatewayUrl: string = 'http://localhost:3000') {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
  }

  async uploadFile(file: File | Blob, filename: string, replicationFactor: number = 3): Promise<VaultObject> {
    const formData = new FormData();
    formData.append('file', file, filename);
    formData.append('replicationFactor', replicationFactor.toString());

    const response = await fetch(`${this.gatewayUrl}/api/v1/objects/upload`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Upload failed with status: ${response.status}`);
    }

    return await response.json();
  }

  async downloadFile(objectId: string): Promise<Blob> {
    const response = await fetch(`${this.gatewayUrl}/api/v1/objects/${objectId}/download`);
    if (!response.ok) {
      throw new Error(`Download failed with status: ${response.status}`);
    }
    return await response.blob();
  }

  async getHealth(): Promise<ClusterHealth> {
    const response = await fetch(`${this.gatewayUrl}/api/v1/cluster/health`);
    return await response.json();
  }
}
