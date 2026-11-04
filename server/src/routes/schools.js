'use strict';

const { createSchoolSearch } = require('../schools');
const { forbidden } = require('../util');

function register(router, { svc, config }) {
  const search = createSchoolSearch({ key: config.neisApiKey, fetchImpl: config.neisFetch });
  router.get('/api/schools/search', (ctx) => {
    const { user } = svc.authenticate(ctx, { app: true });
    svc.requireRole(ctx, 'admin', 'director', 'teacher');
    if (user.role !== 'admin' && !user.academy_id) throw forbidden('학원에 속한 계정만 학교를 검색할 수 있어요.');
    return search(user.uid, ctx.query.get('q'));
  });
}

module.exports = { register };
