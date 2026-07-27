import axios from 'axios';
import { isPublicPath } from './utils/publicRoutes.js';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.response.use(
  res => res,
  err => {
    // A 401 on a public route (login, invite redemption) is expected — the
    // visitor isn't signed in yet — so leave them on the page.
    if (err.response?.status === 401 && !isPublicPath(window.location.pathname)) {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
