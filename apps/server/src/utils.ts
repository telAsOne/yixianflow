import * as assets from "@/utils/assets";
import * as canvasIndex from "@/utils/workspace/canvasIndex";
import * as canvasSync from "@/utils/workspace/canvasSync";
import * as mediaAccess from "@/utils/workspace/mediaAccess";
import * as mediaPreviews from "@/utils/media/previews";
import * as browser from "@/utils/browser";
import * as singleAgent from "@/utils/singleAgent";
import * as desktop from "@/utils/desktop";
import * as clientFiles from "@/utils/desktop/clientFiles";
import * as clientFileBridge from "@/agent/bridge/clientFiles";
import * as account from "@/utils/account";
import * as mediaGeneration from "@/utils/media/generation";
import * as mediaProvider from "@/utils/media/provider";
import * as ffmpeg from "@/utils/ffmpeg";
import * as whisper from "@/utils/whisper";
import * as pluginInstall from "@/utils/plugins/install";
import conf, { removeLegacySettings } from "@/utils/conf";
import * as ai from "@/utils/ai";
import * as plugins from "@/utils/plugins/tools";
import * as nodePlugins from "@/utils/plugins/nodes";
import * as extPlugins from "@/utils/plugins/ext";
import * as agent from "@/agent";
import * as canvas from "@/agent/bridge/canvas";
import * as question from "@/agent/bridge/question";
import * as workspace from "@/utils/workspace";
import * as workspaceFile from "@/utils/workspace/files";
import * as workspacePresence from "@/utils/workspace/presence";
import * as chatImages from "@/utils/workspace/chatImages";
import * as skillFile from "@/utils/skills/files";
import * as mcpControl from "@/utils/mcp/control";
import * as mcpRuntime from "@/utils/mcp/runtime";
import * as mobileLink from "@/utils/mobileLink";
import * as teams from "@/utils/teams";
import * as a2aSettings from "@/agent/a2a/settings";
import * as personalization from "@/utils/personalization";
import * as mentionFiles from "@/agent/mentionFiles";

export default {
  assets,
  canvasIndex,
  canvasSync,
  mediaAccess,
  mediaPreviews,
  browser,
  singleAgent,
  desktop,
  clientFiles,
  clientFileBridge,
  account,
  mediaGeneration,
  mediaProvider,
  ffmpeg,
  whisper,
  pluginInstall,
  conf,
  removeLegacySettings,
  ai,
  plugins,
  nodePlugins,
  extPlugins,
  agent,
  canvas,
  question,
  workspace,
  workspaceFile,
  workspacePresence,
  chatImages,
  skillFile,
  mcpControl,
  mcpRuntime,
  mobileLink,
  teams,
  a2aSettings,
  personalization,
  mentionFiles,
};
