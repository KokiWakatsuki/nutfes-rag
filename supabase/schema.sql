-- 注意: このファイルはリファレンス用です。
-- 実際のスキーマ変更は supabase/migrations/ に追加し、
-- `npm run migrate` で適用してください。
--
-- pgvector 拡張を有効化
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_trgm: ハイブリッド検索（トライグラム類似度）に使用
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ドキュメントテーブル
CREATE TABLE IF NOT EXISTS documents (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id          TEXT        NOT NULL,
  chunk_index      INTEGER     NOT NULL DEFAULT 0,
  file_name        TEXT        NOT NULL,
  content          TEXT        NOT NULL,
  edition          INTEGER     NOT NULL,
  drive_id         TEXT        NOT NULL,
  drive_modified_at TEXT,
  embedding        vector(768),
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (file_id, chunk_index)
);

-- ベクトル検索用インデックス（コサイン類似度）
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 回次検索用インデックス
CREATE INDEX IF NOT EXISTS documents_edition_idx ON documents (edition);

-- ハイブリッド検索用トライグラムインデックス
CREATE INDEX IF NOT EXISTS documents_content_trgm
  ON documents USING GIN (content gin_trgm_ops);

-- updated_at を自動更新するトリガー関数
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 旧シグネチャを削除してから再作成
DROP FUNCTION IF EXISTS match_documents(vector, INT, INT);
DROP FUNCTION IF EXISTS match_documents(vector, INT, INTEGER[]);
DROP FUNCTION IF EXISTS match_documents(vector, INT, INTEGER[], TEXT);

-- ハイブリッド検索関数
-- query_text が指定された場合: ベクトル検索 + トライグラム検索を RRF で統合
-- query_text が NULL の場合: ベクトル検索のみ
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(768),
  match_count     INT,
  filter_editions INTEGER[] DEFAULT NULL,
  query_text      TEXT DEFAULT NULL
)
RETURNS TABLE (
  id                UUID,
  file_id           TEXT,
  file_name         TEXT,
  content           TEXT,
  edition           INT,
  drive_id          TEXT,
  drive_modified_at TEXT,
  drive_created_at  TIMESTAMPTZ,
  similarity        FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  -- word_similarity 閾値をセッションローカルで設定（%>> 演算子に反映される）
  SET LOCAL pg_trgm.word_similarity_threshold = 0.15;

  IF query_text IS NULL OR length(trim(query_text)) < 2 THEN
    -- ベクトル検索のみ
    RETURN QUERY
    SELECT
      d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
      d.drive_modified_at, d.drive_created_at,
      (1 - (d.embedding <=> query_embedding))::FLOAT AS similarity
    FROM documents d
    WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
      AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
  ELSE
    -- ハイブリッド検索: ベクトル + トライグラム（Reciprocal Rank Fusion）
    -- query_text %>> d.content は GIN インデックスを使用するため高速
    RETURN QUERY
    WITH vector_ranked AS (
      SELECT d.id,
             ROW_NUMBER() OVER (ORDER BY d.embedding <=> query_embedding) AS rank
      FROM documents d
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND d.embedding IS NOT NULL
      LIMIT match_count * 5
    ),
    text_ranked AS (
      SELECT d.id,
             ROW_NUMBER() OVER (ORDER BY word_similarity(query_text, d.content) DESC) AS rank
      FROM documents d
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND query_text %>> d.content
      LIMIT match_count * 5
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, t.id) AS doc_id,
        (COALESCE(1.0 / (60.0 + v.rank), 0.0) + COALESCE(1.0 / (60.0 + t.rank), 0.0))::FLOAT AS score
      FROM vector_ranked v
      FULL OUTER JOIN text_ranked t ON v.id = t.id
    )
    SELECT d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
           d.drive_modified_at, d.drive_created_at, r.score AS similarity
    FROM rrf r
    JOIN documents d ON d.id = r.doc_id
    ORDER BY r.score DESC
    LIMIT match_count;
  END IF;
END;
$$;

-- チャットセッションテーブル
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT '新しいチャット',
  editions   INTEGER[]   DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_idx
  ON chat_sessions (user_email, updated_at DESC);

-- チャットメッセージテーブル
CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  sources    JSONB       NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
  ON chat_messages (session_id, created_at ASC);

DROP TRIGGER IF EXISTS chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER chat_sessions_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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
