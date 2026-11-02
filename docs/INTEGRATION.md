# 프로그램을 통합 클라우드에 연결하기

오답노트·마고 타종 같은 프로그램을 **마고에듀 통합 클라우드에서만** 설치·실행되게 바꾸는 방법이에요.
(이 문서대로 각 저장소를 고치면 돼요. 프로그램 쪽 수정은 아직 하지 않았어요.)

## 한눈에

| 지금 (따로 설치) | 바뀐 뒤 (통합 클라우드) |
| --- | --- |
| `OhdapNote-Setup-x.y.z.exe`, `MaplTajong-Setup-x.y.z.exe` 설치 파일 배포 | **설치 파일은 배포하지 않음.** `이름-x.y.z-win-x64.zip` 묶음 파일만 Release 에 올림 |
| 바탕 화면 아이콘으로 실행 | 통합 클라우드의 **열기**, 또는 통합 클라우드가 만든 **바탕 화면·시작 메뉴 바로 가기**로 실행 (그냥 exe 를 누르면 안내 창이 뜨고 꺼짐) |
| 데이터는 `%APPDATA%\프로그램` (컴퓨터마다 따로) | 데이터는 **계정마다** — 같은 아이디면 어느 컴퓨터든 같은 데이터 (서버와 동기화) |
| 프로그램이 스스로 업데이트 | 통합 클라우드가 새 버전을 받아 둠. 프로그램은 알맞은 때 다시 켜지기만 하면 됨 |

## 1. 묶음 파일과 `magoedu-app.json`

GitHub Release 에 올릴 파일:

- `OhdapNote-0.2.0-win-x64.zip` — 실행에 필요한 파일 전부 (electron-builder 의 `win-unpacked`, PyInstaller 의 `dist\Mataf` 폴더)
- `OhdapNote-0.2.0-win-x64.zip.sha256` — SHA-256 값 (GitHub 가 자동으로 붙여 주는 digest 가 있으면 없어도 됨)

zip 맨 위(또는 폴더 하나 안)에 `magoedu-app.json` 을 넣어요.

```json
{
  "format": 1,
  "id": "ohdapnote",
  "version": "0.2.0",
  "exe": "OhdapNote.exe",
  "sync": {
    "include": ["data/**"],
    "exclude": ["**/*.tmp"],
    "groups": [{ "pattern": "data/projects/*", "cold": true }]
  },
  "legacy": [
    { "id": "standalone", "label": "따로 설치해서 쓰던 오답노트", "from": "{APPDATA}/OhdapNote/data", "to": "sync/data" }
  ]
}
```

| 항목 | 뜻 |
| --- | --- |
| `id` | 서버 프로그램 목록의 ID (`ohdapnote`, `tajong`) |
| `exe` | 묶음 안의 실행 파일 경로 |
| `args` | (선택) 실행할 때 붙일 인수 |
| `sync.include` / `sync.exclude` | 동기화 폴더(`MAGOEDU_DATA_DIR`) 안에서 서버에 올릴 파일 규칙. `*` 는 폴더 안, `**` 는 하위 폴더까지 |
| `sync.groups` | 한 묶음으로 보는 폴더. `cold: true` 면 서버 보관 기간(운영자가 정함, 기본 30일) 동안 안 쓴 묶음은 **서버에서만** 지우고 그 컴퓨터에는 남겨 둠 |
| `legacy` | 예전에 따로 설치해서 쓰던 데이터 위치. `{APPDATA}` `{LOCALAPPDATA}` `{HOME}` `{DOCUMENTS}` 를 쓸 수 있고, `to` 는 `sync/...` 또는 `local/...` |
| `restartExitCode` | (선택) 다시 켜 달라는 종료 코드. 기본 75 |

서버 프로그램 목록(통합 클라우드 → 프로그램 관리)에는 저장소와 파일 이름 규칙만 적어 두면 돼요.
기본으로 들어 있는 규칙: `^OhdapNote-(\d+\.\d+\.\d+)-win-x64\.zip$`, `^MaplTajong-(\d+\.\d+\.\d+)-win-x64\.zip$`

## 2. 통합 클라우드가 넘겨주는 환경 변수

| 이름 | 내용 |
| --- | --- |
| `MAGOEDU_TICKET` | 실행 허가증 (서버가 Ed25519 로 서명, 기본 7일) |
| `MAGOEDU_DATA_DIR` | **동기화 폴더** — 같은 아이디면 모든 컴퓨터가 같은 내용 |
| `MAGOEDU_LOCAL_DIR` | 이 컴퓨터에만 두는 폴더 (캐시, 로그, SQLite 같은 것) |
| `MAGOEDU_APP_ID`, `MAGOEDU_USER_ID`, `MAGOEDU_USERNAME`, `MAGOEDU_USER_NAME`, `MAGOEDU_ROLE`, `MAGOEDU_ACADEMY` | 누가 켰는지 (확인된 값은 허가증 안에 있음) |
| `MAGOEDU_SERVER`, `MAGOEDU_LAUNCHER_VERSION`, `MAGOEDU_LAUNCHER_PID` | 참고용 |

## 3. 시작할 때 확인하기 (개별 실행 막기)

`sdk/python/magoedu_cloud.py`, `sdk/node/magoedu-cloud.js` 를 프로그램에 복사해서 써요. 외부 라이브러리는 필요 없어요.

**Python (마고 타종, PyQt6)**

```python
import magoedu_cloud as cloud

session = cloud.check("tajong")
if session is None:
    QMessageBox.information(None, "마고에듀 통합 클라우드", cloud.REASON)
    cloud.open_cloud("tajong")   # 통합 클라우드를 열어서 이 프로그램을 켜 달라고 함
    sys.exit(0)
```

**Electron (오답노트, main.js 맨 앞)**

```js
const cloud = require('./magoedu-cloud');
const session = cloud.check('ohdapnote', { packaged: app.isPackaged });
if (!session) {
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({ type: 'info', title: '마고에듀 통합 클라우드', message: cloud.reason() });
    cloud.openCloud('ohdapnote');
    app.exit(0);
  });
  return;
}
app.setPath('userData', session.localDir);   // 캐시·로그는 이 컴퓨터에만
```

- 허가증은 서버가 서명하고, 공개 키는 통합 클라우드가 `%APPDATA%\MagoEduCloud\trust.json` 에 적어 둬요. 빌드한 프로그램은 이 위치만 믿어요.
- **개발할 때**(빌드 전 소스로 실행)는 `MAGOEDU_DEV=1` 을 켜면 통합 클라우드 없이 실행돼요. (`MAGOEDU_DEV_DIR` 로 폴더 지정)

### 바로 가기 (Steam 처럼)

Windows 프로그램을 설치하거나 업데이트하면 통합 클라우드가 **바탕 화면**과 **시작 메뉴**에 프로그램 이름으로 바로 가기를 만들어요.

- 대상은 통합 클라우드(`MagoEduCloud.exe`), 인수는 `magoedu://launch/<프로그램 ID>` 예요. 그래서 로그인은 통합 클라우드에 그대로 있고, 누르면 통합 클라우드가 그 계정으로 허가증을 받아 프로그램을 켜요.
- 아이콘은 설치한 프로그램의 exe 를 써요. 버전마다 폴더가 달라서 업데이트할 때마다 바로 가기를 다시 써요.
- 통합 클라우드가 켜져 있으면 창을 띄우지 않고 바로 켜요. 꺼져 있으면 통합 클라우드를 켜서 로그인 정보를 확인한 뒤 켜고, 로그인이 필요하면 로그인 화면을 보여 준 뒤 로그인하면 켜요.
  설치·업데이트가 필요하거나, 예전 데이터를 물어봐야 하거나, 이미 켜져 있거나, 켜지 못했을 때만 통합 클라우드 창이 보여요.
- 프로그램 카드의 **⋯ → 바탕 화면 바로 가기**로 끄고 켤 수 있어요(시작 메뉴에는 언제나 있음). 프로그램을 삭제하면 바로 가기도 지워요.
- 설치한 통합 클라우드에서만 만들어요 (개발 모드 `npm start` 에서는 만들지 않음).

### 웹에서 PC 프로그램 설치·실행 (`magoedu://`)

Windows PC 브라우저의 웹 화면에서는 Windows 프로그램 카드에 **PC에 설치**와 **PC에서 실행**이 있어요. 웹은 이 PC 에 무엇이 설치돼 있는지 모르니, 이 PC 의 통합 클라우드 앱에 부탁만 해요.

| 주소 | 하는 일 |
| --- | --- |
| `magoedu://launch/<프로그램 ID>` | 켜요. 설치·업데이트가 필요하면 먼저 해요. (바로 가기와 같음) |
| `magoedu://install/<프로그램 ID>` | 설치하거나 새 버전으로 업데이트만 해요. 켜지 않아요. 통합 클라우드 창의 프로그램 화면에 진행이 보이고, 이미 최신이면 그렇다고 알려 줘요. |
| `magoedu://open` | 통합 클라우드 창만 열어요. |

- 로그인은 바로 가기와 같아요: 통합 클라우드가 켜져 있지 않으면 켜서 로그인 정보를 확인한 뒤 하고, 로그인이 필요하면 로그인한 뒤에 해요.
- 앱이 열리지 않으면(이 PC 에 통합 클라우드가 없으면) 웹이 통합 클라우드 내려받기(`/download/launcher`)를 안내해요.
- Windows 가 아닌 브라우저(휴대폰·태블릿·Mac 등)에서는 버튼 대신 ‘Windows PC에서 설치·실행할 수 있어요’라고만 보여요.

## 4. 동기화에 맞게 데이터 두기

통합 클라우드는 **파일 단위**로 맞추고, 프로그램이 켜져 있는 동안에도 **실시간**으로 맞춰요.

- **다른 기기에서 바뀌면**: 서버가 실시간 알림(8번)을 보내고, 통합 클라우드가 0.3초쯤 모았다가 바로 받아요.
- **이 컴퓨터에서 바뀌면**: 통합 클라우드가 동기화 폴더를 지켜보다가, 파일을 쓰고 1초쯤 지나면 올려요. (`*.tmp` 와 통합 클라우드 임시 파일은 건너뜀)
- 알림 연결이 끊기면 1초에서 시작해 두 배씩, 많아야 30초 간격으로 다시 붙고, 다시 붙으면 한 번 맞춰요. 그래도 **5분마다**, 그리고 켜기 전·끈 뒤에는 꼭 맞춰요.
- 받은 파일은 옆 임시 파일(`*.magoedu-dl`)에 다 받은 뒤 **이름만 바꿔서** 넣어요. 그래서 프로그램이 반쯤 받은 파일을 읽는 일은 없어요.
  그 순간 프로그램이 파일을 열고 있으면(Windows) 잠깐 기다렸다가 다시 넣어요.

- 두 컴퓨터에서 같은 파일을 동시에 고치면 **서버에 먼저 올라간 것**을 쓰고, 밀려난 파일은 `conflicts` 폴더에 보관해요.
- 파일은 **임시 파일에 쓰고 이름 바꾸기**(원자적 저장)로 저장해 주세요. 임시 파일 확장자는 `exclude` 에 넣어요.
- **SQLite 파일은 동기화 폴더에 두지 마세요.** 쓰는 중에 복사되면 깨질 수 있고, 기록(로그)처럼 컴퓨터마다 계속 바뀌는 값 때문에 충돌이 잦아요.
  함께 써야 하는 설정만 JSON 으로 내보내고, SQLite 는 `MAGOEDU_LOCAL_DIR` 에 둬요.
- 다른 컴퓨터에서 바뀐 파일이 켜져 있는 동안 내려와요. 파일을 지켜보다가(`QFileSystemWatcher`, `fs.watch`) 다시 읽어요.
  다시 읽은 내용을 그대로 다시 쓰지는 마세요 (내용이 바뀌었을 때만 쓰면 주고받기를 되풀이하지 않아요).
- `cold: true` 묶음은 **안에 있는 파일이 하나라도 바뀌면 "사용함"**으로 쳐요. 열어 보기만 해도 기간이 다시 시작되게 하려면 열 때 작은 값(예: `openedAt`)을 저장해 주세요.
  서버에서 정리된 묶음을 다시 열면 그 컴퓨터에 남아 있던 파일이 모두 다시 올라가요.

## 5. 업데이트

- 프로그램 안의 자동 업데이트(electron-updater, `update_manager.py`)는 빼요. 통합 클라우드가 새 버전을 **옆 폴더에 받아 두고**, 다음에 켤 때 새 버전으로 켜요.
- 오래 켜 두는 프로그램(타종)은 `newer_version_installed(앱 ID, 지금 버전)` 으로 새 버전이 받아졌는지 보고, **알맞은 때**(예: 다음 종까지 10분 넘게 남음) 종료 코드 **75** 로 끝내면 통합 클라우드가 바로 새 버전으로 다시 켜요.
- 통합 클라우드에서 **끄기**를 누르면 창 닫기 신호를 먼저 보내고, 10초 뒤에도 켜져 있으면(창을 닫으면 트레이로 숨는 프로그램 등) 강제로 꺼요. 데이터는 그때그때 원자적으로 저장해 두세요.

## 6. 배포 (GitHub Actions)

**Electron (electron-builder)**

```yaml
- run: npx electron-builder --win dir --x64 --publish never
- shell: pwsh
  run: |
    $v = node -p "require('./package.json').version"
    Copy-Item magoedu-app.json dist/win-unpacked/
    Compress-Archive -Path dist/win-unpacked/* -DestinationPath "dist/OhdapNote-$v-win-x64.zip"
    (Get-FileHash "dist/OhdapNote-$v-win-x64.zip" -Algorithm SHA256).Hash.ToLower() + "  OhdapNote-$v-win-x64.zip" | Out-File -Encoding ascii "dist/OhdapNote-$v-win-x64.zip.sha256"
- run: gh release create "v$v" dist/*.zip dist/*.sha256 --title "오답노트 $v" --notes-file release-notes.md
```

**PyInstaller (마고 타종)**: `tools/build.py --no-installer` 로 `dist\Mataf` 를 만든 뒤, 같은 방식으로 `magoedu-app.json` 을 넣고 `MaplTajong-x.y.z-win-x64.zip` 으로 묶어요. Inno Setup 설치 파일은 더 이상 만들지 않아요.

> 저장소가 비공개라면 서버의 `GITHUB_TOKEN` 에 읽기 토큰을 넣어 주세요. 서버가 대신 받아서 넘겨 줘요.

## 7. 프로그램별로 고칠 것 (나중에 할 일)

### 오답노트 (`hminkoo10/ohdapnote`)

1. `src/main/main.js` 시작 부분에 3번의 확인 코드. `app.setPath('userData', session.localDir)`.
2. `dataDir()` 를 `path.join(session.dataDir, 'data')` 로 (프로젝트·설정이 동기화 폴더로).
3. `projects:get` 때 `project.json` 에 `openedAt` 저장 → 열어 보기만 해도 보관 기간이 다시 시작.
4. `electron-updater` 와 업데이트 화면 제거 (또는 "통합 클라우드가 업데이트해요" 안내로 바꿈).
5. `magoedu-app.json` (1번 예시 그대로) 추가, `release.yml` 을 6번처럼 zip 배포로 변경. NSIS 설치 파일·`latest.yml` 배포 중단.
6. `.tmp` 임시 파일은 `exclude` 에 이미 들어 있음.

### 마고 타종 (`hminkoo10/Mapl-Tajong`, 2.1.0 기준)

1. `app/main.py` 맨 앞에 3번의 확인 코드.
2. `app/core/paths.py`
   - `app_data_dir()` → `session.local_dir` (SQLite `tajong.db`, 잠금 파일, 캐시, 로그는 이 컴퓨터에만)
   - `sounds_dir()` → `session.data_dir / "sounds"` (종소리 파일은 동기화)
3. 함께 쓰는 데이터는 동기화 폴더(`session.data_dir`)에 JSON 으로 둬요. 형식과 규칙은 Mapl-Tajong 저장소의
   [`docs/cloud-sync.md`](https://github.com/hminkoo10/Mapl-Tajong/blob/main/docs/cloud-sync.md) 를 따라요 (안드로이드 앱도 같은 형식).
   - `config.json` — 시간표·세트·종소리 목록·지금 세트 (지금의 `backup.py` 형식 + 머리말)
   - `state.json` — 잠시 멈춤, 오늘 쉬기, 다음 종 건너뛰기, 다른 기기에 울려 달라는 요청
   - `sounds/**` — 종소리 파일
   - `logs/<기기 ID>.json` — 기기마다 자기 파일에만 쓰는 울린 기록 (최근 60일)
   - 바꿀 때마다 1초쯤 모아서 쓰고, 다른 기기에서 바뀌면(`QFileSystemWatcher`) 바로 불러와요. `FIRED_ONCE` 같은 이 기기만의 값은 SQLite 에만 둬요.
4. `magoedu-app.json`
   ```json
   {
     "format": 1, "id": "tajong", "exe": "Mataf.exe",
     "sync": { "include": ["config.json", "state.json", "sounds/**", "logs/**"], "exclude": ["**/*.tmp"] },
     "legacy": [
       { "id": "db", "label": "따로 설치해서 쓰던 타종 시간표", "from": "{APPDATA}/MaplTajong/tajong.db", "to": "local/import/tajong.db" },
       { "id": "sounds", "label": "따로 설치해서 쓰던 종소리", "from": "{APPDATA}/MaplTajong/sounds", "to": "sync/sounds" }
     ]
   }
   ```
   처음 켤 때 `local/tajong.db` 가 없고 `local/import/tajong.db` 가 있으면 그것으로 시작하고 `config.json` 을 내보내요.
5. 컴퓨터 켜면 자동 실행: 타종의 `Run` 레지스트리 등록 대신 통합 클라우드의 "함께 켜기"를 써요 (타종은 기본으로 켜져 있음).
6. `app/core/updater.py`, `app/ui/update_manager.py` 제거. 대신 `newer_version_installed("tajong", APP_VERSION)` 를 보고 **다음 종까지 10분 넘게 남았을 때** 75 로 종료.
7. `.github/workflows/release-desktop.yml` 을 zip 배포로 바꾸고 Inno Setup 단계 제거.
8. 안드로이드 앱은 8번처럼 서버 동기화 API 를 직접 써요 (프로그램 ID 는 똑같이 `tajong`).

## 8. 안드로이드 앱 (휴대폰에서 직접 동기화)

통합 클라우드(PC 프로그램)는 Windows 만 설치·실행해요. 안드로이드 앱은 **프로그램 목록에 따로 한 항목**으로 두고, 웹에서 APK 를 내려받게 해요.

### 프로그램 목록

- 프로그램마다 `platform` 이 있어요: `windows`(기본) 또는 `android`. 운영자는 **프로그램 관리 → 고치기 → 플랫폼**에서 골라요. `/api/apps` 도 `platform` 을 돌려줘요.
- 기본 항목 `tajong-android` (마고 타종 (안드로이드)): `hminkoo10/Mapl-Tajong` 의 `^MaplTajong-(\d+\.\d+\.\d+)\.apk$`.
  안드로이드 Release 는 `android-v*` 태그에 `--latest=false` 로 올리지만 미리보기(prerelease)가 아니라서 서버가 찾아요.
  PC 용 `-win-x64.zip` 규칙과는 서로의 파일을 고르지 않아요. SHA-256 은 GitHub digest 나 `MaplTajong-x.y.z.apk.sha256` 에서 읽어요.
- 통합 클라우드는 안드로이드 항목을 설치·실행·동기화하지 않아요. 서버도 실행 허가증을 주지 않아요 (`POST /api/apps/:id/ticket` → 400 `wrong_platform`).
- 프로그램 카드: 안드로이드 기기 브라우저에서는 **내려받기**, 그 밖(PC 앱, PC·아이폰 브라우저)에서는 **휴대폰으로 받기**(사이트 주소와 받는 방법 안내)가 보여요.
  기기를 잘못 알아봐도 받을 수 있게, **휴대폰으로 받기** 안내 창과 **⋯** 메뉴에는 언제나 **이 기기에서 받기**가 있어요. (PC 앱에서는 기본 브라우저가 받음)
- 안드로이드 태블릿의 Chrome 은 PC 처럼(`X11; Linux x86_64`) 보내서, 웹은 `navigator.userAgentData.platform` 과 터치 여부를 같이 봐요:
  리눅스인데 터치가 되면(크롬북 제외) 안드로이드로, Mac 인데 터치가 되면 iPad 로 봐요.
- 사용 권한은 PC 항목과 따로예요. 안드로이드 앱이 `tajong` 데이터를 동기화하려면 그 계정이 `tajong` 도 쓸 수 있어야 해요.

### 브라우저 내려받기 주소

브라우저는 그냥 누르는 링크에 로그인 정보(Bearer)를 붙일 수 없어서, 로그인한 화면이 짧은 주소를 받아서 열어요.

```
POST /api/apps/<id>/download-link        Authorization: Bearer <세션 토큰>
→ { "url": "/api/apps/<id>/download?version=1.4.0&dl=<만료>.<서명>", "expiresAt": 1761955200000 }

GET  /api/apps/<id>/download?version=…&dl=…     (로그인 정보 없이, 10분 동안)
```

- `dl` 은 서버만 아는 값으로 만든 HMAC-SHA256 서명이고 프로그램 ID·버전·만료 시각(10분)에 묶여 있어요. 틀리거나 지나면 403 `invalid_link`.
- `GET /api/apps/<id>/download` 는 지금처럼 Bearer 로도 받을 수 있어요.
- 서버가 대신 받아서 보낼 때(비공개 저장소·직접 올린 파일) APK 는 `application/vnd.android.package-archive` 와 파일 이름(`content-disposition`)을 붙여요.

### 동기화 API 직접 쓰기

1. `POST /api/auth/login` `{ username, password, device: { id, name, platform: "android", version } }` → `token`
2. `GET /api/sync/tajong?since=<마지막 seq>` → 바뀐 파일 목록, `GET|PUT|DELETE /api/sync/tajong/file?path=…&baseRev=…` (PC 통합 클라우드와 같은 규칙: `baseRev` 가 맞지 않으면 409, 먼저 올라간 것이 이김)
3. 실시간 알림을 열어 두고, `change` 가 오면 `since` 로 바뀐 것만 받아요.

### 서버 실시간 알림

```
GET /api/sync/events?apps=tajong          Authorization: Bearer <세션 토큰>
→ 200 text/event-stream; charset=utf-8    (cache-control: no-cache, no-transform · x-accel-buffering: no)

event: hello
data: {"time":"2026-11-01T00:00:00Z"}

event: change
data: {"appId":"tajong","seq":123,"deviceId":"바꾼 기기 ID"}

: ping                                     (25초마다)
```

- `apps` 를 빼면 그 계정이 쓸 수 있는 모든 프로그램. 없는 프로그램은 404, 권한이 없는 프로그램은 403, 로그인 정보가 없거나 끝났으면 401.
- 그 계정의 파일이 바뀔 때마다(올리기·지우기·서버 보관 기간 정리) 저장이 끝난 뒤 보내요. `deviceId` 는 바꾼 기기의 세션 기기 ID, 서버가 정리했으면 `null`.
  내 기기 ID 와 같으면 내가 올린 것이니 건너뛰어도 돼요.
- 서버는 1분쯤마다 세션을 다시 확인해서 로그아웃·사용 중지된 연결은 끊어요. 세션 하나에 연결은 5개까지(넘으면 오래된 것부터 끊음).
- 끊기면 1초에서 시작해 두 배씩, 많아야 30초 간격으로 다시 붙고, 다시 붙으면 `since` 로 한 번 받아요. 70초 넘게 아무것도 오지 않으면(ping 포함) 끊긴 것으로 봐요.
- 서버 한 대 안에서만 알려요. nginx·Cloudflare 앞에 두어도 되고(25초 ping 으로 100초 끊김을 막음), 서버가 `x-accel-buffering: no` 를 보내니 nginx 가 모아 두지 않아요.
