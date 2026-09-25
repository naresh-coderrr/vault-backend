# 🔐 Vault — Fault-Tolerant Distributed Object Storage Platform

> **Google Drive simplicity. AWS S3 resilience underneath.**

Vault dynamically shards, replicates, and repairs data across independent storage nodes with SHA-256 cryptographic anti-bit-rot scrubbers, automated P2P healing, and Supabase cloud metadata synchronization.

[![Live on GitHub Pages](https://img.shields.io/badge/Live_Site-GitHub_Pages-10B981?style=for-the-badge&logo=github)](https://naresh-coderrr.github.io/vault-storage-platform/)
[![Deploy on Vercel](https://img.shields.io/badge/Deploy_to-Vercel-000000?style=for-the-badge&logo=vercel)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnaresh-coderrr%2Fvault-storage-platform)

---

## 🌐 Live URLs

- 🚀 **Live Web App (GitHub Pages):** [https://naresh-coderrr.github.io/vault-storage-platform/](https://naresh-coderrr.github.io/vault-storage-platform/)
- ⚡ **1-Click Vercel Deploy:** [Deploy on Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnaresh-coderrr%2Fvault-storage-platform)
- 🐙 **Frontend Repository:** [github.com/naresh-coderrr/vault-storage-platform](https://github.com/naresh-coderrr/vault-storage-platform)
- ⚙️ **Backend Repository:** [github.com/naresh-coderrr/vault-backend](https://github.com/naresh-coderrr/vault-backend)
- ⚡ **Supabase Project:** `https://csrhmocmponregwceknr.supabase.co`

---

## 🖥️ Platform Pages

| Page | Path | Description |
|---|---|---|
| 🏠 **Homepage** | `index.html` | Interactive fault-tolerance sandbox, architecture overview & live node simulator |
| 📊 **Dashboard** | `dashboard.html` | Live cluster topology canvas, real-time activity feed, and durability metrics |
| 📁 **File Manager** | `files.html` | Multi-part chunk upload pipeline, SHA-256 integrity verification & downloads |
| 🖥️ **Cluster Health** | `cluster.html` | Storage node cards (:9001, :9002, :9003) and chunk replica placement matrix |
| ⚡ **Chaos Studio** | `chaos.html` | Kill nodes, inject silent bit-rot, network latency & watch sub-second auto-repair |
| ⚙️ **Settings** | `settings.html` | Supabase cloud synchronization, durability policies & encryption keys |
| 🔑 **Sign In** | `login.html` | 1-Click quick login profiles (Storage Architect, Chaos Engineer, Dev Operator) |

---

## ✨ Core Engineering Capabilities

1. **Multi-Part Binary Chunking:** Files of any size are partitioned into 2MB binary buffers with individual block SHA-256 checksums.
2. **N-Way Replication & Durability:** 3× default quorum ensures zero data loss even during simultaneous node outages.
3. **Automated Self-Healing:** Background workers detect missing replicas and automatically re-replicate them to surviving peers in `< 2.0s`.
4. **Anti-Bit-Rot Scrubber:** Continuous integrity verification catches silent magnetic bit flips on disk and restores corrupted blocks.
5. **Supabase Cloud Sync:** Real-time PostgreSQL metadata indexing, access logging, and version tracking.

---

## 📄 License
MIT © 2026 naresh-coderrr
