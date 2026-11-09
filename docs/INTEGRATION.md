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
| `singleInstance` | (선택) 기본 `true`. 중복 실행 시 기존 창에 열기 요청을 전달하고 바로 종료해야 해요. `false`면 창 복구에 두 번째 실행을 사용하지 않아요 |
| `shared` | (선택) **학원 공간** 규칙 `{ include, exclude, lazy }`. 같은 학원 사람들이 함께 쓰는 폴더(`MAGOEDU_ACADEMY_DIR`)를 맞춰요 (4-1번) |
| `dataSigning` | (선택) `true` 면 **설정 파일 서명 키**(`MAGOEDU_DATA_KEY`)를 받아요. 손으로 고친 설정 파일·백업을 프로그램이 거부할 수 있게 (4-2번) |
| `academyInfo` | (선택) `true` 면 학원 **학생 명단·학원 AI** 를 파일(`MAGOEDU_ACADEMY_INFO`)로 받고, 학생을 추가·고칠 수 있어요 (4-3번, 통합 클라우드 1.2.0 부터) |
| `sso` | (선택) 웹 프로그램 ID (예: `"mago-navi"`). 켤 때 그 웹 프로그램에 이 계정으로 로그인할 일회용 코드(`MAGOEDU_SSO_CODE`)를 받아요 (4-4번) |

서버 프로그램 목록(통합 클라우드 → 프로그램 관리)에는 저장소와 파일 이름 규칙만 적어 두면 돼요.
기본으로 들어 있는 규칙: `^OhdapNote-(\d+\.\d+\.\d+)-win-x64\.zip$`, `^MaplTajong-(\d+\.\d+\.\d+)-win-x64\.zip$`

## 2. 통합 클라우드가 넘겨주는 환경 변수

| 이름 | 내용 |
| --- | --- |
| `MAGOEDU_TICKET` | 실행 허가증 (서버가 Ed25519 로 서명, 기본 7일) |
| `MAGOEDU_DATA_DIR` | **동기화 폴더** — 같은 아이디면 모든 컴퓨터가 같은 내용 |
| `MAGOEDU_LOCAL_DIR` | 이 컴퓨터에만 두는 폴더 (캐시, 로그, SQLite 같은 것) |
| `MAGOEDU_APP_ID`, `MAGOEDU_USER_ID`, `MAGOEDU_USERNAME`, `MAGOEDU_USER_NAME`, `MAGOEDU_ROLE`, `MAGOEDU_ACADEMY` | 누가 켰는지 (확인된 값은 허가증 안에 있음) |
| `MAGOEDU_ACADEMY_DIR` | **학원 공간** — 같은 학원 사람들이 함께 쓰는 폴더 (매니페스트에 `shared` 가 있고 학원에 속한 계정만, 아니면 빈 값) |
| `MAGOEDU_REQUEST_DIR` | 통합 클라우드에 부탁을 적는 폴더: 학원 공간의 '열 때만 받는' 파일(4-1번), 학생 고치기(4-3번), 로그인 코드(4-4번). 셋 다 쓰지 않으면 빈 값 |
| `MAGOEDU_ACADEMY_ID` | 학원 번호 (학원 공간을 쓰지 않으면 빈 값) |
| `MAGOEDU_DATA_KEY` | 설정 파일 서명 키 (매니페스트 `dataSigning` 인 프로그램만, 아니면 빈 값. 예전 서버도 빈 값). 디스크·로그·화면에 남기지 마세요 (4-2번) |
| `MAGOEDU_ACADEMY_INFO` | 학원 학생 명단·학원 AI 파일 `academy-info.json` (매니페스트 `academyInfo`, 학원에 속한 계정만, 아니면 빈 값) |
| `MAGOEDU_SSO_CODE` | 웹 프로그램 일회용 로그인 코드, 60초 (매니페스트 `sso`. 인터넷이 없었으면 빈 값) |
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
- 프로그램 카드의 **⋯ → 바탕 화면 바로 가기**로 끄고 켤 수 있어요(처음에는 시작 메뉴에도 만듦). 프로그램을 삭제하면 바로 가기도 지워요.
- 실제 `.lnk`를 상태 조회·창 열기/포커스·15초 주기로 확인해요. 바탕 화면과 시작 메뉴에서 직접 지운 것은 각각 꺼진 상태로 저장하며, 업데이트·이름 변경·런처 재시작 때 되살리지 않아요. 메뉴에서 다시 켜면 두 위치에 다시 만들어요.
- 설치한 통합 클라우드에서만 만들어요 (개발 모드 `npm start` 에서는 만들지 않음).

### 실행 중인 프로그램 다시 누르기

- 프로그램 카드·트레이·바로가기로 실행 중인 프로그램을 다시 누르면 **기존 창 열기**, 종료는 메뉴의 **끄기**예요. 업데이트가 있어도 켜진 창을 먼저 열어요.
- Windows에서는 기존 PID(포장 실행 파일이면 자식 PID)의 보이는 창(최소화 포함)을 앞으로 가져와요. 트레이로 숨긴 창이면 원래 실행한 버전의 exe·인수·환경(허가증 포함)으로 두 번째 실행을 해서 프로그램이 스스로 창을 열게 해요. 연타는 합치며, 전달용 프로세스는 실행 기록·종료 동기화·자동 재시작에 포함하지 않아요. 5초 안에 끝나지 않으면 전달용 프로세스 트리를 정리하고 그 실행에는 다시 전달하지 않아요.
- 앱은 두 번째 실행에서 허가증 확인·새 창·데이터 작업·안내창 없이 기존 프로세스에 열기 요청을 보낸 뒤 바로 끝나야 해요. [Electron `second-instance`](https://www.electronjs.org/docs/latest/api/app#event-second-instance) 처리에서는 최소화된 창을 `restore()`, 숨겨진 창을 `show()`, 마지막으로 `focus()`해요. 타종(PyQt)은 `QLocalServer` 이름 있는 파이프로 요청을 받아 `showNormal()` → `raise_()` → `activateWindow()` 해요 (타종 2.2.7 부터).
- 런처 재시작 뒤에는 원래 환경을 보관하지 않으므로 PID로만 복구해요. 복구 불가·Windows 전경 전환 제한 시 작업 표시줄/트레이로 열거나 메뉴의 **끄기**를 사용하라는 안내를 보여 줘요. 허가증·환경은 실행 기록 파일에 저장하지 않아요.

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

## 4-1. 학원 공간 (같은 학원 사람들이 함께 쓰는 데이터)

매니페스트에 `shared` 를 넣으면, 학원에 속한 계정은 동기화 폴더와 별도로 **학원 공간**(`MAGOEDU_ACADEMY_DIR`)도 받아요.
같은 학원의 모든 사람이 같은 내용을 보고, 4번과 같은 방식(실시간, 원자적 저장, 충돌하면 `conflicts` 에 보관)으로 맞춰요.
학원이 없는 계정(운영자)은 빈 값이니, 그때는 동기화 폴더 안의 하위 폴더(예: `shared/`)를 같은 구조로 쓰면 돼요 (공유는 되지 않음).

```json
"shared": { "include": ["**"], "lazy": ["books/*/*.pdf", "books/*/*.png"] }
```

**누가 보고 누가 고치는지는 경로로 정해요** (어느 프로그램이든 같음):

| 경로 | 보기 | 고치기·지우기 | 예 |
| --- | --- | --- | --- |
| `members/<계정 ID>/...` | 그 사람, 원장 | 그 사람만 | 선생님마다 만든 것 (`<계정 ID>` 는 `MAGOEDU_USER_ID`) |
| `students/<학생 ID>/...` (세 단계 이상) | 학원 모두 | 학원 모두 (담당 선생님은 바뀔 수 있으니) | 학생별 오답노트 `students/<학생 ID>/notes/<노트 ID>.json`. `<학생 ID>` 는 학생 명단(4-3번)의 ID |
| `<폴더>/<이름>/...` (두 단계 이상) | 학원 모두 | 그 묶음을 처음 올린 사람(주인), 원장 | `books/<교재 ID>/book.json` — 묶음은 앞의 두 단계 |
| `<파일>` (한 단계) | 학원 모두 | 원장만 | `academy.json` (학원 공용 설정) |

- 운영자는 원장과 같아요. 서버는 파일마다 마지막으로 고친 사람의 계정 ID(`updatedBy`)를 기록해요. 화면에 '만든 사람'을 보이려면 파일 안에 이름을 함께 저장해 주세요.
- **고칠 권한이 없는 파일을 바꾸거나 지우면** 통합 클라우드가 서버 것으로 되돌려요 (서버에 없으면 지움). 바꾼 내용은 `conflicts` 폴더에 보관하고 알려 줘요.
  그러니 남의 파일은 화면에서 읽기 전용으로 보여 주고, 열기만 할 때는 쓰지 마세요.
- 학원 공간은 계정 용량과 따로 **학원마다 용량 한도**가 있어요 (운영자가 학원 관리에서 정함, 기본은 서버 설정의 '학원마다 학원 공간'). 넘으면 올리기가 507 `academy_quota_exceeded`. 서버 보관 기간 정리는 없어요.
- `students/<학생 ID>/...` 는 그 학생의 상태를 따라요.
  - 명단에 있는 학생: 학원 모두가 고쳐요.
  - **지운 학생**(되살릴 수 있는 기간): 읽기만 돼요. 고치면 위처럼 서버 것으로 되돌려요.
  - **명단에 아직 없는 학생**: 되돌리지 않고 다음 동기화 때 다시 올려요 (학생을 막 추가한 경우). 학생 추가(4-3번)를 먼저 하고 파일을 쓰면 바로 올라가요.
  - **완전히 지운 학생**(기본 30일 동안 아무도 되살리지 않음): 서버가 그 학생의 파일을 모든 프로그램에서 지우고, 모든 PC 에서도 지워져요.
- **계정을 지우면** 그 사람이 학원 공간에 남긴 것은 같은 학원 원장(지울 때 고름)에게 넘어가요.
  - `members/<지운 계정>/<폴더>/...` → `members/<원장>/<폴더>/...` (옛 자리는 지운 것으로 알림). 원장에게 같은 경로가 이미 있으면 옮기지 않고 원래 자리에 둬요 (원장은 볼 수 있음).
  - `members/<지운 계정>/<파일>` (바로 아래 파일, 예: 이름을 적은 `profile.json`)은 그 사람에 대한 것이라 옮기지 않아요. 그러니 내용은 폴더 안에 두세요.
  - 그 사람이 주인인 묶음은 원장이 주인이 되고, 학생 명단의 담당 선생님도 원장으로 바뀌어요. 넘겨받을 원장이 없으면 모두 그대로 남아요.
- 같은 파일을 여러 사람이 동시에 고치면 먼저 올라간 것을 쓰고, 밀려난 내 것은 `conflicts` 폴더에 보관하고 알려 줘요.
  학생별 노트처럼 여럿이 함께 고치는 파일은 저장하기 직전에 파일이 그사이 바뀌었는지 보고 합쳐서 저장해 주세요 (열 때 읽은 내용·내 것·지금 파일로 3-way).

**열 때만 받기** (`shared.lazy`): 큰 파일(교재 PDF 같은 것)은 동기화할 때 받지 않고, 프로그램이 달라고 할 때만 받아요.
한 번 받은 파일은 그 뒤로 보통 파일처럼 계속 맞춰요. 내가 만든 파일은 처음부터 내 컴퓨터에 있으니 그대로 맞춰요.

```js
const r = await cloud.requestFiles(session, ['books/b1/problem.pdf']); // SDK. 이미 있는 파일은 건너뜀
if (!r.ok) showError(r.missing, r.error); // 서버에 없음, 인터넷 끊김, 시간 지남(기본 2분)
```

받지 않은 파일은 폴더에서 지울 수 없으니, 지울 때(예: 교재 삭제)는 `await cloud.removeFiles(session, paths)` 로 서버에서 지워 달라고 해요.

SDK 없이 하려면 `MAGOEDU_REQUEST_DIR/<요청 ID>.json` 에 `{ "paths": [...] }`(받기) 또는 `{ "remove": [...] }`(지우기)를 원자적으로 쓰세요 (요청 ID 는 영문·숫자·`-`·`_`, 64자까지).
통합 클라우드가 받은 뒤 `<요청 ID>.done.json` `{ "ok": true, "missing": [] }` 로 답하고 요청 파일을 지워요. 답은 읽은 뒤 지워 주세요.

## 4-2. 설정 파일 서명 (`dataSigning`)

동기화 폴더는 누구나 열어 볼 수 있어서, 설정 파일(예: 타종 `config.json`, 오답노트 `settings.json`)을 손으로 고치면 그대로 적용되고 다른 컴퓨터로도 퍼져요.
매니페스트에 `"dataSigning": true` 를 넣으면 통합 클라우드가 `MAGOEDU_DATA_KEY` 를 넘겨주니, **프로그램이 쓴 파일에 서명하고, 서명이 없거나 맞지 않는 파일은 쓰지 마세요.**
키는 서버마다 하나라서 같은 서버의 다른 계정·다른 컴퓨터·안드로이드 앱이 만든 파일과 백업도 확인할 수 있어요. 키가 빈 값이면(예전 통합 클라우드·서버) 서명하지 않고 지금처럼 써요.

서명 방법 (Python·Kotlin·JS 가 같은 결과가 나오게 JSON 을 다시 정리하지 않고 파일 글자 그대로 씀):

1. 맨 위에 `"sig": "000…0"`(0 64개)를 넣은 채로 평소처럼 JSON 을 만들고 UTF-8 바이트 B 로 바꿔요.
2. `sig` = HMAC-SHA256(키 = `MAGOEDU_DATA_KEY` 글자의 UTF-8, 내용 = B) 를 소문자 16진수(64자)로.
3. B 의 0 64개 자리를 `sig` 로 바꿔 저장해요 (길이가 같아 다른 곳은 그대로).

확인: 파일 바이트를 그대로(BOM·공백도 그대로) 읽어 `"sig"\s*:\s*"([0-9a-f]{64})"` 가 **딱 한 번** 나오는지 보고, 그 64자를 0 으로 바꾼 바이트로 HMAC 을 다시 계산해 같은지 봐요 (시간이 일정한 비교).
같은 키 `test-key` 와 내용 `{"app":"tajong","sig":"000…0","v":1}` 로 프로그램마다 같은 값이 나오는지 시험해 두세요.

- **서명이 없거나 맞지 않으면** 적용하지 말고, 지금 상태를 서명해서 다시 쓰세요 (손으로 고친 것이 되돌려지고 다른 컴퓨터로 퍼지지 않음). 그 컴퓨터에 아직 데이터가 없으면(새로 설치) 덮어쓰지 말고 무시만 해요.
- 예전 버전이 쓴 파일에는 서명이 없어요. 이 컴퓨터에서 처음 서명된 파일을 쓰거나 읽기 전까지만 서명 없는 파일을 한 번 받아들이고(그 표시는 `MAGOEDU_LOCAL_DIR` 처럼 동기화하지 않는 곳에), 그 뒤로는 거부해요.
- 백업 파일도 같은 방법으로 서명하고, 불러올 때 서명이 없거나 맞지 않으면 거부해요.
- 안드로이드처럼 통합 클라우드 없이 서버에 붙는 앱은 `GET /api/me/data-key` → `{ dataKey }` 로 받아요 (404 면 예전 서버, 웹 화면 세션에는 403 `web_session`).

## 4-3. 학원 학생 명단·학원 AI (`academyInfo`, 통합 클라우드 1.2.0)

학생은 **학원에 속해요.** 명단은 통합 클라우드 서버 한 곳에 있고, 학원 사람(원장·선생님) 누구나 추가·고치기·지우기·되살리기를 해요 (통합 클라우드 앱·웹의 **학생 명단** 화면, 또는 프로그램에서).
지운 학생은 기본 30일 동안 누구나 되살릴 수 있고, 그 뒤에는 완전히 지워요(4-1번).

**학원 AI**: 원장이 통합 클라우드의 **학원 AI** 화면에서 기본 AI 하나를 정하면 학원 사람 모두의 프로그램이 함께 써요. 세부 설정으로 프로그램마다 다른 AI 를 정할 수도 있어요.
프로그램은 자기 것(없으면 기본)을 받아요. 사람마다 프로그램 안에서 "학원 AI(기본) / 내 키"를 고를 수 있게 해 주세요.

매니페스트에 `"academyInfo": true` 를 넣으면, 통합 클라우드가 켤 때와 명단·AI 가 바뀔 때마다(실시간) `MAGOEDU_ACADEMY_INFO` 파일을 새로 써요 (원자적으로 바꿔치기).

```json
{
  "format": 1,
  "academy": { "id": 3, "name": "마고학원", "subjects": ["math", "english"] },
  "me": { "id": "<계정 ID>", "name": "김선생", "role": "teacher" },
  "members": [{ "id": "<계정 ID>", "name": "김선생", "role": "teacher", "roleLabel": "선생님" }],
  "students": [{ "id": "…", "name": "홍길동", "school": "마고고", "grade": "고1", "teacher": { "id": "…", "name": "김선생" },
                 "memo": "", "rev": 3, "updatedBy": { "id": "…", "name": "이선생" }, "updatedAt": 0, "deletedAt": null, "purgeAt": null }],
  "purged": ["<완전히 지운 학생 ID>"],
  "purgeDays": 30,
  "ai": { "provider": "gemini", "model": "", "model2": "", "rpm": null, "source": "app", "hasKey": true, "relay": true },
  "updatedAt": 0
}
```

- `academy.subjects` 는 학원이 계약한 과목이에요 (`math`·`english`·`korean`, 이 순서, 비어 있을 수 있어요). 없으면(예전 통합 클라우드) `["math"]` 로 보세요. 운영자가 바꾸면 곧바로 파일을 새로 써요 (통합 클라우드 1.2.13 부터).
- `students` 에는 지운 학생(`deletedAt`)도 있어요. 화면에서는 숨기거나 '되살리기'로 보여 주세요. `ai` 는 학원 AI 가 없으면 `null` 이고, `provider` 는 `gemini` · `openai`(OpenAI 호환) · `anthropic` 이에요.
- **학원 AI 키는 프로그램에 오지 않아요** (서버에만 있고, 원장도 끝 4자리만 봐요). `cloud.academyAi(session)` 이 부를 곳을 알려 줘요 → `{ provider, model, model2, rpm, source, baseUrl, apiKey }`.
  그 AI 의 주소·키 자리에 그대로 넣어 부르면 돼요.
  - `relay: true` → `baseUrl` 은 `<서버>/api/ai/relay/<프로그램 ID>`, `apiKey` 는 실행 허가증(`MAGOEDU_TICKET`). 서버가 진짜 키로 바꿔 보내요.
    요청·응답 모양은 그 AI 그대로예요: Gemini `…/v1beta/models/<모델>:generateContent` · `…/v1beta/models` (키는 `x-goog-api-key` 머리글, 주소의 `?key=` 는 버려요),
    OpenAI 호환 `…/chat/completions` · `…/models` (`Authorization: Bearer`), Claude `…/v1/messages` · `…/v1/models` (`x-api-key`).
    생성·모델 목록 말고 다른 주소(파일 올리기 등)는 403 `relay_path`, 사람·프로그램마다 10분에 600번까지(429 `rate_limited`).
    통합 클라우드에서 로그아웃하거나 사용이 중지되면 401 이에요.
  - `direct: true` → 학원 AI 주소가 학원 안 주소(192.168.x.x, `*.local` 등)라 서버가 부를 수 없어요. 각 PC 에서 `baseUrl` 로 바로 부르세요 (키 없음).
- 인터넷이 없으면 지난번 파일 그대로예요. 파일이 바뀌면 다시 읽어 주세요 (`watchAcademyInfo`).

```js
const info = cloud.academyInfo(session);                       // 없으면 null
const ai = cloud.academyAi(session);                           // 학원 AI 를 부를 곳 (없으면 null)
const stop = cloud.watchAcademyInfo(session, (info) => refresh(info));
const r = await cloud.saveStudent(session, { id: newId, name: '홍길동', grade: '고1', teacherId: me });  // 추가 (id 는 영문·숫자·-, 8~64자, 생략 가능)
const u = await cloud.saveStudent(session, { ...student, memo: '…' });   // rev 가 있으면 고치기
if (!u.ok && u.errorCode === 'conflict') showLatest(u.student);          // 그사이 다른 사람이 고침 → 지금 것
await cloud.deleteStudent(session, id);
await cloud.restoreStudent(session, id);
```

- 답은 `{ ok, student }` 또는 `{ ok: false, error, errorCode }` 예요 (`conflict` · `student_deleted` · `invalid_name` · `offline` · `timeout` …). 인터넷이 있어야 해요.
- 답하기 전에 `academy-info.json` 도 새로 써요. 그리고 명단에 없어서 미뤄 둔 학생 폴더 파일을 바로 올려요.
- SDK 없이: `requests/<요청 ID>.json` 에 `{ "op": "students.save", "student": {...} }` · `{ "op": "students.delete", "id": "…" }` · `{ "op": "students.restore", "id": "…" }` 를 쓰면
  `<요청 ID>.done.json` 에 `{ "ok": true, "missing": [], "student": {...} }` 또는 `{ "ok": false, "missing": [], "error": "…", "errorCode": "…" }` 로 답해요.

## 4-4. 웹 프로그램과 로그인 (`sso`, 통합 클라우드 1.2.0)

프로그램 목록에는 **웹 프로그램**(플랫폼 '웹', 주소만 있음)도 넣을 수 있어요. 통합 클라우드 앱·웹에서 **열기**를 누르면 브라우저로 열고, 설치·동기화는 하지 않아요.
웹 프로그램은 통합 클라우드 계정으로만 로그인해요.

1. 웹 프로그램이 브라우저를 `https://<통합 클라우드>/#/sso?app=<웹 프로그램 ID>&state=<임의 값>` 으로 보내요 (state 는 쿠키에도 저장).
2. 통합 클라우드 웹 화면이 로그인을 확인한 뒤(안 했으면 로그인부터) 60초짜리 일회용 코드를 받아
   `<웹 프로그램 주소>/api/auth/mago/callback?code=<코드>&state=<값>` 으로 보내요. 돌아갈 주소는 서버가 정해요(프로그램 관리의 주소).
3. 웹 프로그램 **서버**가 state 를 쿠키와 비교한 뒤 `POST /api/sso/token { appId, secret, code }` 로 코드를 바꿔요.
   `secret` 은 운영자가 **프로그램 관리 → 앱 비밀값 만들기**에서 한 번만 보여 주는 값이에요 (웹 프로그램 서버의 환경 변수에만 두세요).
   → `{ token, user }`. `token` 은 **그 프로그램 전용 세션**이라 `/api/me`, 학생 명단(`/api/students…`, `/api/academy/members`), `GET /api/academy/ai`(자기 프로그램 것),
   학원 AI 중계 `/api/ai/relay/<자기 프로그램 ID>/…`(키 자리에 이 토큰, 4-3번)만 쓸 수 있어요.
   로그아웃(`POST /api/auth/logout`)·비밀번호 초기화·사용 중지되면 같이 끊겨요. 코드는 한 번만 쓸 수 있어요.

PC 에서 웹 프로그램을 창으로 여는 프로그램(예: 마고 과목내비 PC)은 매니페스트에 `"sso": "<웹 프로그램 ID>"` 를 넣어요.
통합 클라우드가 켤 때 코드를 받아 `MAGOEDU_SSO_CODE` 로 넘기고(`session.ssoCode`), 실행 중에 다시 필요하면 `await cloud.ssoCode(session)` → `{ ok, code, expiresAt }` 으로 받아요.
코드를 웹 프로그램 서버에 넘기면(예: `POST /api/auth/mago/code`) 서버가 3번처럼 바꿔요. 7일짜리 실행 허가증은 웹 프로그램에 넘기지 않아요.


## 4-5. 보호자 계정·연락처·동의

보호자 계정은 통합 클라우드에만 둡니다. 시험판은 **계정 하나 = 학원 하나**이며 같은 학원의 여러 자녀를 연결할 수 있습니다.
원장 관리 화면은 학원운영 앱에서 구현합니다. 아래 관리 API는 일반 세션과 원장·선생님의 앱 전용 세션 모두 받습니다.
운영자는 `?academy=<학원 ID>` 필수. 원장은 자기 학원, 선생님은 `students.teacher_uid`가 자기 uid인 학생만 조회합니다.
전화번호 평문은 이 관리 API에서 원장·운영자(학원 지정)·담당 선생님에게만 반환합니다. 자기 정보 API에도 전화번호는 없습니다.

### 관리 API

공통 접두사 `G = /api/students/:sid/guardians`. 보호자 응답은 `{id, academy_id, student_id, name, relation, phone, notify, is_primary, user_id, created_by, created_at, updated_at, rev}`입니다.

| 메서드·경로 | 역할 | 입력 / 응답 |
| --- | --- | --- |
| GET G | 원장·담당 선생님·운영자 | `{guardians: [...]}` |
| POST G | 원장·운영자 | `{name,relation,phone,notify:boolean,isPrimary:boolean}` → `{guardian}` |
| PATCH G/:gid | 원장·운영자 | `{rev,...변경 항목}` → `{guardian}`; 충돌 409 |
| DELETE G/:gid | 원장·운영자 | 연락처와 해당 초대·동의 삭제 → `{ok:true}` |
| POST G/:gid/invite | 원장·운영자 | `{code,expiresAt}`; 7일, 해시만 저장, 재발급 시 이전 코드 무효 |
| DELETE G/:gid/invite | 원장·운영자 | 초대 취소 → `{ok:true}` |
| DELETE G/:gid/account-link | 원장·운영자 | 해당 자녀 연결 끊기, 계정·동의는 보존 → `{ok:true}` |
| GET G/:gid/consents | 원장·담당 선생님·운영자 | `{consents:[...]}` |
| POST G/:gid/consents | 원장·운영자 | `{item,version,method?:'paper'}` → `{consent}`; 서명한 종이 확인 후 기록 |
| POST G/:gid/consents/:cid/withdraw | 원장·운영자 | 선택 동의 철회 → `{ok:true}` |
| GET /api/guardian-accounts | 원장·운영자 | `{accounts:[{id:uid,username,name,childLinks}]}`; 자녀 없는 계정 포함 |
| DELETE /api/guardian-accounts/:uid | 원장·운영자 | 계정·세션 삭제, 연락처 연결 해제 → `{ok:true}` |

대표 보호자는 학생당 최대 한 명. 대표 변경 시 이전 대표의 rev도 증가합니다.
생성·수정 API에서 user_id를 직접 지정할 수 없습니다. 계정 연결은 초대로만 합니다.

### 가입·자기 정보

- `GET /api/auth/codes/:code`, `GET /api/join/:code`: 보호자 초대이면 `{role:'guardian',academyName,studentName,consentVersion}`. 기존 학생 흐름 보존.
- `POST /api/join`: `{code,name,username,password,consentVersion,consents:{collect:true,messaging?:boolean}}` → `{token,user,server}`. 현재 판은 `2026-11-09`. 비밀번호는 기존 정책 적용. `overseas_ai`, `marketing` 등 지원하지 않는 동의 항목을 보내면 400으로 거절합니다.
- 같은 학원 보호자 일반 세션의 Bearer를 붙이면 새 계정 없이 자녀만 연결합니다. 다른 역할·학원은 403이며 로그아웃 후 그 학원용 계정을 만들어야 합니다.
- 코드 조회·가입 실패 횟수는 기존 joinCodes와 공유합니다. 한 번 쓴 코드는 재사용 불가.
- `GET /api/me`: `user.role='guardian'`, `academy`, `children:[{studentId,name,guardianId}]`. 지웠거나 purge한 자녀는 제외. 연결 없는 계정도 로그인 가능.
- `GET /api/me/guardians`: 일반 보호자 세션만. `{guardians:[전화번호 없는 연락처],apps:[{id,name,url}]}`. 앱 목록은 활성 웹 프로그램 중 guardianEnabled와 계정 앱 권한 모두 충족한 것만.
- `GET /api/me/consents`: 일반·앱 전용 보호자 세션. `{consents:[...]}`.
- `POST /api/me/consents/:cid/withdraw`: 일반 보호자 세션만. 본인의 선택 동의만 철회. collect는 400 `required_consent`.
- 일반 보호자는 로그아웃·비밀번호 변경·SSO 외 기존 기능을 사용할 수 없습니다. 중앙 기본 차단이 공개 API와 아직 없는 경로에도 적용됩니다.

### SSO·동의·삭제

프로그램 관리의 **보호자 사용 가능**(`guardianEnabled`, 기본 false)은 웹에만 유효합니다. 기존 앱 생성·수정 API에서 설정합니다.
SSO 인가·코드 교환 시 모두 재검사하고, 보호자 앱 세션은 이후 요청에서도 앱 허용 여부를 재검사합니다.
보호자 앱 세션은 `GET /api/me`, `GET /api/me/consents`, `POST /api/auth/logout`만 허용합니다. 로그아웃은 해당 앱 세션을 삭제합니다. 원장·담당 선생님의 앱 세션은 위 관리 API를 각자의 역할 범위에서 사용합니다.

동의 표와 종이 기록의 항목은 `collect`, `messaging`, `overseas_ai`, `marketing`으로 유지합니다. 현재 가입 API와 보호자 화면은 `collect`(필수), `messaging`(선택)만 받거나 보여 줍니다. 해외 이전·광고 동의는 기능 도입 시 받는 곳·국가·내용을 안내하고 따로 받습니다. 응답은 DB 필드와 `verified`를 포함합니다.
화면의 수집·이용 동의문은 [개인정보 보호법 제15조 제2항](https://www.law.go.kr/LSW/lsLinkProc.do?joLnkStr=%EC%A0%9C15%EC%A1%B0&lsNm=%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%EB%B2%95&mode=11)의 목적·항목·보유 기간·거부 권리와 불이익을 구분해 안내합니다.
`method='paper'` 또는 `sms_confirmed_at != null`이면 verified=true. 온라인 가입은 항상 문자 확인 전(false)으로 저장합니다.
`confirmConsentSms(db,id,at?)`는 성공한 확인 문자 발송을 연결할 **내부 함수**이며 HTTP API는 없습니다. 아직 문자 발송은 하지 않습니다.
만 14세 미만의 법정대리인 확인을 체크박스만으로 완료한 것으로 취급하면 안 됩니다.
선택 항목의 실제 발송 업체·국가·이전 조건은 후속 기능 도입 전에 확정·고지하고 필요한 별도 동의를 받아야 합니다. 이 작업만으로 알림·해외 이전을 실행하지 않습니다.

학생 purge 시 guardians를 삭제하고 외래 키 CASCADE로 초대·동의를 함께 삭제합니다. 자녀가 없는 보호자 계정은 자동 삭제하지 않습니다.
연락처는 `<DATA_DIR>/keys/guardian.key`의 AES-256-GCM 키로 암호화합니다. DB와 keys를 함께 백업해야 하며, 키 유실 시 전화번호 복호화 불가입니다.
마이그레이션 13은 foreign_keys를 트랜잭션 밖에서 끈 뒤 users 재구성·행 복사·색인/트리거 및 증가번호 복원·foreign_key_check 후 커밋합니다. user_version으로 재실행을 방지합니다.


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

### 오답노트 (`hminkoo10/ohdapnote`, 0.3.0 부터 연결됨)

- 학원 공간(4-1번)을 써요: 교재 `books/<id>/`(생성자 `createdBy`, 원본은 `shared.lazy` 로 열 때만 받음), 학생 명단 `students/`,
  학원 공용 AI 키 `academy.json`, 선생님별 오답노트 `members/<계정>/notes/`. 개인 공간에는 `settings.json` 만.
- 0.4.0 부터 학생별: 명단은 4-3번(`academyInfo`), 노트는 `students/<학생 ID>/notes/`, 학원 AI 는 통합 클라우드에서 (`academy.json` 은 쓰지 않음).
  서버는 예전 학생 파일(`students/<id>.json`)을 같은 ID 로 명단에 넣고 `academy.json` 의 키를 학원 기본 AI 로 가져와요.
  카탈로그의 오답노트 최신 버전이 0.4.0 이상이 되면 `members/<계정>/notes/` 의 노트를 학생 폴더로 옮겨요 (학생을 못 찾은 노트는 그대로).
- 예전에 따로 설치한 데이터는 `legacy` 로 `local/legacy` 에 받아서 오답노트가 처음 켤 때 새 자리로 옮겨요.
- 자세한 것은 오답노트 저장소의 `src/main/main.js` '저장 위치'와 `magoedu-app.json`.

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
5. 컴퓨터 켜면 자동 실행: 타종의 `Run` 레지스트리 등록 대신 통합 클라우드의 "윈도우 시작 시 실행"을 써요 (타종은 기본으로 켜져 있음).
   윈도우가 켜지면서 통합 클라우드가 켜졌을 때(`--hidden`)만 실행하고, 쓰는 중에 통합 클라우드를 열거나 다시 로그인할 때는 실행하지 않아요.
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
4. 학원 공간(4-1번): `GET /api/sync/<앱 ID>/academy?since=…`, `GET|PUT|DELETE /api/sync/<앱 ID>/academy/file?path=…&baseRev=…`.
   규칙은 같고, 고칠 권한이 없으면 403 `not_owner`, 학원이 없는 계정은 404 `no_academy`. 목록에는 볼 수 있는 파일만 있고 파일마다 `updatedBy` 가 붙어요.

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
- 학원 공간이 바뀌면 그 학원 사람 모두에게 `{"appId":…,"seq":…,"deviceId":…,"scope":"academy"}` 를 보내요. `seq` 는 학원 공간 목록의 `seq` 와 비교해요.
- `event: academy` 는 그 학원 사람에게 `{"kind":"students"}`, `{"kind":"ai"}`, `{"kind":"academy"}` 를 보내요. `academy` 는 학원 이름·계약 과목이 바뀌었다는 뜻이에요. `/api/me` 를 먼저 다시 받은 뒤 `academy-info.json` 을 새로 써요. 다시 연결된 `hello` 때도 같은 순서로 갱신해요.
- 서버는 1분쯤마다 세션을 다시 확인해서 로그아웃·사용 중지된 연결은 끊어요. 세션 하나에 연결은 5개까지(넘으면 오래된 것부터 끊음).
- 끊기면 1초에서 시작해 두 배씩, 많아야 30초 간격으로 다시 붙고, 다시 붙으면 `since` 로 한 번 받아요. 70초 넘게 아무것도 오지 않으면(ping 포함) 끊긴 것으로 봐요.
- 서버 한 대 안에서만 알려요. nginx·Cloudflare 앞에 두어도 되고(25초 ping 으로 100초 끊김을 막음), 서버가 `x-accel-buffering: no` 를 보내니 nginx 가 모아 두지 않아요.
