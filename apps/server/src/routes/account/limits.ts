import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { t } from "@/lib/i18n";

export default Router().get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { limits } = u.account.getConfigState();
  res.set("Cache-Control", "no-store").json(success({ limits, messages: {
    type: t`请选择图片、音频或视频文件`, empty: t`参考素材不能为空`,
    count: t`参考素材最多 ${limits.maxReferencesPerRequest} 个`,
    total: t`参考素材合计不能超过 ${limits.requestTotalMaxBytes / 1024 / 1024} MiB`,
    image: t`图片不能超过 ${limits.imageMaxBytes / 1024 / 1024} MiB`,
    audio: t`音频不能超过 ${limits.audioMaxBytes / 1024 / 1024} MiB`,
    video: t`视频不能超过 ${limits.videoMaxBytes / 1024 / 1024} MiB`,
  } }));
});
