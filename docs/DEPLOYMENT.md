# 网站部署

代码仓库：<https://github.com/LYF0422/LYF0422.github.io>。

## GitHub Pages

主页：<https://lyf0422.github.io/>。写作台：<https://lyf0422.github.io/studio/>。

仓库名与账号名对应，使用根路径部署。Settings → Pages 的 Source 选择 **GitHub Actions**。向 `main` 推送后，现有工作流自动构建、发布；在仓库的 Actions 中查看部署结果。

写作台的配置位于 `src/data/studio.ts`，目标仓库为 `LYF0422/LYF0422.github.io`。首次使用与发布步骤见 [写作台指南](STUDIO.md)。

## Cloudflare Workers 托管（当前配置）

构建日志中的 `npx wrangler deploy` 对应 Workers Builds。`wrangler.jsonc` 将 `dist` 作为静态资源发布，`workers/site.ts` 仅处理 `/api/bangumi/*` 的公开作品检索、详情和封面请求，不需要 Astro SSR 适配器。文章、分类、写作台仍按各自的 HTML 路径访问，不存在的路径返回网站的 404 页面。

写作台优先通过 `src/data/studio.ts` 的 `bangumiProxy` 请求自己的 Cloudflare 服务，失败时再尝试 Bangumi 官方接口。当前地址是 `https://lyf0422-github-io.yifan-liu-51f.workers.dev/api/bangumi`，GitHub Pages 也使用此地址。中转不需要 Bangumi 令牌或付费存储，仅接受固定的公开读取接口，不转发 GitHub 令牌或浏览器 Cookie；搜索、详情和封面分别缓存 5 分钟、6 小时和 7 天。

如果用户网络无法访问 `workers.dev`，中转也会不可达。可将同一个 Worker 绑定到可访问的自定义域名，再更新 `bangumiProxy` 并重新部署；写作台的连接策略会随配置更新。此方案无法保证所有中国大陆运营商均可访问。

在 Cloudflare 的 **Workers & Pages → 对应 Worker → Settings → Build** 中核对：

| 项目 | 值 |
| --- | --- |
| GitHub 仓库 | `LYF0422/LYF0422.github.io` |
| 生产分支 | `main` |
| 根目录 | `/`（仓库根目录） |
| 构建命令 | `pnpm run build` |
| 部署命令 | `npx wrangler deploy` |
| 构建变量 `PNPM_VERSION` | `12.14.0` |
| 构建变量 `NODE_VERSION` | `24.22.1` |

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
