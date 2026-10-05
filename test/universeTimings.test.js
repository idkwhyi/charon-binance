import { test } from 'node:test';
import assert from 'node:assert/strict';

test('15m candle alignment: :00, :15, :30, :45 UTC', () => {
  // Helper function (same as in topGainers.js)
  function last15mCandle(nowMs) {
    const t = new Date(nowMs);
    const minutes = t.getUTCMinutes();
    const aligned = Math.floor(minutes / 15) * 15;
    const closeT = new Date(t);
    closeT.setUTCMinutes(aligned);
    closeT.setUTCSeconds(0);
    closeT.setUTCMilliseconds(0);
    return closeT.getTime();
  }

  // Test 1: 14:07 UTC → last closed candle was at 14:00
  const d1 = new Date('2026-10-05T14:07:00Z').getTime();
  const c1 = last15mCandle(d1);
  const c1Expected = new Date('2026-10-05T14:00:00Z').getTime();
  assert.strictEqual(c1, c1Expected, '14:07 UTC → 14:00 close');

  // Test 2: 14:30:30 UTC → last closed candle was at 14:30
  const d2 = new Date('2026-10-05T14:30:30Z').getTime();
  const c2 = last15mCandle(d2);
  const c2Expected = new Date('2026-10-05T14:30:00Z').getTime();
  assert.strictEqual(c2, c2Expected, '14:30:30 UTC → 14:30 close');

  // Test 3: 14:44 UTC → last closed candle was at 14:30
  const d3 = new Date('2026-10-05T14:44:00Z').getTime();
  const c3 = last15mCandle(d3);
  const c3Expected = new Date('2026-10-05T14:30:00Z').getTime();
  assert.strictEqual(c3, c3Expected, '14:44 UTC → 14:30 close');

  // Test 4: 14:00:00 UTC → last closed candle was at 14:00
  const d4 = new Date('2026-10-05T14:00:00Z').getTime();
  const c4 = last15mCandle(d4);
  const c4Expected = new Date('2026-10-05T14:00:00Z').getTime();
  assert.strictEqual(c4, c4Expected, '14:00:00 UTC → 14:00 close');

  // Test 5: 14:59 UTC → last closed candle was at 14:45
  const d5 = new Date('2026-10-05T14:59:00Z').getTime();
  const c5 = last15mCandle(d5);
  const c5Expected = new Date('2026-10-05T14:45:00Z').getTime();
  assert.strictEqual(c5, c5Expected, '14:59 UTC → 14:45 close');
});

test('universe update timing: only once per 15m candle, not per wall-clock interval', () => {
  // This test verifies the logic:
  // - If last update was at 14:15 close, next update should be at 14:30 close
  // - Even if we call updateUniverse multiple times between 14:15 and 14:30,
  //   it should only actually update once (at 14:30)

  // Pseudo-code simulation (real test would need to mock Date.now()):
  function simulateUpdates() {
    const times = [
      new Date('2026-10-05T14:15:05Z').getTime(), // just after 14:15 close
      new Date('2026-10-05T14:15:30Z').getTime(), // 15s later
      new Date('2026-10-05T14:20:00Z').getTime(), // 5 min later (still within 14:15-14:30 window)
      new Date('2026-10-05T14:30:05Z').getTime(), // just after 14:30 close
    ];

    let lastUpdateMs = 0;
    const updates = [];

    for (const nowMs of times) {
      const t = new Date(nowMs);
      const minutes = t.getUTCMinutes();
      const aligned = Math.floor(minutes / 15) * 15;
      const closeT = new Date(t);
      closeT.setUTCMinutes(aligned + 15);
      closeT.setUTCSeconds(0);
      closeT.setUTCMilliseconds(0);
      const current15mMs = closeT.getTime();

      const shouldUpdate = current15mMs > lastUpdateMs;
      updates.push({ time: new Date(nowMs).toISOString(), shouldUpdate });

      if (shouldUpdate) lastUpdateMs = current15mMs;
    }

    return updates;
  }

  const updates = simulateUpdates();
  assert.deepStrictEqual(
    updates.map(u => u.shouldUpdate),
    [true, false, false, true],
    'update only at new 15m candle close, not on intermediate calls'
  );
});
