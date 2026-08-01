/**
 * lawNews.service.js
 * All API calls for the lawNews feature go here.
 * Pages import from this file — never call api directly in a page component.
 */
import api from './api';

export const getFeed  = (state) => api.get('/api/law-news/feed', { params: state ? { state } : {} }).then((r) => r.data);
export const getStates = ()     => api.get('/api/law-news/states').then((r) => r.data);
export const getPreference    = ()      => api.get('/api/law-news/preference').then((r) => r.data);
export const updatePreference = (value) => api.put('/api/law-news/preference', { emailDigest: value }).then((r) => r.data);
