// サーバー起動時に必須環境変数を検証する（欠落があれば即座にクラッシュして原因を明示）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const required = [
      "GOOGLE_SERVICE_ACCOUNT_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "NEXTAUTH_SECRET",
    ] as const;

    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(
          `[startup] 必須環境変数 "${key}" が未設定です。.env.local または Vercel の環境変数設定を確認してください。`
        );
      }
    }
  }
}
