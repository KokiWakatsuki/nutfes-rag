-- word_similarity(query, content) の関数形式は GIN インデックスを使えず全行スキャンになる。
-- 演算子形式 query_text %>> content を使うことで GIN インデックスが有効になる。
-- SET LOCAL で閾値を設定し、インデックス検索に反映させる。

DROP FUNCTION IF EXISTS match_documents(vector, INT, INTEGER[], TEXT);

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
