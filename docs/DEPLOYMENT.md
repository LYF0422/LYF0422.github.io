# 网站部署

代码仓库：<https://github.com/LYF0422/LYF0422.github.io>。

## GitHub Pages

主页：<https://lyf0422.github.io/>。写作台：<https://lyf0422.github.io/studio/>。

仓库名与账号名对应，使用根路径部署。Settings → Pages 的 Source 选择 **GitHub Actions**。向 `main` 推送后，现有工作流自动构建、发布；在仓库的 Actions 中查看部署结果。

写作台的配置位于 `src/data/studio.ts`，目标仓库为 `LYF0422/LYF0422.github.io`。首次使用与发布步骤见 [写作台指南](STUDIO.md)。

## 站内热门作品库

Anime / Game 检索使用 `public/bangumi/` 下的静态资料和封面，与网站一起部署。浏览器仅请求当前博客域名，不再依赖 `workers.dev` 或 Bangumi API；无需购买域名。博客本身仍需在用户网络中可访问。

- `catalog.json`：动画、游戏各 600 部，以 Bangumi 收藏热度为主、评分排名为补充，包含名称、别名、收录数量和更新时间。
- `subjects/<id>.json`：作品的基础资料。
- `covers/<id>.webp`：压缩封面，最大 360 × 480 像素。浏览器按需加载详情和封面。

`.github/workflows/sync-bangumi.yml` 在 GitHub 上运行下载，每周一北京时间 06:17 执行（UTC cron：`17 22 * * 0`，实际启动可能延迟）。手动更新：仓库 **Actions → Sync popular Bangumi catalog → Run workflow**。也可运行：

```sh
gh workflow run sync-bangumi.yml --repo LYF0422/LYF0422.github.io --ref main
```

同步脚本 `scripts/sync-bangumi.mjs` 下载公开条目，限制请求频率，压缩封面并验证完整性。同步失败保留上一版；单张封面下载失败优先复用旧封面。只有数量完整、至少 90% 封面可用时才更新，提交到 `main` 后显式触发 Pages 部署。同步工作流需要 `contents: write` 和 `actions: write` 权限，使用内置 `GITHUB_TOKEN`，无需额外密钥。

已关联作品会连同封面保存到文章，不会随每周热门库的变化自动改写。仅支持库内检索，未收录条目会提示；这不是 Bangumi 全量数据库。覆盖范围可通过脚本中的 `perType` 调整，每类最多 1,000 部。

## Cloudflare Workers 托管

构建日志中的 `npx wrangler deploy` 对应 Workers Builds。`wrangler.jsonc` 将 `dist` 作为静态资源发布，`workers/site.ts` 仅处理 `/api/bangumi/*` 的公开作品检索、详情和封面请求，不需要 Astro SSR 适配器。文章、分类、写作台仍按各自的 HTML 路径访问，不存在的路径返回网站的 404 页面。

原有 `/api/bangumi/*` 公开只读中转保留，但写作台已改用上面的站内热门作品库。如果用户网络无法访问 `workers.dev`，可继续使用 GitHub Pages 上的写作台和作品库。

在 Cloudflare 的 **Workers & Pages → 对应 Worker → Settings → Build** 中核对：

| 项目                    | 值                          |
| ----------------------- | --------------------------- |
| GitHub 仓库             | `LYF0422/LYF0422.github.io` |
| 生产分支                | `main`                      |
| 根目录                  | `/`（仓库根目录）           |
| 构建命令                | `pnpm run build`            |
| 部署命令                | `npx wrangler deploy`       |
| 构建变量 `PNPM_VERSION` | `12.14.0`                   |
| 构建变量 `NODE_VERSION` | `24.22.1`                   |

仓库的 `package.json` 也固定了 pnpm 版本，`.node-version` 固定了 Node.js 版本。构建变量应与它们保持一致；它们是构建环境变量，应添加到 **Build Variables and Secrets**，而不是 Worker 运行时变量。

`wrangler.jsonc` 中的默认 Worker 名称为 `lyf0422-github-io`。Workers Builds 使用当前连接项目提供的名称覆盖它，因此已有项目仍可部署；直接在本机执行真正的 `wrangler deploy` 时则使用配置文件中的名称。修改 GitHub 仓库名不会自动修改 Cloudflare 项目名。若日志提示名称不匹配，请核对控制台项目名称与部署目标，参见 [Workers 名称要求](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)。

向 `main` 推送会触发新的 Cloudflare 构建。在 Deployments 中选择最新提交；若需手动部署，请使用 **Deploy latest commit**。旧失败记录的 Retry 可能仍使用旧提交，应先核对 commit。新日志中 pnpm 应为 `12.14.0`。若仍恢复旧配置，清除项目的构建缓存后重新构建。

### 安装错误 `packages field missing or empty`

此前构建环境使用 pnpm 9.10.0，仓库的 `pnpm-workspace.yaml` 则只包含较新版本使用的安装设置，缺少旧版本要求的 `packages`。现在文件已显式包含根项目，同时锁定 pnpm 12.14.0。只修改 Build command 无法修复这个错误，因为自动安装依赖发生在构建命令之前。

### 本地验证

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm exec wrangler deploy --dry-run
```

这些命令验证安装、构建与部署配置，不会上传网站。需要检查 Workers 静态路由时，运行 `pnpm exec wrangler dev`，打开终端显示的本地地址。

### 首次部署后

在 Worker 的 **Settings → Domains & Routes** 中查看实际的 `*.workers.dev` 地址，或绑定自己的域名。将 `astro-paper.config.ts` 的 `site.url`、`site.profile` 和 `src/data/studio.ts` 的 `siteUrl` 更新为最终域名后重新部署；这会更新规范链接、站点地图和写作台中的站点链接。目前这些地址保留为 GitHub Pages，Cloudflare 页面仍可访问。

写作台发布时会提交到同一 GitHub 仓库，Cloudflare 的 Git 集成会自动触发构建。写作台中的“查看网站部署进度”目前链接到 GitHub Actions；切换主要托管站点后可以改为 Cloudflare 项目对应的部署页面。GitHub Pages 工作流继续作为备用站点。

### 其他方式：Cloudflare Pages

如果改用 Pages，新建 Pages 项目并连接同一仓库，构建命令填写 `pnpm run build`，输出目录填写 `dist`，生产分支选择 `main`，构建变量使用上述版本。Pages 不需要 `npx wrangler deploy` 部署命令。首次部署得到 `*.pages.dev` 地址后，再按上面的步骤更新站点域名。

### Cloudflare 管理域名，GitHub Pages 托管

需要已有的自定义域名。在 GitHub Pages 的 Custom domain 中绑定并验证域名，然后按 GitHub 提供的记录配置 Cloudflare DNS。GitHub 配置成功、HTTPS 证书签发后，在仓库保留对应的 `public/CNAME` 文件，并将上面的三个站点 URL 配置更新为最终域名。无需创建 Cloudflare Pages 项目。

不能直接把 `github.io` 域名交给 Cloudflare 管理；这条方式需要自己拥有的域名。

参考：[Workers 构建版本设置](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)；[Wrangler 静态资源配置](https://developers.cloudflare.com/workers/wrangler/configuration/#assets)；[Cloudflare Pages 的 Astro 部署指南](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/)；[GitHub Pages 自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)。
