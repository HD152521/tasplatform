# 설치 · 실행 안내

새 PC 나 서버에서 처음 띄울 때 따라가는 순서.

**`git clone` 만으로는 돌지 않는다.** `.env` 와 `data/` 는 저장소에 없기 때문이다(둘 다
gitignore 대상). 계정 설정과 최초 로그인이 반드시 필요하다.

---

## 0. 준비물

| 항목 | 요구 | 이유 |
|---|---|---|
| Node.js | **24 이상** | `node:sqlite` 내장 모듈, `.ts` 직접 실행(type stripping) |
| Chromium | Playwright 로 설치 | 로그인 경로가 브라우저를 쓴다 |
| Broadcom 포털 계정 | 필수 | 수집·조회 전부 이 계정으로 한다 |
| 디스크 | 100MB 정도 | DB 가 케이스 300건 기준 약 17MB |

```bash
node -v      # v24.x 이상인지 먼저 확인
```

22 이하면 `node:sqlite` 가 없거나 실험적이라 그대로는 실행되지 않는다.

---

## 1. 내려받기 · 설치

```bash
git clone https://github.com/HD152521/tasplatform.git
cd tasplatform
npm ci
npx playwright install chromium        # 리눅스는 --with-deps 로 시스템 의존성까지
```

---

## 2. 설정 (`.env`)

`.env.example` 을 복사해서 채운다.

```bash
cp .env.example .env
```

최소한 이것만 있으면 돈다.

```ini
SR_USERNAME=<포털 계정>
SR_PASSWORD=<비밀번호>
```

| 키 | 설명 |
|---|---|
| `SR_USERNAME` / `SR_PASSWORD` | 비우면 자동 로그인이 동작하지 않고, 세션이 끊길 때마다 사람이 로그인해야 한다 |
| `SR_APP_URL` | 알림에 붙는 링크. **수집 PC 밖에서 누를 거면 실제 접속 주소로 바꿀 것** |
| `SR_WEBHOOK_URL` | 새 답변·실패 알림. 비워도 동작한다 |
| `OPENAI_API_KEY` | 답변 요약과 SR 보고서용. 비우면 요약이 원문 발췌로 대체된다 |

> `.env` 는 저장소에 올라가지 않는다. 리눅스라면 `chmod 600 .env` 로 권한을 좁혀 둘 것.

---

## 3. 최초 로그인 (사람이 1회)

`data/` 가 비어 있으므로 세션이 없다. **이 단계에서만 OTP(이메일 인증 코드)가 필요하다.**

### 화면이 있는 PC

```bash
npm run login
```

브라우저 창이 뜬다. 계정이 `.env` 에 있으면 아이디·비밀번호는 자동으로 채워지고, OTP 를
요구받으면 직접 입력하면 된다.

### 화면이 없는 서버

GUI 없이도 된다. 웹 UI 의 2단계 로그인을 쓴다.

```bash
npm run build && npm start
```

브라우저로 `http://<주소>:3000/login` 에 접속해 계정을 넣고, OTP 화면이 뜨면 메일로 온
코드를 그 화면에 입력한다. 서버에는 창이 뜨지 않는다.

### 성공하면

`data/session.json` 과 `data/device.json` 이 생긴다.

- `session.json` — 포털 세션(약 12시간)
- `device.json` — **기기 신뢰 표식(약 1년).** 이게 있으면 이후 재로그인에 OTP 를 묻지 않는다

> `device.json` 은 사실상 자격증명이다. 비밀번호와 같은 급으로 다루고 공유 폴더나 백업에
> 딸려 들어가지 않게 할 것.

---

## 4. 첫 수집

```bash
node collector/collect.ts
```

처음에는 종료 케이스 3개월치를 백필하므로 시간이 좀 걸린다. 이후 회차는 5~10초.

```
수집 완료
  케이스 291건 조회 / 변경 0건
  새 답변 0건
```

`--dry-run` 을 붙이면 DB 에 쓰지 않고 조회만 한다.

---

## 5. 뷰어 실행

```bash
npm run build
npm start              # http://localhost:3000
```

포트를 바꾸려면 `npm start -- -p 3100`.

개발 중이 아니라면 `npm run dev` 는 쓰지 말 것. 페이지마다 컴파일하느라 느리고 메모리를
훨씬 많이 쓴다(워커 프로세스가 OOM 으로 죽는 일이 있다).

---

## 6. 수집 자동화

### Windows — 작업 스케줄러

```powershell
powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1
# 기본값: 08~20시, 15분마다
# 주기 변경: -IntervalMinutes 30
# 제거:     -Remove
```

### 리눅스 — systemd timer

`scripts/schedule.ps1` 은 Windows 전용이다. 리눅스에서는 아래처럼 만든다.

```ini
# /etc/systemd/system/sr-collect.service
[Service]
Type=oneshot
WorkingDirectory=/opt/tasplatform
ExecStart=/usr/bin/node collector/collect.ts
TimeoutStartSec=600
```

```ini
# /etc/systemd/system/sr-collect.timer
[Timer]
OnCalendar=*:0/15
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now sr-collect.timer
```

`TimeoutStartSec` 을 꼭 넣을 것. 수집이 멈춰도 시간이 지나면 강제 종료된다.

---

## ⚠ 계정 하나를 여러 곳에서 돌리지 말 것

포털 계정을 공유하므로 **수집기는 한 대에서만** 돌아야 한다. 두 곳에서 돌리면 세션을
서로 밀어내 양쪽 다 깨진다.

서버로 옮긴다면 기존 PC 의 스케줄을 먼저 끌 것.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Remove
```

---

## 자주 겪는 문제

| 증상 | 원인과 조치 |
|---|---|
| `node:sqlite` 관련 오류 | Node 24 미만이다. 업그레이드할 것 |
| 로그인이 OTP 를 계속 요구 | `data/device.json` 이 없거나 만료. 3단계를 다시 한다 |
| `세션이 만료되어...재로그인합니다` 후 실패 | `.env` 의 계정·비밀번호 확인. **비밀번호를 바꿨다면 `.env` 도 갱신해야 한다** |
| 수집이 조용히 안 돈다 | 멈춘 프로세스가 락을 쥐고 있을 수 있다. 아래 확인 |
| 뷰어에서 컴파일 오류·워커 크래시 | `npm run dev` 로 돌고 있고 메모리가 부족한 경우다. `npm start` 로 바꿀 것 |

### 멈춘 수집기 확인·복구

```powershell
# 경과 시간이 크면 정체된 것
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*collect*' } |
  ForEach-Object {
    $p = Get-Process -Id $_.ProcessId
    "[$($_.ProcessId)] 경과 $([math]::Round(((Get-Date)-$p.StartTime).TotalMinutes,1))분"
  }

# 복구
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*collect*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item data\collector.lock -ErrorAction SilentlyContinue
node collector/collect.ts
```

로그가 `data/collect.log` 에 쌓이지 않는다면, 멈춘 프로세스가 로그 파일 핸들을 쥐고
있다는 신호다.

---

## 참고

- 검증: `npm run typecheck`, `npm test`
- 수집 로그: `data/collect.log`
- 상세한 로그인·세션 트러블슈팅은 별도 문서로 관리한다
