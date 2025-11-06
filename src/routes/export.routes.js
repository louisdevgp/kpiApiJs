const { Router } = require('express');
const ctrl = require('../controllers/export.controller');

const router = Router();
router.get("/daily/export", ctrl.dailyExport);
router.get("/weekly/export", ctrl.weeklyExport);

module.exports = router;