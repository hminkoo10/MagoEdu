'use strict';

// 바탕 화면·시작 메뉴 바로 가기 (Windows, Steam 처럼)
//   대상은 통합 클라우드(이 exe) + 인수 magoedu://launch/<프로그램 ID> 라서, 로그인은 통합 클라우드에 그대로 두고
//   누르면 통합 클라우드가 그 프로그램을 켠다. 아이콘만 설치한 프로그램의 exe 에서 빌려 온다
//   (버전마다 폴더가 달라서 업데이트할 때마다 다시 쓴다).

const fs = require('node:fs');
const path = require('node:path');

/** 프로그램 이름 → 바로 가기 파일 이름 (Windows 에서 못 쓰는 글자는 뺌) */
function linkName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${clean || '마고에듀 프로그램'}.lnk`;
}

class Shortcuts {
  constructor({ shell, exePath, desktopDir, startMenuDir, log = console }) {
    this.shell = shell;
    this.exePath = exePath;
    this.desktopDir = desktopDir;
    this.startMenuDir = startMenuDir;
    this.log = log;
  }

  fileName(name) {
    return linkName(name);
  }

  _files(file) {
    return [path.join(this.desktopDir, file), path.join(this.startMenuDir, file)];
  }

  exists(file) {
    if (!file) return { desktop: false, startMenu: false };
    const [desktop, startMenu] = this._files(file);
    return { desktop: fs.existsSync(desktop), startMenu: fs.existsSync(startMenu) };
  }

  /** 만들거나 다시 쓴다. 쓴 파일 이름을 돌려준다. previous: 지난번 이름 (프로그램 이름이 바뀌었으면 지움) */
  write({ id, name, description, icon, desktop, startMenu = true, previous }) {
    const file = linkName(name);
    if (previous && previous !== file) this.remove(previous);
    const [desk, start] = this._files(file);
    const opts = { target: this.exePath, args: `magoedu://launch/${id}`, description: description || name, icon, iconIndex: 0 };
    if (startMenu) {
      fs.mkdirSync(this.startMenuDir, { recursive: true });
      if (!this.shell.writeShortcutLink(start, 'create', opts)) throw new Error('시작 메뉴 바로 가기를 만들지 못했어요.');
    }
    if (desktop) {
      if (!this.shell.writeShortcutLink(desk, 'create', opts)) throw new Error('바탕 화면 바로 가기를 만들지 못했어요.');
    } else {
      this._removeOne(desk);
    }
    return file;
  }

  /** 통합 클라우드가 만든 바로 가기만 지운다 (같은 이름의 다른 바로 가기는 그대로) */
  remove(file, { desktopOnly = false } = {}) {
    if (!file) return;
    const [desk, start] = this._files(file);
    this._removeOne(desk);
    if (!desktopOnly) this._removeOne(start);
  }

  _removeOne(file) {
    try {
      if (!fs.existsSync(file)) return;
      const link = this.shell.readShortcutLink(file);
      if (path.resolve(link.target || '').toLowerCase() !== path.resolve(this.exePath).toLowerCase()) return;
      fs.rmSync(file, { force: true });
    } catch (err) {
      this.log.warn?.('[바로 가기] 지우지 못했어요', file, err.message);
    }
  }
}

module.exports = { Shortcuts, linkName };
