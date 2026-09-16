/** @type {import('next').NextConfig} */
const nextConfig = {
  // playwright 는 서버에서만 쓰는 네이티브 의존성이라 번들링하면 깨진다.
  serverExternalPackages: ["playwright", "playwright-core"],
};
export default nextConfig;
