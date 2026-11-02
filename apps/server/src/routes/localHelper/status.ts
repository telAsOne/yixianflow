import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isWebMode } from "@/lib/webContext";

export default Router().get("/", async (req, res) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.json(success(await u.localHelper.getStatus()));
});
