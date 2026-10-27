import { mkdir, writeAtomic } from "@toonflow/file";
import { dirname } from "node:path";

const version = process.env.appVersion ?? "";
const commit = process.env.GITHUB_SHA ?? "";
const repository = process.env.GITHUB_REPOSITORY ?? "";
const previousTag = process.env.previousReleaseTag ?? "";
const output = process.env.releaseNotesFile;
const token = process.env.GH_TOKEN;
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)
  || !/^[\w.-]+\/[\w.-]+$/.test(repository) || (previousTag && !/^portable-v\d+\.\d+\.\d+$/.test(previousTag)) || !output || !token) {
  throw new Error("生成更新说明需要版本号、源码提交、仓库、上一发布标签、输出路径及 GitHub 认证。");
}
if (!previousTag) {
  await mkdir(dirname(output), { recursive: true });
  await writeAtomic(output, JSON.stringify({ version, commit, previousTag, markdown: `首个发布版本 ${version}。\n` }, null, 2));
  console.log(`已生成 ${version} 的首个发布说明：${output}`);
  process.exit(0);
}

type Comparison = {
  status: string;
  total_commits: number;
  commits: { parents: unknown[]; commit: { message: string } }[];
};
const titles = new Set<string>();
const mergeTitles = new Set<string>();
let count = 0;
// ACT: 从同一基线分页读取提交标题，既覆盖直接 push，也覆盖 PR 合并；不逐条查询提交。
for (let page = 1; ; page++) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}/compare/${previousTag}...${commit}?per_page=100&page=${page}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`读取本次版本差异失败（HTTP ${response.status}）`);
  const comparison = await response.json() as Comparison;
  if (!["ahead", "identical"].includes(comparison.status)) throw new Error("源码不是上一发布版本的后续提交，停止生成更新说明。");
  if (!Number.isSafeInteger(comparison.total_commits) || comparison.total_commits < 0 || !Array.isArray(comparison.commits)) {
    throw new Error("版本差异响应不完整，停止生成更新说明。");
  }
  for (const item of comparison.commits) {
    const title = item.commit.message.split(/\r?\n/, 1)[0]!.trim();
    if (title) (item.parents.length > 1 ? mergeTitles : titles).add(title);
  }
  count += comparison.commits.length;
  if (count >= comparison.total_commits) break;
  if (!comparison.commits.length) throw new Error("未取得全部变更提交，停止生成更新说明。");
}
const changes = [...(titles.size ? titles : mergeTitles)];
if (count && !changes.length) throw new Error("本次提交缺少可用的更新标题，停止生成更新说明。");
const bullets = count ? changes.map(title => `- ${title.replace(/[\\`*_[\]<>#!]/g, "\\$&")}`).join("\n")
  : "- 本次重新构建发布，源代码与上一版本一致。";
const comparisonUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/compare/${previousTag}...${commit}`;
const markdown = `相较 ${previousTag.slice("portable-v".length)} 的更新：\n\n${bullets}\n\n[查看完整变更](${comparisonUrl})\n`;
await mkdir(dirname(output), { recursive: true });
await writeAtomic(output, JSON.stringify({ version, commit, previousTag, markdown }, null, 2));
console.log(`已生成 ${version} 的统一更新说明，共 ${changes.length} 项变更：${output}`);
