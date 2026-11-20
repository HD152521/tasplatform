# 설치 · 실행 안내

새 PC 나 서버에서 처음 띄울 때 따라가는 순서.

**`git clone` 만으로는 돌지 않는다.** `.env` 와 `data/` 는 저장소에 없기 때문이다(둘 다
gitignore 대상). 계정 설정과 최초 로그인이 반드시 필요하다.

> **로그인이 두 가지다.** 섞으면 엉뚱한 쪽을 끊는다.
>
> | | 무엇 | 어디서 |
> |---|---|---|
> | **앱 로그인** | 이 도구를 쓰는 **사람** (누가 등록했나·누가 담당인가) | `/signin` · `/signup` |
> | **포털 로그인** | 팀이 공유하는 **브로드컴 계정** 세션 (수집이 이걸로 돈다) | `/login` · `npm run login` |

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
| `SR_SECRET_KEY` | 민감값 암호화 키(32바이트 base64/hex). **계정을 화면에서 관리하려면 필요하다** |
| `SR_APP_URL` | 알림에 붙는 링크. **수집 PC 밖에서 누를 거면 실제 접속 주소로 바꿀 것** |
| `SR_WEBHOOK_URL` | 새 답변·실패 알림. 비워도 동작한다 |
| `OPENAI_API_KEY` | 답변 요약과 SR 보고서용. 비우면 요약이 원문 발췌로 대체된다 |
| `SR_APP_SESSION_DAYS` | 앱 로그인 세션 수명(일). 기본 30 |

> `.env` 는 저장소에 올라가지 않는다. 리눅스라면 `chmod 600 .env` 로 권한을 좁혀 둘 것.

### 비밀번호를 바꿀 때는 화면에서

**`/settings/account` (사이드바 「브로드컴 계정」)** 에서 아이디·비밀번호를 저장할 수 있다.
저장된 값이 `.env` 를 이기므로, **비밀번호 회전 때마다 파일을 고치고 재배포할 필요가 없다.**
`.env` 는 "아직 한 번도 저장하지 않았을 때의 폴백" 으로 남는다.

- 비밀번호는 AES-256-GCM 으로 암호화해 DB(`portal_credentials`)에 넣는다. `SR_SECRET_KEY`
  가 없으면 **저장을 거부한다**(평문으로 떨어지지 않는다).
- 로그인 화면(`/login`)에서 「이 계정을 자동 로그인에 쓰기」를 켠 채 로그인해도 같은
  곳에 저장된다. 비밀번호를 바꾼 직후에 쓰는 가장 짧은 경로다.
- 웹과 수집기가 같은 DB 를 보므로 한 번만 저장하면 양쪽에 반영된다.

### 틀린 비밀번호로 계정이 잠기지 않게

자동 로그인이 **연속 2번 실패하면 멈춘다. 그리고 스스로 다시 시도하지 않는다.**
이게 없으면 수집기가 15분마다 틀린 비밀번호를 보내 공용 계정을 잠근다.

시간이 지나도 풀리지 않는 이유: 비밀번호가 틀린 상태는 시간이 지나도 그대로다. 몇 시간
뒤에 혼자 다시 찔러 보면 IdP 의 실패 카운터만 한 칸 더 올라간다. 고칠 수 있는 것은
사람뿐이므로, 사람이 손을 쓸 때까지 가만히 있는다(멈춘 사실은 웹훅 알림으로 나간다).

**다시 시작하는 방법 — 전부 사람의 동작이다.**

| 동작 | 결과 |
|---|---|
| `/settings/account` 에서 새 비밀번호 저장 | 처음부터 다시 센다(2회) |
| `/login` 에서 직접 로그인 성공 | 처음부터 다시 센다 |
| 「비밀번호 그대로 한 번만 다시 시도」 | **한 번만** 시도하고, 실패하면 즉시 다시 멈춘다 |

- OTP 를 요구받은 회차는 **실패로 세지 않는다** — 비밀번호가 통과했다는 뜻이다.
- 비밀번호를 **제출하지 못한** 실패(입력칸 못 찾음·DNS 등)는 세지 않는다. 망 장애가
  계정 차단으로 번지면 안 된다.
- "계정 잠김 / 비밀번호 만료" 문구가 보이면 한 번에 멈춘다(더 찔러 봐야 손해).
- 상태는 `/settings/account` 와 `npm run check:session` 에서 볼 수 있다.
- 한도는 `SR_LOGIN_FAIL_LIMIT` 로 조정한다(기본 2).

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

## 3-1. 앱 계정 만들기 (사람이 1회)

포털 로그인과 **별개**다. 이 계정이 "누가 등록했고 누가 담당인가" 를 채운다 — 감사
로그의 `actor`, 캘린더의 담당자·작성자가 전부 이 신원을 쓴다.

1. 뷰어를 띄우고 `/signup` 에 들어간다.
2. **처음 들어온 사람**은 초대 코드 없이 가입되고, 기본 팀의 **관리자(owner)** 가 된다.
   코드는 로그인해야 보이는 값이라, 아무도 없을 때 요구하면 아무도 못 들어온다.
3. 그 사람이 `/team` 에서 **초대 코드**를 만들어 팀원에게 전달한다. 그 뒤부터는 코드가
   있어야 가입된다. 코드를 지우면 가입이 닫힌다.

- 비밀번호는 `node:crypto` 의 scrypt 해시로만 저장한다(원문은 어디에도 없다).
- 세션 쿠키 값도 **해시만** DB 에 둔다. 로그아웃은 쿠키 삭제가 아니라 세션 해지다.
- 비밀번호를 바꾸면 **모든 기기에서 로그아웃**된다.
- 로그인하지 않으면 모든 화면이 `/signin` 으로 보낸다. **API 는 막지 않는다** —
  수집기 VM 과 worker 가 부르는 주소가 있어서다(그쪽은 팀 토큰으로 가린다).

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

## 5-1. 팀 캘린더 — 한 줄로 등록

`/calendar` 에서 일정을 **한 줄**로 적는다.

```
11/25 방화벽 점검 @용식 #점검
내일 14:00-16:00 VCF 패치 @민수 #작업
25~27 정기점검 준비
방화벽 룰 정리                      ← 날짜가 없으면 왼쪽에 보이는 날짜
```

| 조각 | 규칙 |
|---|---|
| 날짜 | `오늘`·`내일`·`모레`·`어제`, `M/D`, `M/D~M/D`, `M/D~D`, `D~D`(이번 달), `YYYY-MM-DD` |
| 시간 | `HH:MM` 또는 `HH:MM-HH:MM`. 없으면 종일 |
| 담당 | `@이름` — 팀원 이름/아이디와 맞춘다(성을 떼도 맞는다). 여럿이 걸리면 맞추지 않고 글자만 남긴다 |
| 종류 | `#점검` `#작업` `#장애` `#회의` `#휴가` … 목록에 없는 것도 된다 |
| 제목 | 나머지 전부 |

입력칸 **아래 미리보기**가 파싱 결과를 말한다(`11/25(수) · 종일 · 점검 · 담당 용식`).
틀리게 읽었으면 Enter 전에 보인다.

조작: 날짜 칸 클릭 → 그 날짜로 입력칸 맞춤 · 일정 클릭 → 상세·메모 · 동그라미 클릭 →
예정→진행→완료 · 키보드 `n`(입력) `←``→`(달) `t`(오늘) `Esc`(닫기).

### 주간 정리

캘린더 화면 아래 「주간 정리」 카드에서 그 주의 일정과 **작업 메모**를 모아 사람별로
정리한다. 일정을 눌러 메모를 남겨 두면 그 내용이 그대로 들어간다.

- **LLM 이 없거나 실패해도 정리는 나온다**(집계 기반). 어느 쪽으로 만들어졌는지 화면이 말한다.
- 「집계만」 을 누르면 LLM 을 아예 쓰지 않는다.
- 같은 주를 다시 만들면 **덮어쓴다**(쌓이지 않는다).
- 화면에 들어오면 "지난 주 정리가 없으면" 한 번 자동으로 만든다(주당 1회).
  cron 을 들이지 않은 이유: 이 레포의 웹은 스스로 깨어나지 않는다.

### Jira 연동 (선택)

`JIRA_AUTO_CREATE=1` 이면 일정이 Jira 이슈로 따라 올라간다. **꺼져 있어도 캘린더는
그대로 동작한다.**

| 캘린더 | Jira |
|---|---|
| 등록 | 이슈 생성(제목·기간·담당자·본문 + 앱으로 돌아오는 링크) |
| 수정 | `summary`·기한·시작일·담당자 갱신 |
| 상태 변경 | **상태 전이**(가능한 전이를 조회해 이름으로 고른다) |
| 삭제 | **이슈 삭제** ⚠ 되돌릴 수 없다 |

- 담당자를 Jira 에 넣으려면 각자 `/team` 에서 **Jira 계정 id(accountId)** 를 넣어야
  한다. 없으면 담당자 없이 올라가고, 화면이 그 사실을 알려 준다.
- 전이 이름 후보는 `JIRA_TR_DOING`/`JIRA_TR_DONE`/`JIRA_TR_CANCELED` 로 늘린다.
  후보가 워크플로에 하나도 없으면 **전이를 건너뛰고** 사유를 일정에 적는다.
- 이슈를 지울 권한이 없으면 지우지 않고 "앱에서 삭제됨" 코멘트를 남긴다.
- 같은 일정으로 이슈가 **둘 생기지 않는다**: 생성 시 `SRHUB_EVT_<id>` 라벨을 함께 올리고,
  타임아웃으로 "만들어졌는지 모르는" 상태가 되면 다음 시도에서 그 라벨로 찾아 연결한다.

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
