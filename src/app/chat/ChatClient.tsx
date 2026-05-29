"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Source {
  fileName: string;
  edition: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

interface Session {
  id: string;
  title: string;
  editions: number[] | null;
  updated_at: string;
}

export default function ChatClient({
  editions,
  userEmail,
  logoutAction,
}: {
  editions: number[];
  userEmail: string;
  logoutAction: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedEditions, setSelectedEditions] = useState<number[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setSessions(data));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // textarea の高さを内容に合わせて自動調整
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    setMessages([]);
    setSelectedEditions(null);
  }, []);

  async function loadSession(sessionId: string) {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return;
    const data = await res.json();
    setCurrentSessionId(sessionId);
    setMessages(
      (data.messages as Array<{ role: string; content: string; sources: Source[] }>).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        sources: m.sources,
      }))
    );
    setSelectedEditions(data.session.editions ?? null);
  }

  async function deleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (currentSessionId === sessionId) newChat();
  }

  async function saveTitle(sessionId: string) {
    const title = editingValue.trim();
    if (!title) return;
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
    setEditingTitle(null);
  }

  function toggleEdition(edition: number) {
    if (selectedEditions === null) {
      setSelectedEditions([edition]);
    } else if (selectedEditions.includes(edition)) {
      const next = selectedEditions.filter((e) => e !== edition);
      setSelectedEditions(next.length === 0 ? null : next);
    } else {
      const next = [...selectedEditions, edition];
      setSelectedEditions(next.length === editions.length ? null : next);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || isLoading) return;

    setInput("");
    setIsLoading(true);
    // ユーザーメッセージ + 空のアシスタントプレースホルダーを同時追加
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", sources: [] },
    ]);

    const capturedSessionId = currentSessionId;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, editions: selectedEditions, sessionId: currentSessionId }),
      });

      if (!res.ok || !res.body) {
        let errorMsg = `エラーが発生しました。(HTTP ${res.status})`;
        if (res.status === 429) {
          errorMsg = "リクエストが多すぎます。しばらく待ってから再度お試しください。";
        } else {
          try {
            const errData = await res.json() as { error?: string };
            if (errData.error) errorMsg = `エラー: ${errData.error}`;
          } catch {}
        }
        setMessages((prev) => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { role: "assistant", content: errorMsg };
          return msgs;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      const handleEvent = (event: string) => {
        if (!event.startsWith("data: ")) return;
        try {
          const data = JSON.parse(event.slice(6)) as {
            type: string;
            sessionId?: string;
            sources?: Source[];
            text?: string;
            message?: string;
          };

          if (data.type === "meta") {
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], sources: data.sources ?? [] };
              return msgs;
            });
            if (!capturedSessionId && data.sessionId) {
              setCurrentSessionId(data.sessionId);
              // API 再フェッチせず、新セッションをリストの先頭に追加
              setSessions((prev) => [
                {
                  id: data.sessionId!,
                  title: question.length > 40 ? question.slice(0, 40) + "…" : question,
                  editions: selectedEditions,
                  updated_at: new Date().toISOString(),
                },
                ...prev,
              ]);
            } else if (data.sessionId) {
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === data.sessionId ? { ...s, updated_at: new Date().toISOString() } : s
                )
              );
            }
          } else if (data.type === "text") {
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + (data.text ?? ""),
              };
              return msgs;
            });
          } else if (data.type === "error") {
            const errMsg = data.message ? `エラー: ${data.message}` : "エラーが発生しました。";
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = { role: "assistant", content: errMsg };
              return msgs;
            });
          }
        } catch {}
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? "";
        for (const event of events) handleEvent(event);
      }

      // ループ終了後にバッファに残ったイベントを処理
      if (sseBuffer.trim()) handleEvent(sseBuffer.trim());
    } catch {
      setMessages((prev) => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { role: "assistant", content: "エラーが発生しました。" };
        return msgs;
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              res.status === 504 || res.status === 408
                ? "同期がタイムアウトしました。ファイル数が多いためローカルで `npm run sync` を実行してください。"
                : `同期に失敗しました（HTTP ${res.status}）。`,
          },
        ]);
        return;
      }
      const data = await res.json();
      const msg = data.success
        ? `同期完了: ${data.processed} 件処理 / ${data.empty} 件空 / ${data.skipped} 件DB済み / ${data.errors} 件エラー`
        : `同期エラー: ${data.error}`;
      setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `同期失敗: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setIsSyncing(false);
    }
  }

  const editionLabel =
    selectedEditions === null
      ? "全回次"
      : selectedEditions
          .sort((a, b) => b - a)
          .map((e) => `第${e}回`)
          .join("・");

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* ===== サイドバー ===== */}
      <aside
        className={`${
          isSidebarOpen ? "w-64" : "w-0"
        } flex-shrink-0 overflow-hidden transition-all duration-200 bg-gray-900 flex flex-col`}
      >
        <div className="p-4 flex items-center gap-2 border-b border-gray-700">
          <span className="text-lg">🏮</span>
          <span className="font-semibold text-white text-sm truncate">学祭 AI サポーター</span>
        </div>

        <button
          onClick={newChat}
          className="mx-3 mt-3 px-3 py-2 rounded-lg border border-gray-600 hover:bg-gray-700 text-sm text-gray-200 text-left transition-colors flex items-center gap-2"
        >
          <span className="text-lg leading-none">+</span>
          新しいチャット
        </button>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 mt-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => loadSession(s.id)}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                currentSessionId === s.id
                  ? "bg-gray-700 text-white"
                  : "text-gray-300 hover:bg-gray-800"
              }`}
            >
              {editingTitle === s.id ? (
                <input
                  autoFocus
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={() => saveTitle(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle(s.id);
                    if (e.key === "Escape") setEditingTitle(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 bg-gray-600 text-white text-sm rounded px-1 outline-none"
                />
              ) : (
                <span
                  className="flex-1 truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingTitle(s.id);
                    setEditingValue(s.title);
                  }}
                >
                  {s.title}
                </span>
              )}
              <button
                onClick={(e) => deleteSession(s.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 transition-opacity text-xs px-1 flex-shrink-0"
                title="削除"
              >
                ✕
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-4">チャット履歴なし</p>
          )}
        </div>

        <div className="p-4 border-t border-gray-700 flex items-center gap-2">
          <p className="text-xs text-gray-400 truncate flex-1" title={userEmail}>
            {userEmail}
          </p>
          <form action={logoutAction}>
            <button
              type="submit"
              className="text-xs text-gray-500 hover:text-gray-200 transition-colors whitespace-nowrap"
            >
              ログアウト
            </button>
          </form>
        </div>
      </aside>

      {/* ===== メインエリア ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ヘッダー */}
        <header className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center gap-3 flex-shrink-0">
          <button
            onClick={() => setIsSidebarOpen((v) => !v)}
            className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500 transition-colors"
            title="サイドバー切り替え"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* 年度フィルタ */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setSelectedEditions(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                selectedEditions === null
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              全回次
            </button>
            {editions.map((e) => (
              <button
                key={e}
                onClick={() => toggleEdition(e)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedEditions?.includes(e)
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                第{e}回
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-400 hidden sm:block">{editionLabel}</span>
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {isSyncing ? "同期中…" : "Drive 同期"}
            </button>
          </div>
        </header>

        {/* メッセージ一覧 */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            {messages.length === 0 && !isLoading && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <span className="text-5xl mb-4">🏮</span>
                <h2 className="text-xl font-semibold text-gray-700 mb-2">学祭 AI サポーター</h2>
                <p className="text-sm text-gray-400">
                  過去の資料について何でも聞いてください
                </p>
                <p className="text-xs text-gray-300 mt-1">現在: {editionLabel}</p>
              </div>
            )}

            {messages.map((msg, i) => {
              const isStreamingPlaceholder =
                isLoading && i === messages.length - 1 && msg.role === "assistant" && msg.content === "";
              return (
                <div
                  key={i}
                  className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 rounded-full bg-indigo-600 flex-shrink-0 flex items-center justify-center text-white text-xs font-bold mt-0.5">
                      AI
                    </div>
                  )}
                  <div className={`max-w-[78%] flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    <div
                      className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-indigo-600 text-white rounded-br-sm"
                          : "bg-white border border-gray-200 text-gray-800 shadow-sm rounded-bl-sm"
                      }`}
                    >
                      {isStreamingPlaceholder ? (
                        <div className="flex gap-1 items-center h-4">
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                        </div>
                      ) : msg.role === "assistant" ? (
                        <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-headings:text-gray-800 prose-p:text-gray-800 prose-li:text-gray-800 prose-table:text-sm prose-code:text-pink-600 prose-code:bg-gray-100 prose-code:rounded prose-code:px-1 prose-pre:bg-gray-100 prose-pre:rounded-lg">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      )}
                    </div>
                    {msg.role === "assistant" && !isStreamingPlaceholder && (
                      <CopyButton text={msg.content} />
                    )}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1 px-1">
                        {msg.sources.map((s, j) => (
                          <span
                            key={j}
                            className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 truncate max-w-[200px]"
                            title={s.fileName}
                          >
                            📄 {s.fileName}（第{s.edition}回）
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* 入力エリア */}
        <div className="bg-white border-t border-gray-200 px-4 py-3 flex-shrink-0">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              id="chat-input"
              name="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit(e as unknown as React.FormEvent);
                }
              }}
              placeholder="質問を入力… (Enter で送信、Shift+Enter で改行)"
              disabled={isLoading}
              rows={1}
              className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 resize-none"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50 flex-shrink-0"
            >
              送信
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className="text-xs text-gray-400 hover:text-gray-600 transition-colors px-1 py-0.5"
      title="コピー"
    >
      {copied ? "コピー済み" : "コピー"}
    </button>
  );
}
