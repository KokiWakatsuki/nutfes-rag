-- AIエージェント用ファイルブラウジングツール
-- list_files_by_path: フォルダ構造を探索してどんなファイルが存在するかを把握
-- get_file_chunks: 特定ファイルの全チャンクを取得して全文を読む

CREATE OR REPLACE FUNCTION list_files_by_path(
  path_pattern    TEXT,
  filter_edition  INTEGER DEFAULT NULL
)
RETURNS TABLE(file_id TEXT, file_name TEXT, edition INT, folder_path TEXT)
LANGUAGE sql
AS $$
  SELECT DISTINCT ON (d.file_id)
    d.file_id,
    d.file_name,
    d.edition,
    COALESCE(
      substring(d.content FROM '^【フォルダ: ([^】]+)】'),
      ''
    ) AS folder_path
  FROM documents d
  WHERE (filter_edition IS NULL OR d.edition = filter_edition)
    AND (
      d.file_name  ILIKE '%' || path_pattern || '%'
      OR d.content ILIKE '【フォルダ: %' || path_pattern || '%】%'
    )
  ORDER BY d.file_id, d.chunk_index
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION get_file_chunks(
  name_pattern    TEXT,
  filter_edition  INTEGER DEFAULT NULL
)
RETURNS TABLE(id UUID, file_id TEXT, file_name TEXT, edition INT, content TEXT, chunk_index INT)
LANGUAGE sql
AS $$
  SELECT d.id, d.file_id, d.file_name, d.edition, d.content, d.chunk_index
  FROM documents d
  WHERE (filter_edition IS NULL OR d.edition = filter_edition)
    AND d.file_name ILIKE '%' || name_pattern || '%'
  ORDER BY d.file_name, d.chunk_index
  LIMIT 30;
$$;
