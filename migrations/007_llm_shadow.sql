-- PostgreSQL Migration: LLM shadow decisions
-- Date: 2026-10-04
--
-- With strategy llm_shadow: true, the LLM is still asked (temperature 0, JSON)
-- to pick among each cycle's candidates, but its answer is ONLY recorded here
-- next to the rule-based pick. It never affects execution.

CREATE TABLE IF NOT EXISTS llm_shadow_decisions (
    id SERIAL PRIMARY KEY,
    at_ms BIGINT NOT NULL,
    model VARCHAR(100),
    candidate_ids JSONB,                    -- candidates offered this cycle
    rule_candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    rule_symbol VARCHAR(20),
    llm_verdict VARCHAR(20),
    llm_candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    llm_symbol VARCHAR(20),
    llm_direction VARCHAR(10),
    llm_confidence INTEGER,
    llm_reason TEXT,
    agrees BOOLEAN,                         -- same pick (or both none) as the rule-based selector
    error TEXT,
    latency_ms INTEGER,
    raw_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_llm_shadow_at ON llm_shadow_decisions (at_ms);
