-- pgvector 拡張を有効化
CREATE EXTENSION IF NOT EXISTS vector;

-- ドキュメントテーブル
CREATE TABLE IF NOT EXISTS documents (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id          TEXT        NOT NULL,
  chunk_index      INTEGER     NOT NULL DEFAULT 0,
  file_name        TEXT        NOT NULL,
  content          TEXT        NOT NULL,
  edition          INTEGER     NOT NULL,
  drive_id         TEXT        NOT NULL,
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

-- ベクトル検索関数（初期版）
DROP FUNCTION IF EXISTS match_documents(vector, INT, INT);
DROP FUNCTION IF EXISTS match_documents(vector, INT, INTEGER[]);

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(768),
  match_count     INT,
  filter_editions INTEGER[] DEFAULT NULL
)
RETURNS TABLE (
  id         UUID,
  file_id    TEXT,
  file_name  TEXT,
  content    TEXT,
  edition    INT,
  drive_id   TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
    (1 - (d.embedding <=> query_embedding))::FLOAT AS similarity
  FROM documents d
  WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
    AND d.embedding IS NOT NULL
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
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
