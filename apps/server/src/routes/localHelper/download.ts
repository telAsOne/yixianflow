import { Router } from "express";
import u from "@/utils";
import { isWebMode } from "@/lib/webContext";

export default Router().get("/", (req, res, next) => {
  if (!isWebMode()) return void res.sendStatus(404);
  res.set("Cache-Control", "no-store");
  res.download(u.localHelper.getDownloadPath(), "unionFlfowHelper.zip", error => { if (error) next(error); });
});
