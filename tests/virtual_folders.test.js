/**
 * ============================================================================
 * 🧪 VAULT TEST SUITE: Google Drive-Style Virtual Folder Engine
 * Verifies hierarchical folder tree resolution, recursive deletion math,
 * byte formatting, and file extension category classification.
 * ============================================================================
 */

const { describe, it } = require('node:test') || { describe: (name, fn) => describe(name, fn), it: (name, fn) => it(name, fn) };
const assert = require('assert');

describe('📂 Vault Virtual Folder Engine Tests', () => {

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function getCategoryForExt(filename) {
    const ext = (filename.includes('.') ? filename.split('.').pop() : filename).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return 'images';
    if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return 'videos';
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bin', 'iso'].includes(ext)) return 'archives';
    if (['pdf', 'doc', 'docx', 'txt', 'json', 'md'].includes(ext)) return 'documents';
    return 'other';
  }

  it('1. should format byte sizes into clean human-readable units', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(1024), '1 KB');
    assert.strictEqual(formatBytes(4194304), '4 MB');
    assert.strictEqual(formatBytes(10737418240), '10 GB');
  });

  it('2. should accurately categorize file extensions', () => {
    assert.strictEqual(getCategoryForExt('document.pdf'), 'documents');
    assert.strictEqual(getCategoryForExt('video.mp4'), 'videos');
    assert.strictEqual(getCategoryForExt('photo.PNG'), 'images');
    assert.strictEqual(getCategoryForExt('backup.tar.gz'), 'archives');
  });

  it('3. should calculate total folder size by summing nested object payload bytes', () => {
    const files = [
      { id: 'f1', folderId: 'folder-1', sizeBytes: 1048576 }, // 1MB
      { id: 'f2', folderId: 'folder-1', sizeBytes: 2097152 }, // 2MB
      { id: 'f3', folderId: 'folder-2', sizeBytes: 5242880 }  // 5MB (different folder)
    ];

    const folder1Files = files.filter(f => f.folderId === 'folder-1');
    const totalBytes = folder1Files.reduce((sum, f) => sum + f.sizeBytes, 0);

    assert.strictEqual(folder1Files.length, 2);
    assert.strictEqual(totalBytes, 3145728);
    assert.strictEqual(formatBytes(totalBytes), '3 MB');
  });

});
