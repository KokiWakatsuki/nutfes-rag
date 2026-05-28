-- レート制限テーブル（全 Vercel インスタンス間で共有）
CREATE TABLE IF NOT EXISTS rate_limits (
  email    TEXT        PRIMARY KEY,
  count    INTEGER     NOT NULL DEFAULT 1,
  reset_at TIMESTAMPTZ NOT NULL
);

-- レート制限チェック・インクリメント（アトミック）
-- TRUE = 許可 / FALSE = 制限中
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_email        TEXT,
  p_max_requests INTEGER,
  p_window_ms    INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_now      TIMESTAMPTZ := now();
  v_reset_at TIMESTAMPTZ := v_now + (p_window_ms || ' milliseconds')::INTERVAL;
  v_count    INTEGER;
BEGIN
  INSERT INTO rate_limits (email, count, reset_at)
  VALUES (p_email, 1, v_reset_at)
  ON CONFLICT (email) DO UPDATE SET
    count    = CASE WHEN rate_limits.reset_at <= v_now THEN 1
                    ELSE rate_limits.count + 1 END,
    reset_at = CASE WHEN rate_limits.reset_at <= v_now THEN v_reset_at
                    ELSE rate_limits.reset_at END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_requests;
END;
$$;
