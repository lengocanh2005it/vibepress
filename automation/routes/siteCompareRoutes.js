"use strict";

const express = require("express");
const { compareSiteHandler } = require("../controllers/siteCompareController");

const router = express.Router();

router.post("/site/compare", compareSiteHandler);

module.exports = router;
