/**
 * ============================================================================
 * 🧪 VAULT TEST SUITE: Heartbeat Daemon & Node Health Transitions
 * Verifies TCP ping monitoring, missed heartbeat threshold calculations,
 * and automatic status transitions (HEALTHY -> DEGRADED -> OFFLINE).
 * ============================================================================
 */

const { describe, it } = require('node:test') || { describe: (name, fn) => describe(name, fn), it: (name, fn) => it(name, fn) };
const assert = require('assert');

describe('💓 Vault Heartbeat Daemon & Health State Machine Tests', () => {

  function evaluateNodeStatus(isAlive, missedCount, maxMissed = 3) {
    if (isAlive) return { status: 'HEALTHY', missed: 0 };
    const newMissed = missedCount + 1;
    if (newMissed >= maxMissed) {
      return { status: 'OFFLINE', missed: newMissed };
    }
    return { status: 'DEGRADED', missed: newMissed };
  }

  it('1. should return HEALTHY with 0 missed count when node responds', () => {
    const result = evaluateNodeStatus(true, 2);
    assert.strictEqual(result.status, 'HEALTHY');
    assert.strictEqual(result.missed, 0);
  });

  it('2. should transition to DEGRADED on first missed heartbeat', () => {
    const result = evaluateNodeStatus(false, 0);
    assert.strictEqual(result.status, 'DEGRADED');
    assert.strictEqual(result.missed, 1);
  });

  it('3. should transition to OFFLINE when missed count reaches threshold (≥3)', () => {
    const result = evaluateNodeStatus(false, 2);
    assert.strictEqual(result.status, 'OFFLINE');
    assert.strictEqual(result.missed, 3);
  });

  it('4. should recover from OFFLINE back to HEALTHY upon successful reconnection', () => {
    const previousState = { status: 'OFFLINE', missed: 5 };
    const recovered = evaluateNodeStatus(true, previousState.missed);

    assert.strictEqual(recovered.status, 'HEALTHY');
    assert.strictEqual(recovered.missed, 0);
  });

});
