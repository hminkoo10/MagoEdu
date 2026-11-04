'use strict';

// Electron 없이 암호화 저장·복호화 경로를 확인하는 테스트 대역이다.
const prefix = 'test-encrypted:';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(prefix + Buffer.from(text, 'utf8').toString('base64')),
  decryptString: (data) => {
    const text = data.toString('utf8');
    if (!text.startsWith(prefix)) throw new Error('복호화할 수 없어요.');
    return Buffer.from(text.slice(prefix.length), 'base64').toString('utf8');
  },
};

module.exports = { safeStorage };
