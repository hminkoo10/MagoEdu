"""마고에듀 통합 클라우드 연결 (Python 프로그램용) - 구현민 개발

각 프로그램은 통합 클라우드에서 켜졌을 때만 동작한다. (개별 설치·실행 불가)
통합 클라우드는 프로그램을 켤 때 서버가 서명한 "실행 허가증"(MAGOEDU_TICKET)을 넘겨 주고,
프로그램은 이 파일 하나로 그 허가증을 확인한다. 외부 라이브러리는 필요 없다.

    import magoedu_cloud as cloud

    session = cloud.check("tajong")
    if session is None:
        # 안내 창을 띄우고 끝낸다 (cloud.REASON 에 이유)
        ...
        cloud.open_cloud("tajong")   # 통합 클라우드를 열어 이 프로그램을 켜 달라고 함
        sys.exit(0)

    session.data_dir     # 같은 아이디면 어느 컴퓨터에서든 같은 데이터 (서버와 동기화)
    session.local_dir    # 이 컴퓨터에만 두는 데이터 (캐시, 기록)
    session.user         # {"id", "username", "name", "role", "academy"}

개발할 때(빌드 전 소스로 실행)는 MAGOEDU_DEV=1 로 통합 클라우드 없이 켤 수 있다.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

__all__ = ["Session", "check", "verify_ticket", "open_cloud", "newer_version_installed", "RESTART_EXIT_CODE", "REASON"]

RESTART_EXIT_CODE = 75  # 이 값으로 끝내면 통합 클라우드가 바로 다시 켠다 (새 버전 적용)
TICKET_PREFIX = "MGT1"
CLOUD_DIR_NAME = "MagoEduCloud"
REASON = ""  # check() 가 None 을 돌려줄 때의 이유 (화면에 보여 줄 문장)


@dataclass
class Session:
    app_id: str
    user: dict
    data_dir: Path
    local_dir: Path
    server: str = ""
    launcher_version: str = ""
    expires_at: float = 0.0
    dev: bool = False
    payload: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Ed25519 서명 확인 (RFC 8032). cryptography 가 있으면 그것을 쓰고, 없으면 아래 순수 파이썬 구현.
# ---------------------------------------------------------------------------
_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _inv(x):
    return pow(x, _P - 2, _P)


def _xrecover(y):
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = (x * _I) % _P
    if x % 2 != 0:
        x = _P - x
    return x


_BY = (4 * _inv(5)) % _P
_BX = _xrecover(_BY)
_B = (_BX, _BY, 1, (_BX * _BY) % _P)


def _add(p1, p2):
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = ((y1 - x1) * (y2 - x2)) % _P
    b = ((y1 + x1) * (y2 + x2)) % _P
    c = (t1 * 2 * _D * t2) % _P
    d = (z1 * 2 * z2) % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return ((e * f) % _P, (g * h) % _P, (f * g) % _P, (e * h) % _P)


def _mul(s, pt):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, pt)
        pt = _add(pt, pt)
        s >>= 1
    return q


def _decode_point(s):
    if len(s) != 32:
        raise ValueError("bad point")
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        raise ValueError("bad point")
    x = _xrecover(y)
    if (x & 1) != sign:
        x = _P - x
    if (-x * x + y * y - 1 - _D * x * x * y * y) % _P != 0:
        raise ValueError("not on curve")
    return (x, y, 1, (x * y) % _P)


def _small_order(pt):
    # 8배 해서 항등원이 되는 점(작은 차수)은 키·서명으로 받지 않는다
    x, y, z, _ = _mul(8, pt)
    return x % _P == 0 and (y - z) % _P == 0


def _same(p1, p2):
    x1, y1, z1, _ = p1
    x2, y2, z2, _ = p2
    return (x1 * z2 - x2 * z1) % _P == 0 and (y1 * z2 - y2 * z1) % _P == 0


def _verify_pure(pub: bytes, msg: bytes, sig: bytes) -> bool:
    try:
        if len(sig) != 64:
            return False
        a = _decode_point(pub)
        r = _decode_point(sig[:32])
        if _small_order(a) or _small_order(r):
            return False
        s = int.from_bytes(sig[32:], "little")
        if s >= _L:
            return False
        h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % _L
        return _same(_mul(s, _B), _add(r, _mul(h, a)))
    except Exception:
        return False


def ed25519_verify(pub: bytes, msg: bytes, sig: bytes) -> bool:
    if os.environ.get("MAGOEDU_SDK_PURE") != "1":
        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

            try:
                Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
                return True
            except InvalidSignature:
                return False
        except ImportError:
            pass
    return _verify_pure(pub, msg, sig)


def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---------------------------------------------------------------------------
# 허가증
# ---------------------------------------------------------------------------
def _frozen():
    return bool(getattr(sys, "frozen", False))


def default_trust_file() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / CLOUD_DIR_NAME / "trust.json"


def trust_file() -> Path:
    # 빌드한 프로그램은 정해진 위치만 믿는다. (소스로 실행할 때만 환경 변수로 바꿀 수 있음)
    if not _frozen() and os.environ.get("MAGOEDU_TRUST_FILE"):
        return Path(os.environ["MAGOEDU_TRUST_FILE"])
    return default_trust_file()


def load_keys(path: Path | None = None) -> list:
    try:
        data = json.loads(Path(path or trust_file()).read_text(encoding="utf-8"))
        return [k for k in data.get("keys", []) if k.get("x") and k.get("kid")]
    except Exception:
        return []


def verify_ticket(ticket: str, keys: list, app_id: str | None = None, now: float | None = None):
    """확인되면 내용(dict), 아니면 None"""
    parts = str(ticket or "").split(".")
    if len(parts) != 3 or parts[0] != TICKET_PREFIX:
        return None
    try:
        payload = json.loads(_b64url(parts[1]).decode("utf-8"))
        sig = _b64url(parts[2])
    except Exception:
        return None
    key = next((k for k in keys if k.get("kid") == payload.get("kid")), None)
    if key is None:
        return None
    try:
        pub = _b64url(key["x"])
    except Exception:
        return None
    if not ed25519_verify(pub, f"{parts[0]}.{parts[1]}".encode("ascii"), sig):
        return None
    if not isinstance(payload.get("exp"), (int, float)) or payload["exp"] < (now if now is not None else time.time()):
        return None
    if app_id and payload.get("app") != app_id:
        return None
    return payload


def check(app_id: str) -> Session | None:
    """통합 클라우드에서 켜졌는지 확인한다. 아니면 None (이유는 REASON)."""
    global REASON
    env = os.environ
    if not _frozen() and env.get("MAGOEDU_DEV") == "1":
        base = Path(env.get("MAGOEDU_DEV_DIR") or (Path.cwd() / ".magoedu-dev"))
        s = Session(
            app_id=app_id,
            user={"id": "dev", "username": "dev", "name": "개발자", "role": "admin", "academy": ""},
            data_dir=Path(env.get("MAGOEDU_DATA_DIR") or base / "sync"),
            local_dir=Path(env.get("MAGOEDU_LOCAL_DIR") or base / "local"),
            dev=True,
        )
        s.data_dir.mkdir(parents=True, exist_ok=True)
        s.local_dir.mkdir(parents=True, exist_ok=True)
        REASON = ""
        return s

    ticket = env.get("MAGOEDU_TICKET", "")
    if not ticket:
        REASON = "이 프로그램은 마고에듀 통합 클라우드에서만 켤 수 있어요.\n통합 클라우드에 로그인한 뒤 ‘열기’를 눌러 주세요."
        return None
    keys = load_keys()
    if not keys:
        REASON = "마고에듀 통합 클라우드에 한 번 로그인해 주세요."
        return None
    payload = verify_ticket(ticket, keys, app_id)
    if payload is None:
        REASON = "실행 허가가 확인되지 않았어요. 통합 클라우드에서 다시 켜 주세요.\n(인터넷 없이 쓸 수 있는 기간이 지났다면 인터넷에 연결해 주세요.)"
        return None
    data_dir = env.get("MAGOEDU_DATA_DIR")
    local_dir = env.get("MAGOEDU_LOCAL_DIR")
    if not data_dir or not local_dir:
        REASON = "통합 클라우드에서 다시 켜 주세요."
        return None
    s = Session(
        app_id=app_id,
        user={
            "id": payload.get("sub"),
            "username": payload.get("usr"),
            "name": payload.get("nam"),
            "role": payload.get("rol"),
            "academy": env.get("MAGOEDU_ACADEMY", ""),
        },
        data_dir=Path(data_dir),
        local_dir=Path(local_dir),
        server=env.get("MAGOEDU_SERVER", ""),
        launcher_version=env.get("MAGOEDU_LAUNCHER_VERSION", ""),
        expires_at=float(payload["exp"]),
        payload=payload,
    )
    s.data_dir.mkdir(parents=True, exist_ok=True)
    s.local_dir.mkdir(parents=True, exist_ok=True)
    REASON = ""
    return s


def open_cloud(app_id: str | None = None) -> bool:
    """통합 클라우드를 연다 (설치되어 있으면). app_id 를 주면 그 프로그램을 켜 달라고 한다."""
    url = f"magoedu://launch/{app_id}" if app_id else "magoedu://open"
    try:
        if sys.platform == "win32":
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            import subprocess

            subprocess.Popen(["xdg-open" if sys.platform.startswith("linux") else "open", url])
        return True
    except Exception:
        return False


def _parse_version(v):
    nums = [int(x) for x in re.findall(r"\d+", str(v))[:4]]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def newer_version_installed(app_id: str, current_version: str) -> str | None:
    """통합 클라우드가 새 버전을 받아 두었으면 그 버전 (프로그램을 75 로 끝내면 새 버전으로 다시 켜짐)"""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / CLOUD_DIR_NAME
    else:
        base = default_trust_file().parent / "local"
    try:
        info = json.loads((base / "apps" / app_id / "installed.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    v = info.get("version")
    return v if v and _parse_version(v) > _parse_version(current_version) else None
