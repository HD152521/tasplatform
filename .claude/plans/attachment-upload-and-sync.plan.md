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

### 모르는 것 하나

**조각 본문의 필드 이름.** `/U/...` 요청은 `multipart/form-data` 인데, Playwright 가 큰
본문을 내주지 않아 69건 전부 본문이 비었다. 필드 이름을 모르면 서버에서 같은 요청을
만들 수 없다.

추측하지 않는다. 한 번 더 캡처한다.

1. `collector/capture.ts` 에 `/U/` 요청만 `page.route` 로 가로채 본문 머리 2KB 를 뜯는 코드를 더한다
   (파일 바이트는 저장하지 않는다 — 헤더 줄만 남긴다)
2. **10KB짜리 파일 한 개**를 올린다 → 조각 1개로 끝나 캡처가 가볍다
3. 필드 이름을 확인하면 그 캡처는 버린다

### 만들 것

```
lib/crushftp.ts          프로토콜. openFile → 조각 → closeFile, md5 대조
                         쿠키 단지는 기존 CookieJar 를 쓴다(collector/cookieJar.ts)
                         redirect.html 부터 태우는 진입 함수 포함
app/api/attachments/upload/route.ts
                         파일을 받아 위를 호출한다. 세션 검사는 쓰기 라우트와 같은 모양
                         (hydrate → hasTeamSession → 감사 로그)
app/cases/[id]/ReplyBox.tsx    답변란에 파일 붙이기
app/new/                        새 SR 에도 같은 것
```

주의할 점:

- **크기 상한을 둔다.** 웹 컨테이너 메모리가 작다. 한 번에 통째로 올리지 말고 스트림으로 흘린다
- 업로드 실패를 답변 전송 실패로 섞지 않는다. 별개 동작이다
- 파일명은 그대로 쓰되 경로 구분자·상위 경로(`..`)를 막는다
- 감사 로그에 남긴다(누가 어느 케이스에 무엇을 올렸는지). 파일 내용은 남기지 않는다

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
