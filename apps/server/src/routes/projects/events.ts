import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { isWebMode, webContext } from "@/lib/webContext";
import { subscribeProject } from "@/utils/web/projectEvents";
import type { ProjectEvent } from "@/types/collaboration";

export default Router().get("/", validateFields({ id: z.uuid() }, "query"), async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  const id = req.query.id as string;
  await u.webProjects.getWebProject(id);
  const userId = webContext.getStore()!.account.user.id;
  let includePlatform = (webContext.getStore()!.account.user.role ?? 0) >= 10;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (input: ProjectEvent) => {
    if (res.destroyed || res.writableEnded) return;
    let event = input;
    if (!includePlatform && event.type === "activity" && event.activity.platformOnly) return;
    if (!includePlatform && event.type === "presence") {
      if (event.platformOnly) return;
      event = { ...event, members: event.members.filter(member => !member.platformOnly) };
    }
    // 慢客户端重新连接并读持久记录，不无限缓存光标和消息。
    if (res.writableLength > 1024 * 1024) return res.end();
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let queue = Promise.resolve();
  async function authorize() {
    const session = await u.webAuth.readWebSession(req);
    if (!session || session.account.user.id !== userId) throw new Error("登录已失效");
    await webContext.run(session, () => u.webProjects.getWebProject(id));
    includePlatform = (session.account.user.role ?? 0) >= 10;
  }
  const unsubscribe = subscribeProject(id, event => {
    queue = queue.then(async () => {
      if (event.type === "permissions") await authorize();
      send(event);
    }).catch(() => { res.end(); });
  });
  const timer = setInterval(() => {
    queue = queue.then(async () => { await authorize(); send({ type: "ready" }); }).catch(() => { res.end(); });
  }, 15000);
  res.once("close", () => { clearInterval(timer); unsubscribe(); });
  send({ type: "ready" });
  send({ type: "presence", members: u.collaboration.getProjectPresence(id) });
});
