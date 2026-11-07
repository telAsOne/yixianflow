import { Router } from "express";
import { canViewAllWebProjects, isWebMode, webContext } from "@/lib/webContext";
import { success } from "@/lib/responseFormat";

export default Router().get("/", (req, res) => {
  const user = webContext.getStore()?.account.user;
  res.set("Cache-Control", "no-store").json(success({ webMode: isWebMode(), userId: user?.id, userName: user?.display_name || user?.username,
    canViewAllProjects: isWebMode() && canViewAllWebProjects() }));
});
