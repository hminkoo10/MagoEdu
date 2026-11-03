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
