import { START_LOCATION, createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { webMode, webUserId } from "@/lib/webRuntime";
import { useWorkspaceStore } from "@/stores/workspace";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => webMode.value || await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      beforeEnter: async (_to, from) => {
        if (!webMode.value) return true;
        if (!webUserId.value) return "/home";
        const workspace = useWorkspaceStore();
        // 站内跳转前调用方已打开并校验项目；再次打开会清空首页排队的 AI 消息。
        if (from !== START_LOCATION && workspace.project) return true;
        await workspace.loadProjects();
        if (!workspace.project) return "/home";
        await workspace.openProject(workspace.project.directory);
        return true;
      },
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});
export default router;
