import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.uuid() }, "query"), async (req, res) => {
  res.json(success(await u.collaboration.listProjectAgentMembers(req.query.directory as string)));
});
