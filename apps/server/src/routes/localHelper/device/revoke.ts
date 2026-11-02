import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().post("/", async (req, res) => {
  await u.localHelper.disconnectDevice(req);
  res.json(success());
});
