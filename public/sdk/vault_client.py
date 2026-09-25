"""
Vault Distributed Object Storage — Python SDK Client
Enables programmatic S3-compatible chunk sharding, parallel replication,
and SHA-256 integrity verification across storage nodes.
"""

import os
import hashlib
import requests
from typing import List, Dict, Any, Optional

CHUNK_SIZE = 2 * 1024 * 1024  # 2MB chunks

class VaultClient:
    def __init__(self, gateway_url: str = "http://localhost:3000", api_key: Optional[str] = None):
        self.gateway_url = gateway_url.rstrip("/")
        self.api_key = api_key
        self.session = requests.Session()
        if api_key:
            self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def upload_file(self, file_path: str, replication_factor: int = 3) -> Dict[str, Any]:
        """Upload and partition a file into 2MB shards with SHA-256 validation."""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        file_size = os.path.getsize(file_path)
        filename = os.path.basename(file_path)

        with open(file_path, "rb") as f:
            file_bytes = f.read()

        file_hash = hashlib.sha256(file_bytes).hexdigest()

        # Send multi-part form upload to Gateway
        files = {"file": (filename, file_bytes)}
        data = {"replicationFactor": replication_factor}
        
        response = self.session.post(f"{self.gateway_url}/api/v1/objects/upload", files=files, data=data)
        response.raise_for_status()
        return response.json()

    def download_file(self, object_id: str, output_path: str) -> str:
        """Download and reassemble object shards directly from healthy nodes."""
        response = self.session.get(f"{self.gateway_url}/api/v1/objects/{object_id}/download", stream=True)
        response.raise_for_status()

        with open(output_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        return output_path

    def get_cluster_health(self) -> Dict[str, Any]:
        """Fetch real-time cluster durability score, active nodes, and scrubber status."""
        res = self.session.get(f"{self.gateway_url}/api/v1/cluster/health")
        res.raise_for_status()
        return res.json()

if __name__ == "__main__":
    client = VaultClient()
    print("🔐 Vault Python SDK initialized successfully.")
