-- ベクトルインデックスを IVFFlat → HNSW に切り替え（精度・速度向上、Supabase公式推奨）
DROP INDEX IF EXISTS documents_embedding_idx;

CREATE INDEX IF NOT EXISTS documents_embedding_hnsw
  ON documents USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- ファイル名の ILIKE 検索を GIN インデックスで高速化
CREATE INDEX IF NOT EXISTS documents_file_name_trgm
  ON documents USING GIN(file_name gin_trgm_ops);

-- 改良版 match_documents
-- 検索戦略:
--   1. ファイル名にクエリのいずれかのキーワードが含まれるファイルを特定（ILIKE）
--   2. ベクトル検索（HNSW）で広めに候補を取得
--   3. ファイル名マッチしたチャンクに +2.0 ボーナス（ベクトル類似度の最大値 1.0 を大きく上回る）
--   4. マッチしたがベクトル上位に入らなかったチャンクも補完
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
  IF query_text IS NULL OR length(trim(query_text)) < 2 THEN
    -- ベクトル検索のみ
    RETURN QUERY
    SELECT d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
           d.drive_modified_at, d.drive_created_at,
           (1 - (d.embedding <=> query_embedding))::FLOAT AS similarity
    FROM documents d
    WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
      AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
  ELSE
    RETURN QUERY
    WITH
    -- Step 1: スペース区切りで各キーワードをファイル名に ILIKE 検索
    --         "43回 執行部 実行委員" → いずれかが含まれるファイルを抽出
    fname_files AS (
      SELECT DISTINCT d.file_id
      FROM documents d,
           unnest(string_to_array(trim(query_text), ' ')) AS term
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND length(trim(term)) >= 2
        AND d.file_name ILIKE '%' || trim(term) || '%'
    ),
    -- Step 2: ベクトル検索で広めに候補を取得（HNSW インデックス使用）
    vector_ranked AS (
      SELECT d.id, d.file_id,
             (1 - (d.embedding <=> query_embedding))::FLOAT AS vec_sim
      FROM documents d
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND d.embedding IS NOT NULL
      ORDER BY d.embedding <=> query_embedding
      LIMIT match_count * 8
    ),
    -- Step 3: ファイル名マッチしたがベクトル上位に入らなかったチャンクを補完
    fname_extra AS (
      SELECT d.id, d.file_id,
             (1 - (d.embedding <=> query_embedding))::FLOAT AS vec_sim
      FROM documents d
      JOIN fname_files ff ON d.file_id = ff.file_id
      WHERE d.embedding IS NOT NULL
        AND (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND d.id NOT IN (SELECT id FROM vector_ranked)
      ORDER BY d.embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    -- Step 4: スコア統合
    --   ファイル名マッチ: +2.0 ボーナス（ベクトル類似度 max=1.0 を大きく上回り必ず上位へ）
    --   それ以外: ベクトル類似度のみ
    merged AS (
      SELECT v.id,
             CASE WHEN ff.file_id IS NOT NULL THEN 2.0 ELSE 0.0 END + v.vec_sim AS score
      FROM vector_ranked v
      LEFT JOIN fname_files ff ON v.file_id = ff.file_id

      UNION ALL

      SELECT fe.id, 2.0 + fe.vec_sim AS score
      FROM fname_extra fe
    )
    SELECT d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
           d.drive_modified_at, d.drive_created_at, m.score AS similarity
    FROM merged m
    JOIN documents d ON d.id = m.id
    ORDER BY m.score DESC
    LIMIT match_count;
  END IF;
END;
$$;
