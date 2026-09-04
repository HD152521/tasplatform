import Link from "next/link";
import { COLOR, Card } from "./ui.tsx";

export default function NotFound() {
  return (
    <Card style={{ padding: 28 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>찾을 수 없는 케이스입니다</h1>
      <p style={{ color: COLOR.muted, fontSize: 14, lineHeight: 1.7, margin: "0 0 16px" }}>
        아직 수집되지 않았거나 3개월 백필 범위 밖일 수 있습니다.
        <br />
        <code>npm run collect</code> 로 최신 상태를 가져온 뒤 다시 확인하세요.
      </p>
      <Link href="/" style={{ color: COLOR.accent, fontSize: 14, textDecoration: "none" }}>
        ← 케이스 목록으로
      </Link>
    </Card>
  );
}
