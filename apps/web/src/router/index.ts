import { createRouter, createWebHashHistory } from "vue-router";
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
      beforeEnter: async () => {
        if (!webMode.value) return true;
        if (!webUserId.value) return "/home";
        const workspace = useWorkspaceStore();
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
