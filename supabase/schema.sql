-- pgvector 拡張を有効化
CREATE EXTENSION IF NOT EXISTS vector;

-- ドキュメントテーブル
CREATE TABLE IF NOT EXISTS documents (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id     TEXT        NOT NULL,
  file_name   TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  edition     INTEGER     NOT NULL,
  drive_id    TEXT        NOT NULL,
  embedding   vector(768),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- file_id にユニーク制約（1ファイル = 1レコード、チャンクは content で区別）
-- チャンク対応のため file_id + content でユニークにする
CREATE UNIQUE INDEX IF NOT EXISTS documents_file_id_content_idx
  ON documents (file_id, md5(content));

-- ベクトル検索用インデックス（コサイン類似度）
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 回次検索用インデックス
CREATE INDEX IF NOT EXISTS documents_edition_idx ON documents (edition);

-- 類似ドキュメント検索関数
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(768),
  match_count     INT,
  filter_edition  INT DEFAULT NULL
)
RETURNS TABLE (
  id        UUID,
  file_id   TEXT,
  file_name TEXT,
  content   TEXT,
  edition   INT,
  drive_id  TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.file_id,
    d.file_name,
    d.content,
    d.edition,
    d.drive_id,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE (filter_edition IS NULL OR d.edition = filter_edition)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- updated_at を自動更新するトリガー
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
