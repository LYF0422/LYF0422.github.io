# 写作与维护

这是一个基于 Astro 的个人主页。内容全部来自本地 Markdown / MDX，不需要数据库。

## 在线可视化写作

打开 `/studio` 可使用富文本写作后台，支持粘贴图片、调整排版和自动同步 GitHub。首次连接方式见 [在线写作台指南](STUDIO.md)。

## 页面结构

| 路径                  | 用途                             |
| --------------------- | -------------------------------- |
| `/`                   | 个人主页、内容分类入口、最近文章 |
| `/blog`               | 全部文章                         |
| `/blog/paper-reading` | 论文阅读                         |
| `/blog/game`          | 游戏                             |
| `/blog/photo`         | 摄影与相册                       |
| `/blog/anime`         | 动画与追番                       |
| `/studio`             | 在线可视化写作后台               |
| `/blog/notes`         | 随笔                             |
| `/about`              | 个人介绍                         |
| `/archives`           | 年月归档                         |
| `/tags`               | 标签索引                         |
| `/search`             | 全文搜索                         |
| `/rss.xml`            | RSS 订阅                         |

## 发布第一篇文章

1. 从 `content-templates/` 复制对应的模板到 `src/content/posts/`，例如 `src/content/posts/first-paper.md`。也可以用 `src/content/posts/paper-reading/first-paper.md` 这样的子目录组织文件。
2. 修改标题、简介、发布日期、标签与正文。
3. 将 `draft: true` 改为 `draft: false`。
4. 运行 `pnpm build` 验证，然后按已有 GitHub Pages 流程发布。

分类由 frontmatter 中的 `category` 决定，与文件目录无关。可选值为 `paper-reading`、`game`、`photo`、`anime`、`notes`；省略时归入 Notes。各分类页、首页计数、归档、标签与 RSS 会自动更新。

`pubDatetime` 需要保留时区；未来的文章在发布时间到达前不会出现在正式构建中。草稿不会出现在网站、搜索、RSS 和站点地图中，开发模式也不会展示草稿。

`featured: true` 会给文章显示“精选”标记；首页按最近更新时间展示 `posts.perIndex` 篇文章。文章分页由 `posts.perPage` 控制。

## 图片与摄影

把图片放在 `public/images/`，在正文中使用：

```md
![具体描述照片内容](/images/my-photo.jpg)
```

给文章列表设置封面：

```yaml
cover: /images/my-photo.jpg
```

也可以将图片放在文章旁边，并用相对路径设置 `cover: ./my-photo.jpg`，让 Astro 优化图片。`ogImage` 用于社交分享预览，与文章列表的 `cover` 分开设置。

文章内的图片支持点击放大、键盘关闭和手机触控。

## 常用修改位置

| 修改内容                                 | 文件                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| 站点名称、作者、网址、社交链接、分页数量 | `astro-paper.config.ts`                                              |
| 首页介绍与标语                           | `src/pages/index.astro`                                              |
| 个人介绍                                 | `src/content/pages/about.md`                                         |
| 分类名称、说明、空状态文案               | `src/data/categories.ts`                                             |
| 增加分类选项                             | 同时修改 `src/data/categories.ts` 中的 `categoryIds` 和 `categories` |
| 颜色、字体                               | `src/styles/theme.css`                                               |
| 布局、间距、手机适配                     | `src/styles/global.css`                                              |
| 中文界面文案                             | `src/i18n/lang/zh-CN.ts`                                             |
| 网站图标                                 | `public/favicon.png`、`public/apple-touch-icon.png`                    |

头像文件为 `public/images/avatar.webp` 和 `public/images/avatar-small.webp`，分别用于主图与导航栏。社交链接在 `astro-paper.config.ts` 中配置。

浏览器标签页图标与页面头像分别设置。替换上述网站图标文件并部署后，普通页面和工作台会自动使用带有图片内容版本号的图标地址，避免浏览器继续使用旧图标缓存。

## 本地查看

```sh
pnpm dev
```

开发地址以终端输出为准。全文搜索需要先运行一次 `pnpm build`；预览最新构建可运行 `pnpm preview`。

首次打开项目先运行 `pnpm install --frozen-lockfile`。仓库使用不依赖符号链接的依赖布局，可在 ExFAT 移动硬盘上开发；`node_modules` 不需要从旧目录复制。

网站地址与 Cloudflare 接入方式见 [部署指南](DEPLOYMENT.md)。

原 AstroPaper 示例保存在 `examples/astro-paper/posts/`，不参与内容加载。如果需要参考 MDX、LaTeX 等写法，可以查看该目录。
