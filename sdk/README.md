# 통합 클라우드 연결 도구 (SDK)

프로그램이 **마고에듀 통합 클라우드에서 켜졌는지** 확인하고, 계정별 데이터 폴더를 알려 주는 파일이에요.
프로그램 저장소에 그대로 복사해서 써요. 외부 라이브러리는 필요 없어요.

| 파일 | 쓰는 곳 |
| --- | --- |
| `python/magoedu_cloud.py` | 마고 타종 (PyQt6) 같은 Python 프로그램 |
| `node/magoedu-cloud.js` | 오답노트 같은 Electron 프로그램 (메인 프로세스) |

```python
import magoedu_cloud as cloud
session = cloud.check("tajong")          # 아니면 None, 이유는 cloud.REASON
session.data_dir, session.local_dir, session.user
```

```js
const cloud = require('./magoedu-cloud');
const session = cloud.check('ohdapnote', { packaged: app.isPackaged }); // 아니면 null, 이유는 cloud.reason()
```

- 실행 허가증은 서버가 Ed25519 로 서명해요. Python 쪽은 `cryptography` 가 있으면 그것을, 없으면 들어 있는 순수 파이썬 구현을 써요.
- 개발할 때는 `MAGOEDU_DEV=1` 로 통합 클라우드 없이 켤 수 있어요 (빌드한 프로그램에서는 안 됨).
- Node: 학원 공간(같은 학원 사람들이 함께 쓰는 폴더)은 `session.academyDir`, 열 때만 받는 파일은 `await cloud.requestFiles(session, paths)` 로 받아요.
- 자세한 연결 방법: [docs/INTEGRATION.md](../docs/INTEGRATION.md)

시험: `npm test` (서버를 띄워 실제 허가증으로 확인)
