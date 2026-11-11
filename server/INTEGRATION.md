# 마고 공용 책장

모든 학원에 같은 시험 책을 배포하는 읽기 전용 공간이다. 학원 공간·개인 공간과 별개이며 DB 마이그레이션은 없다. 런처 수신과 SDK 연결은 B2 범위다.

## 저장 형식과 운영

`LIBRARY_DIR`로 루트를 정한다(기본 `/var/lib/mago-library`). 서버는 이 루트를 읽기만 하며, 올리기 명령은 별도 처리기 계정으로 실행한다. 서버 계정에는 공유 그룹의 읽기·탐색 권한을 준다. 새 폴더는 0750(위 폴더의 setgid 는 이어 받음), 파일은 0640으로 명시 설정한다. 기존 폴더의 소유권·권한은 바꾸지 않는다.

처음 한 번, 루트와 그 아래 폴더를 처리기 계정 소유·서버 그룹·setgid 로 만들어 두면 새 파일이 서버 그룹으로 생긴다:

```sh
install -d -o <처리기 계정> -g <서버 그룹> -m 2750 <LIBRARY_DIR> <LIBRARY_DIR>/blobs <LIBRARY_DIR>/ohdapnote
```

```text
<LIBRARY_DIR>/blobs/<sha256>
<LIBRARY_DIR>/<appId>/index.json
<LIBRARY_DIR>/<appId>/.lock
```

색인은 `{ format: 1, appId, seq, updatedAt, entries }`이며 항목은 `{ path, rev, seq, sha256, size, mtime, deleted, subject, book }`이다. `path`는 `books/<공용 책 id>/<파일 이름>`, `subject`는 계약 과목 키, `book`은 공용 책 id다. 시각은 Unix 밀리초. 삭제 항목은 `deleted: true, sha256: null, size: 0`으로 유지한다. seq는 앱별 단조 증가, rev는 경로별 증가다.

서버는 색인의 mtime·크기가 달라질 때만 다시 읽는다. 없거나 잘못된 색인은 로그 한 줄과 빈 책장으로 처리한다. 게시자는 blob을 먼저 임시 파일 → rename으로 저장하고 마지막에 색인을 임시 파일 → rename으로 교체한다. 미사용 blob 정리는 하지 않는다.

## 읽기 API와 권한

로그인과 프로그램 사용 권한이 필요하다. 원장·선생님은 소속 학원의 `academies.subjects`만, 운영자는 학원 없이 모든 과목을 본다. 학생은 `403 library_forbidden`, 소속 학원 없는 원장·선생님은 `404 no_academy`다. 쓰기 API는 없다.

```http
GET /api/sync/ohdapnote/library?since=0
Authorization: Bearer <로그인 토큰>

GET /api/sync/ohdapnote/library/file?path=books%2Fexam-0123456789abcdef%2Fbook.json
Authorization: Bearer <로그인 토큰>
```

목록은 `{ appId, seq, full, subjects, entries }`. `full`은 since=0일 때 true다. `subjects`는 계약 과목 목록(운영자는 색인에 존재하는 모든 과목), entries는 `seq > since`이면서 볼 수 있는 과목의 항목이다. 삭제 항목도 동일한 과목 필터를 적용한다. 항목은 기존 `publicEntry` 형태에 `subject`를 더한다. 전역 앱 seq는 보이지 않는 과목의 변경도 포함할 수 있다.

파일은 GET·HEAD를 지원한다. 응답 헤더는 `x-rev`, `x-sha256`, `cache-control: no-store`. 없는 파일·삭제 파일은 404, 계약하지 않은 과목의 파일은 403, 잘못된 경로는 `400 invalid_path`다. 파일 내용 경로는 64자리 소문자 SHA-256으로만 정한다.

## 올리기 명령

저장소 루트에서 실행한다. 꺾쇠 안은 운영 환경에서 대체할 자리표시자다.

```sh
node server/scripts/library-publish.js --library <LIBRARY_DIR> --app ohdapnote <결과폴더1> <결과폴더2>
node server/scripts/library-publish.js --library <LIBRARY_DIR> --app ohdapnote --remove exam-0123456789abcdef
```

각 결과 폴더는 오답노트 처리기(`--exam-out`)의 출력으로 `summary.json`과 `books/<원본 id>/`를 가진다. summary 는 `{ "exams": [{ "name": "...", "bookId": "<원본 id>", "done": true, "error": null, ... }] }`이며 `done: true` 이고 error 가 없는 책만 올린다. 깨진 summary·완료 책은 건너뛰고 나머지는 계속한다. 실패한 책의 기존 게시본은 보존한다. 심볼릭 링크 입력은 받지 않는다.

공용 id는 `book.json.exam`의 `[exam, year, schoolYear, month, grade, subject, selection, form]` 순서 배열을 JSON 직렬화한 SHA-256 앞 16자에 `exam-`을 붙인다. 없는 선택 필드는 null로 통일한다. 필드는 문자열·숫자·null이며 exam·year·subject는 필수다. 같은 시험의 필드 값과 타입을 유지하면 원본 책 id와 무관하게 같은 공용 id가 된다. `book.json.id`와 `createdBy`만 공용 값으로 바꾸고 나머지 파일은 바이트 그대로 저장한다.

같은 내용은 rev·seq·mtime을 유지한다. 바뀐 내용과 복원 파일만 rev+1·새 seq, 이번 책에 없는 이전 파일은 삭제 표시한다. `--remove`도 같은 삭제 표시 방식이며 재실행은 무변경이다.

표준 출력은 한 줄 JSON: `{"books":1,"changed":3,"deleted":0,"seq":3}`. books는 성공적으로 처리한 책 수(무변경 포함), changed는 신규·변경·복원 파일 수, deleted는 새로 삭제 표시한 파일 수다. 진단은 표준 오류로만 출력한다.

| 종료 코드 | 뜻 |
| --- | --- |
| 0 | 성공 |
| 1 | 일부 결과 폴더·완료 책 실패, 나머지 게시 완료 |
| 2 | 인자·저장소·색인 오류 또는 색인 저장 실패 |
| 3 | 같은 앱의 `.lock`이 이미 존재함 |

잠금에는 PID와 시작 시각을 남긴다. 오래되었다는 이유로 자동 제거하지 않는다. 운영자가 해당 앱의 게시 프로세스가 없음을 확인한 뒤 `.lock`만 수동 제거하고 재실행한다. 앱별 게시 잠금이며 다른 앱은 동시에 게시 가능하다.

## B2 런처 연결 메모

개인·학원 공간과 별도 namespace 및 since 커서를 유지하고 공용 공간은 수신만 한다. 최초 since=0으로 받은 뒤 응답 seq를 저장한다. 삭제 항목은 해당 공용 파일을 지운다. 계약 과목 변경 시 subjects를 비교하고 since=0으로 다시 받아, 권한을 잃은 과목의 로컬 파일도 정리해야 한다. 공용 게시에는 SSE 알림이 없으므로 목록을 주기 조회한다. 공용 책 id를 다른 공간의 책과 섞거나 쓰기 API로 되돌려 보내지 않는다.

# CI 릴리스 알림

기본 배포 경로는 **GitHub Actions → 서버 알림**이다. `GITHUB_TOKEN`을 비우면 서버는 GitHub 릴리스 API를 폴링하지 않는다. DB와 `data/github-cache.json`에 저장된 버전은 재시작 후에도 유지된다. 로컬 `packages/` 갱신은 계속 동작한다. 토큰을 설정하면 기존 API 조회가 대체 경로로 활성화된다.

## 워크플로 연결

1. GitHub Release와 모든 자산을 공개한 뒤 알림을 보낸다. job에 `permissions: id-token: write`를 지정한다. 별도 공유 비밀은 없다.
2. `ACTIONS_ID_TOKEN_REQUEST_URL`에 `&audience=mago.milky.kr`를 붙이고, `Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN`으로 OIDC 토큰을 요청한다. 응답의 `value`를 사용한다. [GitHub OIDC 문서](https://docs.github.com/en/actions/reference/security/oidc)
3. `POST https://mago.milky.kr/api/ci/releases`에 `Authorization: Bearer <OIDC 토큰>`, `Content-Type: application/json`과 아래 본문을 보낸다.

```json
{
  "tag": "v0.4.3",
  "version": "0.4.3",
  "notes": "릴리스 안내",
  "assets": [
    { "name": "OhdapNote-0.4.3-win-x64.zip", "size": 123456, "sha256": "<파일의 SHA-256: 64자리 16진수>" }
  ]
}
```

- 저장소는 본문에 넣지 않는다. 서명된 `repository` 클레임과 카탈로그의 `source.repo`가 일치해야 한다. `ref`는 `refs/heads/main` 또는 `refs/tags/*`만 허용한다. RS256·발급자·audience·exp/nbf/iat를 검증하며 시계 오차는 30초까지 허용한다. JWKS는 1시간 캐시하고, 미등록 `kid`는 분당 최대 1회 재조회한다.
- `version`은 `x.y.z`, 태그는 128자 이내, 파일 이름은 255자 이내의 영문·숫자·`.`·`_`·`+`·`-`이며 영문·숫자로 시작한다. `/`, `\`, `..`는 금지한다. `size`는 0 이상의 안전한 정수, `sha256`은 각 업로드 파일의 SHA-256이다. 자산 이름은 중복할 수 없다.
- 본문 전체는 UTF-8 **128 KB**, 자산은 최대 256개. 런처 릴리스만 `latestYml`에 업로드한 `latest.yml` 원문을 추가한다(UTF-8 **64 KB 이하**). `assets`에는 `latest.yml`과 `MagoEduCloud-Setup-<version>.exe`도 포함한다. 파일 이름의 버전과 본문 버전은 같아야 한다.
- 카탈로그의 기존 파일 정규식·`tagPrefix`를 적용한다. 매칭되지 않는 플랫폼은 유지하며, 늦게 도착한 낮은 버전은 덮어쓰지 않는다. 같은 버전 재전송은 가능하다.
- 성공: `200 {"updated":["ohdapnote"]}`. 런처 갱신 시 `"launcher"`도 포함. 매칭되는 새 버전이 없으면 빈 배열. 잘못된 토큰은 `401`, 본문은 `400`, 미등록 저장소는 `404`.
- 서버 장애 시 **최대 3회 재시도 + backoff**, 이후 경고만 출력하고 `exit 0`으로 릴리스 성공을 유지한다. 토큰은 로그에 출력하지 않는다.

알림은 앱 버전·런처 원문·감사 기록(`release.ci`)을 저장한다. 클라이언트는 기존 `/api/apps`, `/api/launcher`, `/updates/launcher/latest.yml` 조회에서 새 버전을 받는다. 기존 `refreshApp`에는 릴리스 SSE 이벤트가 없어 별도 이벤트는 추가하지 않았다. CI 자산 다운로드는 `https://github.com/<repo>/releases/download/<tag>/<name>`로 302 응답한다.

시험에서만 `loadConfig`의 `githubOidcJwksUrl`·`githubOidcFetch` override로 가짜 JWKS를 주입할 수 있다. 운영 기본 JWKS 주소는 `https://token.actions.githubusercontent.com/.well-known/jwks`다.
