'use strict';

// 통합 클라우드가 쓰는 폴더
//
//   %APPDATA%\MagoEduCloud\                 (userData)
//     config.json                           서버 주소, 기기 ID, 설정
//     session.dat                           로그인 정보 (Windows 암호화)
//     trust.json                            서버 공개 키 (각 프로그램이 실행 허가증을 확인할 때 씀)
//     accounts\<계정 ID>\
//       tickets.json                        실행 허가증 (인터넷이 끊겨도 정해진 기간 동안 실행)
//       <프로그램 ID>\
//         sync\                             서버와 동기화하는 데이터 (같은 아이디면 어느 컴퓨터든 같음)
//         local\                            이 컴퓨터에만 두는 데이터 (캐시, 기록 등)
//         conflicts\                        동시에 고쳐서 밀려난 파일 보관
//         .sync-state.json
//         academy\                          학원 공간 (같은 학원 사람들이 함께 쓰는 파일, 매니페스트에 shared 가 있을 때)
//         conflicts\academy\  .academy-sync-state.json   학원 공간에서 밀려난 파일, 맞춘 상태
//         library\                          마고 공용 책장 (받기 전용)
//         .library-sync-state.json            공용 책장 맞춤 상태
//         requests\                         프로그램이 '이 파일 받아 줘'를 적는 곳 (학원 공간의 lazy 파일)
//
//   %LOCALAPPDATA%\MagoEduCloud\
//     apps\<프로그램 ID>\<버전>\            설치한 프로그램
//     apps\<프로그램 ID>\installed.json
//     downloads\                            받는 중인 파일

const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

function safeId(id) {
  const s = String(id || '');
  if (!SAFE_ID.test(s) || s === '.' || s === '..') throw new Error(`잘못된 ID: ${s}`);
  return s;
}

function makePaths({ userData, localData }) {
  const accounts = path.join(userData, 'accounts');
  return {
    userData,
    localData,
    configFile: path.join(userData, 'config.json'),
    sessionFile: path.join(userData, 'session.dat'),
    trustFile: path.join(userData, 'trust.json'),
    legacyFile: path.join(userData, 'legacy-imported.json'),
    appsDir: path.join(localData, 'apps'),
    downloadsDir: path.join(localData, 'downloads'),
    account(uid) {
      const root = path.join(accounts, safeId(uid));
      return {
        root,
        tickets: path.join(root, 'tickets.json'),
        settings: path.join(root, 'settings.json'),
        app(appId) {
          const a = path.join(root, safeId(appId));
          return {
            root: a,
            sync: path.join(a, 'sync'),
            local: path.join(a, 'local'),
            conflicts: path.join(a, 'conflicts'),
            state: path.join(a, '.sync-state.json'),
            legacy: path.join(a, '.legacy.json'),
            academy: path.join(a, 'academy'),
            academyConflicts: path.join(a, 'conflicts', 'academy'),
            academyState: path.join(a, '.academy-sync-state.json'),
            library: path.join(a, 'library'),
            libraryState: path.join(a, '.library-sync-state.json'),
            requests: path.join(a, 'requests'),
            academyInfo: path.join(a, 'academy-info.json'),
          };
        },
      };
    },
    app(appId) {
      const root = path.join(this.appsDir, safeId(appId));
      return { root, installed: path.join(root, 'installed.json'), running: path.join(root, 'running.json') };
    },
  };
}

module.exports = { makePaths, safeId };
