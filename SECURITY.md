# 🔒 Security Policy & Architectural Guarantees

## 🛡️ Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 5.2.x   | :white_check_mark: |
| < 5.0   | :x:                |

---

## 🔐 Core Security & Durability Principles

### 1. Zero-Knowledge Cryptographic Hashing
- Every storage object is processed using the **Web Crypto API** (client-side) and **Node.js `crypto`** (server-side) to generate a **64-character SHA-256 checksum**.
- Storage nodes reject any incoming binary payload whose checksum does not match the manifest header.

### 2. Path Traversal & Injection Defense
- All chunk IDs and filenames are sanitized through strictly normalized path boundaries.
- Database access uses prepared SQL statements with parameter bindings to eliminate SQL injection vulnerabilities.

### 3. High-Durability Quorum Placement
- Sharded data is protected across independent availability zones (Zone 1: US-East, Zone 2: US-West, Zone 3: EU/AP).
- Multi-node quorums prevent single-point-of-failure (SPOF) risks and withstand up to 2 simultaneous node hardware crashes.

### 4. Periodic Anti-Bit-Rot Scrubbing
- Background scrubber daemons periodically verify disk chunk integrity against cryptographic manifests, automatically flagging corrupted sectors for healer daemon replacement.

---

## 🚨 Reporting a Vulnerability

If you discover a potential security vulnerability within **Vault**, please report it responsibly:

1. **Email**: `security@vault-storage.io` / `nareshramrajasimhan18@gmail.com`
2. **Response Time**: You will receive an acknowledgment within 24 hours.
3. **Patch Window**: Confirmed vulnerabilities will be patched within 72 hours with a CVE disclosure release.
