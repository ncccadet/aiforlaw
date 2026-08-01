const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth.middleware');
const { loginRateLimit, forgotPasswordRateLimit, resetPasswordRateLimit } = require('../middleware/authRateLimit.middleware');

router.post('/login', loginRateLimit, authController.login);
router.post('/logout', authController.logout);
router.post('/refresh', authController.refresh);
router.get('/me', authMiddleware, authController.me);
router.post('/forgot-password', forgotPasswordRateLimit, authController.forgotPassword);
router.post('/reset-password', resetPasswordRateLimit, authController.resetPassword);

module.exports = router;