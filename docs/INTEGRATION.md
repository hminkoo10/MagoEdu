# 프로그램을 통합 클라우드에 연결하기

오답노트·마고 타종 같은 프로그램을 **마고에듀 통합 클라우드에서만** 설치·실행되게 바꾸는 방법이에요.
(이 문서대로 각 저장소를 고치면 돼요. 프로그램 쪽 수정은 아직 하지 않았어요.)

## 한눈에

| 지금 (따로 설치) | 바뀐 뒤 (통합 클라우드) |
| --- | --- |
| `OhdapNote-Setup-x.y.z.exe`, `MaplTajong-Setup-x.y.z.exe` 설치 파일 배포 | **설치 파일은 배포하지 않음.** `이름-x.y.z-win-x64.zip` 묶음 파일만 Release 에 올림 |
| 바탕 화면 아이콘으로 실행 | 통합 클라우드의 **열기** 로만 실행 (그냥 exe 를 누르면 안내 창이 뜨고 꺼짐) |
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

## 4. 동기화에 맞게 데이터 두기

통합 클라우드는 **파일 단위**로 맞춰요. 프로그램이 켜져 있는 동안에도 5분마다, 그리고 켜기 전·끈 뒤에 동기화해요.

- 두 컴퓨터에서 같은 파일을 동시에 고치면 **서버에 먼저 올라간 것**을 쓰고, 밀려난 파일은 `conflicts` 폴더에 보관해요.
- 파일은 **임시 파일에 쓰고 이름 바꾸기**(원자적 저장)로 저장해 주세요. 임시 파일 확장자는 `exclude` 에 넣어요.
- **SQLite 파일은 동기화 폴더에 두지 마세요.** 쓰는 중에 복사되면 깨질 수 있고, 기록(로그)처럼 컴퓨터마다 계속 바뀌는 값 때문에 충돌이 잦아요.
  함께 써야 하는 설정만 JSON 으로 내보내고, SQLite 는 `MAGOEDU_LOCAL_DIR` 에 둬요.
- 다른 컴퓨터에서 바뀐 파일이 켜져 있는 동안 내려올 수 있어요. 필요하면 파일을 지켜보다가 다시 읽어요.
- `cold: true` 묶음은 **안에 있는 파일이 하나라도 바뀌면 "사용함"**으로 쳐요. 열어 보기만 해도 기간이 다시 시작되게 하려면 열 때 작은 값(예: `openedAt`)을 저장해 주세요.
  서버에서 정리된 묶음을 다시 열면 그 컴퓨터에 남아 있던 파일이 모두 다시 올라가요.

## 5. 업데이트

- 프로그램 안의 자동 업데이트(electron-updater, `update_manager.py`)는 빼요. 통합 클라우드가 새 버전을 **옆 폴더에 받아 두고**, 다음에 켤 때 새 버전으로 켜요.
- 오래 켜 두는 프로그램(타종)은 `newer_version_installed(앱 ID, 지금 버전)` 으로 새 버전이 받아졌는지 보고, **알맞은 때**(예: 다음 종까지 10분 넘게 남음) 종료 코드 **75** 로 끝내면 통합 클라우드가 바로 새 버전으로 다시 켜요.

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
3. 함께 쓸 설정(시간표·세트·종소리 목록·지금 세트)을 `session.data_dir / "config.json"` 으로 내보내기 — 지금의 `backup.py` 형식을 그대로 써요.
   - 시간표를 바꿀 때마다(`ctx.changed`) 내보내고, 파일이 다른 컴퓨터에서 바뀌면(`QFileSystemWatcher`) `import_backup` 처럼 불러와요.
   - 기록(logs)과 오늘만 적용(overrides)은 컴퓨터마다 따로 (SQLite 에만).
4. `magoedu-app.json`
   ```json
   {
     "format": 1, "id": "tajong", "exe": "Mataf.exe",
     "sync": { "include": ["config.json", "sounds/**"] },
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
