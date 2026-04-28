const express = require('express');
const {
  createMigration,
  updateMigration,
  getAllMigrations,
  getMigrationsBySite,
  getMigrationById,
  deleteMigration,
} = require('../controllers/migrationController');

const router = express.Router();

router.post('/migrations', createMigration);
router.patch('/migrations/:id', updateMigration);
router.get('/migrations', getAllMigrations);
router.get('/migrations/site/:siteId', getMigrationsBySite);
router.get('/migrations/:id', getMigrationById);
router.delete('/migrations/:id', deleteMigration);

module.exports = router;
