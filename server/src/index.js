'use strict';

// 마고에듀 통합 클라우드 서버 - 구현민 개발
//   node src/index.js        (설정은 환경 변수 또는 .env 파일, README 참고)

const { createCloudServer, loadConfig, VERSION } = require('./app');

async function main() {
  const config = loadConfig();
  const app = createCloudServer(config);
  const addr = await app.listen();
  const build = app.deps.build?.commit ? ` (${app.deps.build.commit.slice(0, 7)})` : '';
  app.deps.log.info(`마고에듀 통합 클라우드 서버 ${VERSION}${build} - 구현민 개발`);
  app.deps.log.info(`http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port} 에서 실행 중 · 데이터: ${config.dataDir}`);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    app.deps.log.info('서버를 끄는 중...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
