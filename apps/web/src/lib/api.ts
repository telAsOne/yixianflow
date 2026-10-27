import axios, { AxiosError } from "axios";
import { registerApiLanguage } from "@/lib/i18n";

const api = axios.create({ headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(api);
api.interceptors.response.use(response => {
  if (response.data.code !== 200) {
    if (response.data.code === 401) window.dispatchEvent(new Event("toonflow:sign-in"));
    throw new AxiosError(response.data.message || "操作失败，请重试", undefined, response.config, response.request, response);
  }
  return response;
}, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event("toonflow:sign-in"));
  return Promise.reject(error);
});

export function errorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ message?: string }>(error)
    ? error.response?.data?.message || error.message || fallback
    : error instanceof Error ? error.message || fallback : fallback;
}

export default api;
