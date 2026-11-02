import { Router } from "express";
import { helperChatRequest } from "@toonflow/local-helper/protocol";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ messages: helperChatRequest.shape.messages }), async (req, res) => {
  res.json(success(await u.localHelper.chat(req)));
});
