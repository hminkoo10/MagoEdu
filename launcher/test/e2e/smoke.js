const { startAll } = require('./harness');
(async () => {
  const t = await startAll();
  try {
    await t.page.waitForSelector('.auth-card');
    await t.shot('01-setup');
    console.log('errors:', t.errors);
  } finally {
    await t.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
