-- Drive側の最終更新日時を保存するカラムを追加（差分同期の高速化）
ALTER TABLE documents ADD COLUMN IF NOT EXISTS drive_modified_at TEXT;
