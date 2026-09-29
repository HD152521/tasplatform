# 첨부 업로드 · 동기화 · 배포 막힘 — 계획서

작성 2026-09-28.

실제 케이스 번호·계정·파일명은 적지 않는다(이 저장소는 공개). `<site>` `<case>` `<파일명>` 으로 둔다.

---

## 0. 지금 막혀 있는 것 — 이것부터 풀어야 한다

**완성된 기능 셋이 배포를 못 타고 있다.** GitLab CI 의 `test` 잡이 1건 실패하고,
`test` 는 `deploy` 앞 단계라 실패하면 `deploy_worker` 도 `deploy_tas` 도 **실행조차 안 된다.**

```
stages: [test, deploy]
```

| PR | 내용 | 상태 |
|---|---|---|
| #24 | 세션 hydrate · 답변 실패 메시지 · 새 SR 본문 표시 | main 에 있음, **배포 안 됨** |
| #25 | 제목 대괄호 검증 · 지금 수집 버튼 | main 에 있음, **배포 안 됨** |

그래서 아래 두 증상이 계속 난다.

- 세션이 만료되면 여전히 VM `npm run refresh` + 웹 `cf restart` 수작업이 필요하다
- 진행중 페이지에 `지금 수집` 버튼이 안 보인다

### 무엇을 알아야 하나

실패한 테스트 **이름 한 줄**. GitLab 잡 로그에서 `not ok` 를 찾으면 나온다.

알아낸 것:

- 로컬(Windows)에서는 559건 전부 통과한다 → 코드 자체의 결함이 아니라 **환경 차이**다
- CI 의 `8 skipped` 는 정상이다(캡처 픽스처 없는 7건 + Postgres 1건)
- VM 의 앱 디렉터리에서 돌리면 통과한다 — 그곳은 배포된 **옛 코드**라 의미가 없다

### 의심 순서

1. **시간대** — CI 러너가 UTC 면 깨지는 테스트가 있는지. `TZ=UTC npm test` 로 로컬에서 재현되는지 먼저 본다(아직 안 돌려 봤다)
2. **환경변수 누수** — `scripts/test.mjs` 는 DB 관련 변수만 지우고 `OPENAI_API_KEY`·`LLM_BASE_URL` 은 **안 지운다.** VM 러너 셸에 그 값이 export 돼 있으면 "LLM 연결 없음" 을 기대하는 테스트가 깨진다
3. **경로 표기** — Windows/리눅스 차이

2번이면 `scripts/test.mjs` 의 제거 목록에 LLM 변수를 더하는 것으로 끝난다. 테스트를
고치는 것이 아니라 **밀폐를 늘리는** 쪽이라 안전하다.

---

## 1. 첨부 업로드

### 알아낸 것 — 포털이 아니라 supportftp 다

캡처(361건) 결과, 첨부는 Wolken 포털로 가지 않는다. `supportftp.broadcom.com`(CrushFTP)에
올라가고, **포털에는 아무것도 알리지 않는다.** 업로드 뒤 포털로 나간 POST 가 한 건도 없다.

그래서 `lib/reply.ts` 의 `"fileAttach": []` 는 비어 있는 게 맞다 — 그 배열은 이 경로와 무관하다.

### 흐름

```
GET  /WebInterface/redirect.html?site=<site>&case=<case>
       → access.broadcom.com OAuth → /_codexch → 302 /<site>/<case>/
POST /WebInterface/function/   command=getUsername      ← 세션이 이 케이스로 묶였는지 확인
POST /WebInterface/function/   command=getXMLListing    ← 올릴 폴더 확인
POST /WebInterface/function/   command=openFile         ← 업로드 시작
POST /U/<upload_id>~<n>~<len>  ← 512KB 조각, 1부터, 마지막만 작다
POST /WebInterface/function/   command=closeFile        ← 응답에 md5
```

세션이 **케이스 단위로 묶인다.** `getUsername` 응답이 `…,^<site>^<case>^` 를 돌려준다.
그래서 올리기 전에 반드시 `redirect.html?site=&case=` 를 거쳐야 한다. 쿠키만 있다고 되지 않는다.

### 올릴 위치

```
/<site>/<case>/files_from_customer/<파일명>
```

루트 폴더는 쓰기 권한이 없다(`getXMLListing` 이 "먼저 폴더를 고르라" 는 안내를 돌려준다).
`files_from_customer` 의 권한은 `(read)(write)(view)(delete)(rename)(resume)` 다.

`<site>` 는 이미 DB 에 있다 — `cases.party_site_number`. `<case>` 는 `cases.request_id` 다.
새로 받아올 것이 없다.

### 파라미터

```
openFile    command, c2f, upload_path, upload_size, upload_id, start_resume_loc, random
closeFile   command, c2f, upload_id, total_chunks, total_bytes, filePath, lastModified, random
```

- `upload_id` 는 클라이언트가 만든다(openFile 요청에 이미 들어 있고 응답이 그대로 돌려준다)
- `random` 은 캐시 회피용 난수
- `c2f=Bb30` 은 캡처 26건 전부 같은 값이었다. 상수인지 세션마다 바뀌는지는 **확인 안 됨**
- `closeFile` 응답의 md5 로 무결성을 확인할 수 있다
- 조각 크기 512KB, 인덱스는 1부터. 마지막 조각만 작다

### 막힌 곳 — 케이스 묶기 (2026-09-28 실측)

**CrushFTP 세션은 한 번에 케이스 하나에만 묶인다.** `getUsername` 이
`<계정>,^<site>^<case>^` 를 돌려주는데, 그 묶임은 **브라우저 OAuth 왕복**에서 정해진다.

실측한 것:

- 이미 다른 케이스로 묶인 상태에서 `redirect.html?site=&case=` 를 불러도 302 없이 200 만
  돌아오고 묶임이 바뀌지 않는다
- `command=logout` 으로 끊으면 **서버 쪽 세션까지 죽는다.** 그 뒤 `/` 는 login.html 로
  튕기고, `redirect.html` 은 여전히 OAuth 로 안 보낸다 — `fetch` 로는 다시 못 묶는다
- 즉 웹 컨테이너(브라우저 없음)에서는 **로그인 시점에 묶인 그 케이스에만** 올릴 수 있다

그래서 라우트와 화면 버튼은 올리지 않았다. 지금 배포하면 버튼이 거의 항상 실패한다.
프로토콜 구현(lib/crushftp.ts)과 테스트는 남겨 둔다 — 막힌 건 묶기 한 단계뿐이다.

### 결정적 사실 — CrushFTP 로그인에는 브라우저가 필요하다 (2026-09-28 실측)

`redirect.html?site=&case=` 는 302 가 아니라 **자바스크립트로 이동시키는 200 HTML** 이다.

    if (!url) url = window.location.href;
    function redirect() { $(location).attr("href", url); }

`fetch` 는 이 이동을 따라갈 수 없다. 그래서 웹 컨테이너에서는 CrushFTP 에 **로그인 자체가
안 된다.** 갓 로그인한(`npm run login --auto`) 세션으로 확인한 결과:

    getUsername    200  이지만 success 아님,  묶인 케이스 없음
    getXMLListing  404  (인증 안 된 호출)

**이것이 첨부 다운로드가 안 되던 진짜 이유이기도 하다.** lib/attachmentWarmup.ts 는
쿠키만 받아올 뿐 로그인을 끝내지 못한다. allow-list·쿠키 단지·예열을 붙여도 막힌 곳은
거기가 아니었다.

### 그래서 첨부는 수집기(VM)가 다룬다

VM 에는 Playwright 가 있어 JS 이동을 따라갈 수 있다. 업로드와 다운로드 **둘 다** 같은 길을 쓴다.

    업로드    화면에서 파일 → DB 에 잠깐 보관 → worker 가 브라우저로 케이스에 진입해 올림
    다운로드  worker 가 브라우저로 받아 두고, 웹은 그것을 내려줌

요청 전달은 `지금 수집` 이 만든 구조(app_state)를 그대로 쓴다.

주의할 점:

- 파일이 DB 를 거친다. 크기 상한을 낮게 잡는다(수 MB). 큰 것은 포털에서 직접 올리게 둔다
- 올린 뒤 DB 에서 지운다. 케이스 첨부가 DB 에 쌓이면 안 된다
- 브라우저 한 번 띄우는 데 수십 초가 든다. 사람이 기다리므로 진행 상태를 계속 보여준다
- lib/crushftp.ts 의 프로토콜은 그대로 쓸 수 있다 — 브라우저로 **로그인만** 하고,
  그 컨텍스트의 쿠키로 openFile/조각/closeFile 을 보내면 된다

### 0단계 확인 결과 — 브라우저로 하면 전부 된다 (2026-09-28 실측)

Playwright 컨텍스트(저장된 세션)로 `redirect.html?site=&case=` 에 이동한 뒤 잰 값이다.
읽기 명령만 썼다.

    [1차]  케이스 A   (10.7초)   getUsername success=true, 묶임=A
                                 privs=(read)(write)(view)(delete)(rename)(resume)(slideshow)
    [2차]  케이스 B   ( 5.9초)   getUsername success=true, 묶임=B      ← 같은 컨텍스트에서 다시 이동만

확인된 것:

- 브라우저로 들어가면 **진짜 인증된 세션**이 나온다(success=true)
- **케이스를 바꾸려고 logout 할 필요가 없다.** 같은 컨텍스트에서 다시 이동하면 다시 묶인다.
  앞서 서버에서 logout 이 필요해 보였던 것은 fetch 로 하려다 생긴 착시였다
- `files_from_customer` 에 **(write) 권한이 온다**
- 고객사가 다른 케이스로 넘어가도 된다
- 첫 진입 10초, 이후 6초. 브라우저를 한 번 띄워 두고 여러 건을 처리하는 편이 낫다

따라서 계획대로 진행할 수 있다. 1단계(작업 전달 틀) → 2단계(다운로드) → 3단계(업로드).

### 다음 후보

1. **수집기(VM)가 올린다.** 브라우저가 있으니 케이스별 OAuth 묶기를 할 수 있다.
   화면은 파일을 DB 에 잠깐 두고 `지금 수집` 과 같은 방식으로 요청을 넘긴다.
   파일이 DB 를 거치는 것이 걸리지만, 확실히 동작하는 유일한 길이다.
2. **로그인 때 케이스를 지정해 묶는다.** 한 번에 하나뿐이라 실용성이 없다.
3. 포털에 업로드 API 가 따로 있는지 더 찾아본다. 캡처 361건에는 없었다.

1번을 권한다. 다만 파일 크기 상한을 낮게 잡아야 한다(수 MB).

---

## 2. 올린 파일이 우리 화면에 안 보이는 것

### 왜 안 보이나

`attachments` 테이블은 **포털 스레드에서만** 채워진다(`toAttachmentRows(thread)`).
supportftp 에 직접 올린 파일은 스레드를 만들지 않으므로 우리 DB 에 들어올 길이 없다.
수집을 아무리 돌려도 안 보인다. 버그가 아니라 경로가 없는 것이다.

### 고치는 방법

supportftp 폴더를 직접 읽는다. 업로드에 쓰는 것과 **같은 명령**이다.

```
POST /WebInterface/function/   command=getXMLListing, format=JSONOBJ, path=/<site>/<case>/
```

- 수집 회차에서 케이스마다 부르면 요청이 케이스 수만큼 늘어난다. **변경된 케이스에 대해서만** 부른다
- 우리가 올린 것(`files_from_customer`)과 상대가 준 것(다른 폴더)을 구분해 표시한다
- `attachments` 에 출처 칸을 더하거나(`source: 'thread' | 'ftp'`) 별도 테이블로 둔다.
  전자가 화면을 덜 건드린다

이 일은 **1번이 끝난 뒤에 한다.** 같은 세션·같은 명령을 쓰므로 `lib/crushftp.ts` 가
먼저 있어야 중복이 안 생긴다.

---

## 3. 자동 세션 동기화

**코드는 이미 있다(PR #24).** 배포만 안 됐다. 0번이 풀리면 끝난다.

내용: hydrate 가 "파일이 있으면 그대로 둔다" 에서 "파일이 없거나 **못 쓰면**(SSO 만료)
DB 에서 가져온다" 로 바뀌었다. 웹 재시작이 필요 없어진다.

### 그래도 남는 것

SSO 세션은 약 12시간이고, 쓰기 경로는 브라우저를 띄우지 않는다(사람이 앞에서 기다리는
구간이라). 그래서 **12시간마다 누군가 VM 에서 로그인해야 하는 것은 그대로다.**

다음 단계 후보 — 아직 안 정했다:

1. **worker 가 주기적으로 세션을 갱신한다.** 수집 회차마다 이미 재로그인하므로, 만료가
   가까우면 미리 갱신하게 한다. 사람 손이 아예 빠진다. 가장 나아 보인다
2. 화면에 "세션 갱신" 버튼을 둔다 — `지금 수집` 과 같은 방식(DB 로 요청 → worker 가 수행).
   1번이 되면 필요 없다
3. 웹에서 직접 로그인 — 웹에 Playwright 가 없어 불가능하다

1번을 권한다. `지금 수집` 버튼이 만든 구조(app_state 로 요청을 넘기는 것)를 그대로 쓸 수 있다.

---

## 4. 지금 수집 버튼

**코드는 이미 있다(PR #25).** 배포만 안 됐다. 0번이 풀리면 끝난다.

구조: 버튼이 `app_state` 에 요청 시각을 남기고, worker 가 자는 동안 15초마다 보고
집어가 한 회차를 돌린다. 화면은 폴링으로 `요청함 → 수집 중 → 완료(새 답변 N건)` 를 보여준다.

### 배포 후 확인할 것

- 진행중 페이지에 버튼이 보이나 → web 배포됨
- 눌러서 15초 안에 수집이 시작되나 → worker 배포됨
- 90초 뒤 "수집기가 요청을 집어가지 않습니다" 가 뜨면 worker 가 아직 옛 코드다

`deploy_worker` 는 `/usr/local/bin/sr-deploy.sh` 를 부르는데 **그 파일은 배포로 갱신되지
않는다**(레포 밖, root 소유). `RUN_USER`·`chown`·`playwright install` 이 들어간 판을 아직
안 복사했다면 지금도 예전 것이 돈다.

```sh
sudo cp deploy/sr-deploy.sh /usr/local/bin/sr-deploy.sh
```

---

## 순서

```
0  CI 실패 1건  ← 이게 풀려야 3·4 가 저절로 끝난다. 가장 적은 일로 가장 많이 푼다
1  첨부 업로드   ← 그 전에 조각 필드 이름 확인용 캡처 1회(10KB 파일)
2  올린 파일 보이게 하기   ← 1 의 lib/crushftp.ts 를 재사용
3  세션 자동 갱신(worker) ← 4 의 app_state 구조를 재사용
```

0 번은 로그 한 줄이면 끝나고, 그것만으로 이미 만들어 둔 두 기능이 살아난다.
