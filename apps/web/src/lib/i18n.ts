import axios, { type AxiosInstance } from "axios";
import { computed, shallowRef, watch } from "vue";
import { detectLocale, isRtlLocale, type Locale } from "@toonflow/i18n/core";
import { loadLocale } from "@toonflow/i18n/loadLocale";
import { loadElementLocale } from "@toonflow/i18n/elementPlus";
import { locale, setLocale, translate } from "@toonflow/i18n/vue";
import { uiSettings } from "@/stores/settings";
import type { LocaleConfig } from "vue-stream-markdown";
import { webMode, webUserId } from "@/lib/webRuntime";
import { appBasePath, resolveAppUrl } from "@/lib/appPath";

const dayjsLocales = {
  "zh-CN": () => import("dayjs/locale/zh-cn"),
  "zh-TW": () => import("dayjs/locale/zh-tw"),
  "en": () => import("dayjs/locale/en"),
  "ja": () => import("dayjs/locale/ja"),
  "ru": () => import("dayjs/locale/ru"),
  "vi": () => import("dayjs/locale/vi"),
  "th": () => import("dayjs/locale/th"),
  "ko": () => import("dayjs/locale/ko"),
  "hi": () => import("dayjs/locale/hi"),
  "id": () => import("dayjs/locale/id"),
  "ms": () => import("dayjs/locale/ms"),
  "fil": () => import("dayjs/locale/tl-ph"),
  "bn": () => import("dayjs/locale/bn"),
  "ur": () => import("dayjs/locale/ur"),
  "ta": () => import("dayjs/locale/ta"),
  "te": () => import("dayjs/locale/te"),
  "mr": () => import("dayjs/locale/mr"),
  "pa": () => import("dayjs/locale/pa-in"),
  "ar": () => import("dayjs/locale/ar"),
  "fa": () => import("dayjs/locale/fa"),
  "tr": () => import("dayjs/locale/tr"),
} satisfies Record<Locale, () => Promise<unknown>>;
export const elementLocale = shallowRef<Awaited<ReturnType<typeof loadElementLocale>>>();

export function registerApiLanguage(client: AxiosInstance) {
  const interceptor = client.interceptors.request.use(config => {
    const url = new URL(client.getUri(config), window.location.href);
    const target = resolveAppUrl(url);
    if (target.href !== url.href) {
      config.url = target.href;
      config.baseURL = "";
      config.params = undefined;
    }
    // ACT: 仅本应用 API 接收界面语言，不改变供应商等外部请求。
    if (target.origin === window.location.origin && target.pathname.startsWith(`${appBasePath}/api/`)) {
      config.headers.set("Accept-Language", locale.value);
      if (webMode.value) config.headers.set("x-toonflow-workspace", "1");
      if (webMode.value && webUserId.value) config.headers.set("x-yixianflow-user", String(webUserId.value));
    }
    return config;
  });
  return () => client.interceptors.request.eject(interceptor);
}

export function registerLanguage() {
  let revision = 0;
  let pending = Promise.resolve();
  const applyLanguage = () => {
    const request = ++revision;
    const language = uiSettings.value.language === "system" ? detectLocale(navigator.languages) : uiSettings.value.language;
    pending = Promise.all([loadLocale(language), loadElementLocale(language), dayjsLocales[language]()]).then(([, element]) => {
      if (request !== revision) return;
      elementLocale.value = element;
      setLocale(language);
    }).catch(async error => {
      if (request !== revision) return;
      console.error("语言资源加载失败，回退中文：", error);
      const element = await loadElementLocale("zh-CN").catch(error => { console.error("组件语言资源加载失败：", error); return undefined; });
      if (request !== revision) return;
      elementLocale.value = element;
      setLocale("zh-CN");
    });
  };
  const stopSettings = watch(() => uiSettings.value.language, applyLanguage, { immediate: true, flush: "sync" });
  const stopDocument = watch(locale, value => {
    document.documentElement.lang = value;
    document.documentElement.dir = isRtlLocale(value) ? "rtl" : "ltr";
  }, { immediate: true });
  const stopRequests = registerApiLanguage(axios);
  window.addEventListener("languagechange", applyLanguage);
  return {
    async ready() {
      let current: Promise<void>;
      do { current = pending; await current; } while (current !== pending);
    },
    stop() {
      revision++;
      stopSettings();
      stopDocument();
      stopRequests();
      window.removeEventListener("languagechange", applyLanguage);
    },
  };
}

// ACT: 只翻译 Markdown 控件，用户输入和模型生成的正文原样显示。
export const markdownLocale = computed<LocaleConfig>(() => ({
  button: {
    zoomIn: translate("放大"), zoomOut: translate("缩小"), resetZoom: translate("重置缩放"),
    preview: translate("预览"), source: translate("代码"), collapse: translate("折叠"),
    copy: translate("复制"), copied: translate("已复制"), download: translate("下载"),
    minimize: translate("最小化"), maximize: translate("最大化"), flipY: translate("垂直翻转"),
    flipX: translate("水平翻转"), rotateLeft: translate("向左旋转"), rotateRight: translate("向右旋转"),
    previous: translate("上一个"), next: translate("下一个"), back: translate("返回"),
    confirm: translate("确认"), cancel: translate("取消"),
  },
  error: {
    vanilla: translate("错误"), image: translate("图片加载失败"), mermaid: translate("Mermaid 渲染失败"),
    katex: translate("KaTeX 渲染失败"), harden: translate("已拦截"),
  },
  link: {
    title: translate("打开外部链接？"), description: translate("你即将访问外部网站"),
    copy: translate("复制链接"), open: translate("打开链接"),
  },
  dialog: { fullscreen: translate("全屏预览"), imagePreview: translate("图片预览") },
}));

export const chatLocale = computed(() => ({
  placeholder: translate("请输入消息..."), stopBtnText: translate("中止"), refreshTipText: translate("重新生成"),
  copyTipText: translate("复制"), likeTipText: translate("点赞"), dislikeTipText: translate("点踩"),
  copyCodeBtnText: translate("复制代码"), copyCodeSuccessText: translate("已复制"), clearHistoryBtnText: translate("清空历史记录"),
  copyTextSuccess: translate("已成功复制到剪贴板"), copyTextFail: translate("复制到剪贴板失败"),
  confirmClearHistory: translate("确定要清空所有的消息吗？"), loadingText: translate("思考中..."), loadingEndText: translate("已深度思考"),
  uploadImageText: translate("上传图片"), uploadAttachmentText: translate("上传附件"), shareTipText: translate("分享"),
}));
