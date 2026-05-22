"use client";

import { useState, useRef, useEffect, useTransition } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ fileName: string; edition: number }>;
}

export default function ChatClient({ editions }: { editions: number[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedEdition, setSelectedEdition] = useState<number | "all">("all");
  const [isPending, startTransition] = useTransition();
  const [isSyncing, setIsSyncing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || isPending) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);

    startTransition(async () => {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          edition: selectedEdition === "all" ? null : selectedEdition,
        }),
      });

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "エラーが発生しました。再度お試しください。" },
        ]);
        return;
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, sources: data.sources },
      ]);
    });
  }

  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `同期完了: ${data.processed} 件処理、${data.skipped} 件スキップ、${data.errors} 件エラー`,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `同期エラー: ${data.error}` },
        ]);
      }
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full px-4 py-4 gap-4">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">回次:</label>
        <select
          value={selectedEdition}
          onChange={(e) =>
            setSelectedEdition(
              e.target.value === "all" ? "all" : Number(e.target.value)
            )
          }
          className="text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">全回次</option>
          {editions.map((e) => (
            <option key={e} value={e}>
              第{e}回
            </option>
          ))}
        </select>

        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="ml-auto text-sm px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors disabled:opacity-50"
        >
          {isSyncing ? "同期中..." : "Drive を同期"}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-16">
            質問を入力してください
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-white border border-gray-200 text-gray-800 shadow-sm"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="font-medium">参照資料: </span>
                  {msg.sources.map((s, j) => (
                    <span key={j}>
                      {j > 0 && "、"}
                      {s.fileName}（第{s.edition}回）
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {isPending && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
              <div className="flex gap-1 items-center h-5">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="質問を入力してください..."
          disabled={isPending}
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50"
        />
        <button
          type="submit"
          disabled={!input.trim() || isPending}
          className="px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50"
        >
          送信
        </button>
      </form>
    </div>
  );
}
