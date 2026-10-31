// node_modules 의 글꼴(Pretendard)을 src/renderer/vendor 로 복사합니다. (npm install 때 자동 실행)
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = (...p) => join(root, 'src', 'renderer', 'vendor', ...p);

if (!existsSync(nm('pretendard'))) {
  console.log('[copy-vendor] devDependencies 가 없어 건너뜁니다.');
  process.exit(0);
}
mkdirSync(out('fonts'), { recursive: true });
cpSync(nm('pretendard', 'dist', 'web', 'variable', 'woff2', 'PretendardVariable.woff2'), out('fonts', 'PretendardVariable.woff2'));
cpSync(nm('pretendard', 'dist', 'LICENSE.txt'), out('fonts', 'LICENSE-Pretendard.txt'));
console.log('[copy-vendor] 글꼴 복사 완료 → src/renderer/vendor/fonts');
