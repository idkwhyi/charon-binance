import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { query as pgQuery } from '../db/pg-connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const rawVerdict = String(parsed?.verdict || '').toUpperCase();
  const verdict = ['BUY_LONG', 'BUY_SHORT', 'WATCH', 'PASS'].includes(rawVerdict) ? rawVerdict : 'WATCH';
  let direction = null;
  if (verdict === 'BUY_LONG') direction = 'LONG';
  if (verdict === 'BUY_SHORT') direction = 'SHORT';

  return {
    verdict,
    direction,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 2),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -1.5),
    raw: parsed,
  };
}

/**
 * Strip <think>...</think> blocks that some reasoning models (e.g. qwen3) emit
 * before the actual JSON response, then parse strict JSON.
 */
function parseThinkingModelResponse(content) {
  // Remove <think>...</think> blocks (including multiline)
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return strictJsonFromText(stripped);
}

export async function activeLessonsForPrompt(limit = 6) {
  try {
    const result = await pgQuery(
      "SELECT lesson FROM learning_lessons WHERE status = 'active' ORDER BY id DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(r => r.lesson);
  } catch (err) {
    console.error('[llm] activeLessonsForPrompt failed:', err.message);
    return [];
  }
}

export function compactCandidateForLlm(row) {
  const c = row.candidate || row;
  return {
    candidate_id: row.id,
    symbol: c.symbol,
    signal_type: c.signalType,
    direction_hint: c.direction,
    strategy: c.strategyId,
    leverage: c.leverage,
    metrics: c.metrics,
    signals: c.signals,
    kline_last5_5m: c.klineSnapshot?.last5 || [],
    kline_last5_15m: c.klineSnapshot?.last5_15m || [],
    filters: c.filters,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      direction: null,
      confidence: 0,
      selected_candidate_id: null,
      selected_symbol: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 2),
      suggested_sl_percent: numSetting('default_sl_percent', -1.5),
      raw: null,
    };
  }

  const systemInstructions = [
    'You are Charon, a Binance USDM Futures trading analyst.',
    'Return strict JSON only. No markdown, no explanation outside JSON.',
    'You will receive up to 5 recent market signal candidates.',
    'Each candidate has a direction_hint (LONG or SHORT) from technical indicators.',
    'Pick at most ONE candidate to trade. Use verdict BUY_LONG for a long entry or BUY_SHORT for a short entry.',
    'Use WATCH if candidates are interesting but none is strong enough.',
    'Use PASS if the set is weak, contradictory, or high risk.',
    'Consider: signal type, funding rate (positive = crowded long = SHORT bias), open interest, 24h volume, leverage risk vs reward.',
    'For extreme_ob signals: validate that market structure trend matches direction, OB zone is valid, and R:R >= 1.8.',
    'For extreme_ob signals: SL is placed below the Higher Low (LONG) or above the Lower High (SHORT) — respect this placement.',
    'For extreme_ob signals: use the pre-calculated suggested_tp_percent and suggested_sl_percent from the OB meta — do NOT override unless there is a strong reason.',
    'suggested_tp_percent: positive number (e.g. 2 for 2% from entry).',
    'suggested_sl_percent: negative number (e.g. -1.5 for -1.5% from entry).',
    'Confidence is your conviction 0-100, not probability.',
  ].join(' ');

  const recentLessons = await activeLessonsForPrompt();

  const user = {
    task: 'Pick the best futures trade candidate, or choose none.',
    instructions: systemInstructions,
    recent_lessons: recentLessons,
    output_schema: {
      verdict: 'BUY_LONG | BUY_SHORT | WATCH | PASS',
      selected_candidate_id: 'integer candidate_id when BUY_LONG or BUY_SHORT, otherwise null',
      selected_symbol: 'symbol string when BUY_LONG or BUY_SHORT, otherwise null',
      direction: 'LONG | SHORT | null',
      confidence: 'number 0-100',
      reason: 'short string max 200 chars',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.6,
      max_completion_tokens: 1024,
      top_p: 0.95,
      // For qwen3-32b on Groq: disable chain-of-thought to get clean JSON output
      // reasoning_effort: "none" disables thinking tokens entirely
      // reasoning_format: "hidden" ensures no <think> tags in output
      ...(LLM_MODEL === 'qwen/qwen3-32b' ? {
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
      } : {}),
      messages: [
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    // Use thinking-model-aware parser to strip <think> blocks if present
    const parsed = parseThinkingModelResponse(content);
    const decision = normalizeDecision(parsed);

    const selectedId = Number(parsed.selected_candidate_id);
    const selectedSymbol = String(parsed.selected_symbol || '');
    const row = rows.find(r => r.id === selectedId || (r.candidate || r).symbol === selectedSymbol);
    const isBuy = decision.verdict === 'BUY_LONG' || decision.verdict === 'BUY_SHORT';

    return {
      ...decision,
      selected_candidate_id: isBuy && row ? row.id : null,
      selected_symbol: isBuy && row ? (row.candidate || row).symbol : null,
      selected_row: isBuy && row ? row : null,
    };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    console.log(`[llm] batch failed: ${errMsg}`);
    console.log(`[llm] status: ${err.response?.status} | data: ${JSON.stringify(err.response?.data || {})}`);
    return {
      verdict: 'WATCH',
      direction: null,
      confidence: 0,
      selected_candidate_id: null,
      selected_symbol: null,
      reason: `LLM failed: ${errMsg}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 2),
      suggested_sl_percent: numSetting('default_sl_percent', -1.5),
      raw: { error: errMsg },
    };
  }
}
