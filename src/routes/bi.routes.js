const { Router } = require('express');
const ctrl = require('../controllers/bi.controller');

const router = Router();

router.get("/bi/daily/unavailable", ctrl.dailyUnavailable);
router.get("/bi/weekly/unavailable", ctrl.weeklyUnavailable);

module.exports = router;