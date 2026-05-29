-- ファイル名/フォルダ名マッチのボーナスを +2.0 → +4.0 に強化
-- ベクトル類似度の最大値は 1.0 のため、+4.0 のボーナスは
-- ファイル名マッチしたファイルを非マッチファイルに対して圧倒的に優先する。
-- 「執行部」のような重要語がファイル名/フォルダに含まれる場合、
-- 他の43回資料に埋もれず必ず上位に来るようになる。

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
    fname_files AS (
      SELECT DISTINCT d.file_id
      FROM documents d,
           unnest(string_to_array(trim(query_text), ' ')) AS term
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND length(trim(term)) >= 2
        AND (
          d.file_name ILIKE '%' || trim(term) || '%'
          OR left(d.content, 200) ILIKE '%' || trim(term) || '%'
        )
    ),
    vector_ranked AS (
      SELECT d.id AS doc_id, d.file_id,
             (1 - (d.embedding <=> query_embedding))::FLOAT AS vec_sim
      FROM documents d
      WHERE (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND d.embedding IS NOT NULL
      ORDER BY d.embedding <=> query_embedding
      LIMIT match_count * 8
    ),
    fname_extra AS (
      SELECT d.id AS doc_id, d.file_id,
             (1 - (d.embedding <=> query_embedding))::FLOAT AS vec_sim
      FROM documents d
      JOIN fname_files ff ON d.file_id = ff.file_id
      WHERE d.embedding IS NOT NULL
        AND (filter_editions IS NULL OR d.edition = ANY(filter_editions))
        AND d.id NOT IN (SELECT vr.doc_id FROM vector_ranked vr)
      ORDER BY d.embedding <=> query_embedding
      LIMIT match_count * 4
    ),
    merged AS (
      SELECT v.doc_id,
             CASE WHEN ff.file_id IS NOT NULL THEN 4.0 ELSE 0.0 END + v.vec_sim AS score
      FROM vector_ranked v
      LEFT JOIN fname_files ff ON v.file_id = ff.file_id

      UNION ALL

      SELECT fe.doc_id, 4.0 + fe.vec_sim AS score
      FROM fname_extra fe
    )
    SELECT d.id, d.file_id, d.file_name, d.content, d.edition, d.drive_id,
           d.drive_modified_at, d.drive_created_at, m.score AS similarity
    FROM merged m
    JOIN documents d ON d.id = m.doc_id
    ORDER BY m.score DESC
    LIMIT match_count;
  END IF;
END;
$$;
