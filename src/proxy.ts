export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/chat/:path*", "/api/chat/:path*", "/api/sync/:path*"],
};
