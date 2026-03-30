"use strict";

const express = require("express");
const { compareContent } = require("../controllers/contentController");

const router = express.Router();

router.post("/content/compare", compareContent);

module.exports = router;
