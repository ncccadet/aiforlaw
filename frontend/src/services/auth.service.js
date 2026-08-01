/**
 * auth.service.js
 * All API calls for the auth feature go here.
 * Pages import from this file — never call api directly in a page component.
 */
import api from './api';

export const login = (email, password) =>
  api.post('/api/auth/login', { email, password }).then((res) => res.data);

export const logout = () =>
  api.post('/api/auth/logout').then((res) => res.data);

export const refresh = () =>
  api.post('/api/auth/refresh').then((res) => res.data);

export const getMe = () =>
  api.get('/api/auth/me').then((res) => res.data);

export const forgotPassword = (email) =>
  api.post('/api/auth/forgot-password', { email }).then((res) => res.data);

export const resetPassword = (email, otp, newPassword) =>
  api.post('/api/auth/reset-password', { email, otp, newPassword }).then((res) => res.data);
