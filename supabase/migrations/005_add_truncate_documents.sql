-- reindex スクリプト用: documents テーブルを高速全削除する RPC 関数
-- delete().not() はデフォルト1000行制限があるため TRUNCATE を使う
create or replace function truncate_documents()
returns void
language plpgsql
security definer
as $$
begin
  truncate table documents;
end;
$$;
