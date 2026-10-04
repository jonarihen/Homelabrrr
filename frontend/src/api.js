import axios from 'axios';
import { isPublicPath } from './utils/publicRoutes.js';
import { isSftpSessionExpired } from './utils/sftpSession.js';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.response.use(
  res => res,
  async err => {
    const data = err.response?.data;
    if (data instanceof Blob && data.type.startsWith('application/json')) {
      try {
        err.response.data = JSON.parse(await data.text());
      } catch {}
    }
    if (err.response?.status === 401 && !isSftpSessionExpired(err) && !isPublicPath(window.location.pathname)) {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
