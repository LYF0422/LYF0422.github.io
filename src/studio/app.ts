import { Editor, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { getCategory, type CategoryId } from "@/data/categories";
import { studioConfig } from "@/data/studio";
import {
  cleanHtml,
  documentPath,
  makeSlug,
  newDocument,
  parseDocument,
  referencedMedia,
  serializeDocument,
  type WritingAsset,
  type WritingDocument,
} from "./model";
import {
  loadAsset,
  loadDocuments,
  removeDocument,
  saveAsset,
  saveDocument,
} from "./storage";
import { GitHubClient, GitHubError, type RemoteFile } from "./github";
import { EntryDialog } from "./entry-dialog";
import { CollectionEditor } from "./collections";
import { normalizeEntry } from "@/data/entries";
import { requestedPost } from "./navigation";
import {
  LibraryTools,
  parseTags,
  type ArticleOrganization,
  type LibraryTarget,
} from "./library";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing studio element: ${id}`);
  return element as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const text = (id: string, value: string) => {
  $(id).textContent = value;
};
const sessionKey = "writing-studio-session";
const selectionKey = `studio-active:${studioConfig.repository}`;
let current = newDocument();
let documents: WritingDocument[] = [];
let remoteFiles: RemoteFile[] = [];
let client: GitHubClient | undefined;
let busy = false;
let pendingImages = 0;
let preview = false;
let loading = false;
let slugEdited = false;
let autoSync = localStorage.getItem("studio-auto-sync") === "true";
let saveTimer: number | undefined;
let syncTimer: number | undefined;
let toastTimer: number | undefined;
let lastSave: Promise<void> = Promise.resolve();
let pendingLocalWrites = 0;
let deletingLocal = false;
const assetUrls = new Map<string, string>();
const assets = new Map<string, WritingAsset>();
let collectionEditor: CollectionEditor;
let libraryTools: LibraryTools;
let entryDialog: EntryDialog;
let pendingEditPath: string | null = null;

function finishRequestedPost() {
  pendingEditPath = null;
  const url = new URL(window.location.href);
  url.searchParams.delete("edit");
  history.replaceState(
    history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

async function openRequestedPost() {
  if (!pendingEditPath || !client) return;
  const file = remoteFiles.find(file => file.path === pendingEditPath);
  if (!file) {
    finishRequestedPost();
    showError(
      new Error(
        "这篇文章已被移动或删除，请在左侧文章库中选择要编辑的记录。本机草稿已保留。"
      )
    );
    return;
  }
  await openRemote(file);
  finishRequestedPost();
}

function toast(message: string) {
  text("studio-toast", message);
  $("studio-toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    $("studio-toast").hidden = true;
  }, 5000);
}
function showError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "操作未完成，草稿仍保存在当前设备。";
  text("studio-error", message);
  $("studio-error").hidden = false;
  text("save-status", "请查看提示 · 内容已保留");
  if (error instanceof GitHubError && [401, 409].includes(error.status)) {
    autoSync = false;
    input("auto-sync").checked = false;
    localStorage.setItem("studio-auto-sync", "false");
  }
}
function clearError() {
  $("studio-error").hidden = true;
}
function listen(id: string, event: string, action: (event: Event) => unknown) {
  $(id).addEventListener(event, eventObject => {
    try {
      Promise.resolve(action(eventObject)).catch(showError);
    } catch (error) {
      showError(error);
    }
  });
}
function previewUrl(src: string): string {
  if (assetUrls.has(src)) return assetUrls.get(src)!;
  if (src.startsWith("/documents/studio/"))
    return `${studioConfig.siteUrl}${src}`;
  if (src.startsWith("/"))
    return client?.rawUrl(src) ?? `${studioConfig.siteUrl}${src}`;
  if (src.startsWith("./") && current.path)
    return (
      client?.rawUrl(
        `${current.path.slice(0, current.path.lastIndexOf("/"))}/${src.slice(2)}`
      ) ?? src
    );
  return src;
}

const StudioImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: element =>
          element.getAttribute("src") ??
          element.querySelector("img")?.getAttribute("src"),
      },
      alt: {
        default: "",
        parseHTML: element =>
          element.getAttribute("alt") ??
          element.querySelector("img")?.getAttribute("alt") ??
          "",
      },
      width: {
        default: 100,
        parseHTML: element => Number(element.getAttribute("data-width")) || 100,
      },
      align: {
        default: "center",
        parseHTML: element => element.getAttribute("data-align") ?? "center",
      },
      caption: {
        default: "",
        parseHTML: element =>
          element.getAttribute("data-caption") ??
          element.querySelector("figcaption")?.textContent ??
          "",
      },
    };
  },
  parseHTML() {
    return [{ tag: "figure.studio-figure" }, { tag: "img[src]" }];
  },
  renderHTML({ node }) {
    const width = Math.min(100, Math.max(20, Number(node.attrs.width) || 100));
    const align = ["left", "center", "right"].includes(node.attrs.align)
      ? node.attrs.align
      : "center";
    return [
      "figure",
      {
        class: "studio-figure",
        "data-align": align,
        "data-width": String(width),
        "data-caption": node.attrs.caption,
        style: `--image-width:${width}%;width:${width}%`,
      },
      [
        "img",
        mergeAttributes({
          src: node.attrs.src,
          alt: node.attrs.alt ?? "",
          loading: "lazy",
        }),
      ],
      ...(node.attrs.caption
        ? [["figcaption", {}, String(node.attrs.caption)]]
        : []),
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("figure");
      const image = document.createElement("img");
      const caption = document.createElement("figcaption");
      dom.className = "studio-image-node";
      dom.contentEditable = "false";
      dom.append(image, caption);
      const render = (attrs: Record<string, unknown>) => {
        image.src = previewUrl(String(attrs.src ?? ""));
        image.alt = String(attrs.alt ?? "");
        dom.style.setProperty(
          "--image-width",
          `${Math.min(100, Math.max(20, Number(attrs.width) || 100))}%`
        );
        dom.dataset.align = String(attrs.align ?? "center");
        caption.textContent = String(attrs.caption ?? "");
        caption.hidden = !attrs.caption;
      };
      render(node.attrs);
      return {
        dom,
        update(next) {
          if (next.type.name !== "image") return false;
          render(next.attrs);
          return true;
        },
      };
    };
  },
});

let editor: Editor;
editor = new Editor({
  element: $("rich-editor"),
  extensions: [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ["https", "http", "mailto"],
      },
    }),
    StudioImage.configure({ allowBase64: false }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TableKit.configure({
      table: { resizable: true, HTMLAttributes: { class: "studio-table" } },
    }),
    Highlight,
  ],
  content: current.html,
  editorProps: {
    attributes: {
      "aria-label": "文章正文",
      role: "textbox",
      "aria-multiline": "true",
      spellcheck: "false",
    },
    transformPastedHTML: cleanHtml,
    handlePaste(_view, event) {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file =>
        file.type.startsWith("image/")
      );
      if (!files.length) return false;
      event.preventDefault();
      void insertImages(files).catch(showError);
      return true;
    },
    handleDrop(view, event) {
      const files = Array.from(event.dataTransfer?.files ?? []).filter(file =>
        file.type.startsWith("image/")
      );
      if (!files.length) return false;
      event.preventDefault();
      const position = view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      if (position) editor.commands.setTextSelection(position.pos);
      void insertImages(files).catch(showError);
      return true;
    },
  },
  onUpdate() {
    if (!loading && editor) {
      current.html = editor.getHTML();
      changed();
    }
  },
  onSelectionUpdate() {
    updateTools();
  },
  onTransaction() {
    updateTools();
  },
});

function updateTools() {
  if (!editor || editor.isDestroyed) return;
  document
    .querySelectorAll<HTMLButtonElement>("[data-command]")
    .forEach(button => {
      const command = button.dataset.command!;
      button.setAttribute("aria-pressed", String(editor.isActive(command)));
    });
  const heading = editor.getAttributes("heading").level;
  $<HTMLSelectElement>("block-format").value = heading
    ? `h${heading}`
    : "paragraph";
  $<HTMLSelectElement>("text-align").value =
    editor.getAttributes("paragraph").textAlign ??
    editor.getAttributes("heading").textAlign ??
    "left";
  const isImage = editor.isActive("image");
  $("image-tools").hidden = !isImage;
  $("table-tools").hidden = !editor.isActive("table");
  if (isImage) {
    const attrs = editor.getAttributes("image");
    $<HTMLSelectElement>("image-width").value = String(attrs.width ?? 100);
    $<HTMLSelectElement>("image-align").value = attrs.align ?? "center";
    if (document.activeElement !== $("image-caption"))
      input("image-caption").value = attrs.caption ?? "";
    if (document.activeElement !== $("image-alt"))
      input("image-alt").value = attrs.alt ?? "";
  }
}
function snapshot(): WritingDocument {
  return structuredClone({ ...current, html: editor.getHTML() });
}
function saveLocal() {
  if (deletingLocal) return lastSave;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const doc = snapshot();
  pendingLocalWrites++;
  lastSave = lastSave
    .catch(() => {})
    .then(async () => {
      await saveDocument(doc);
      const index = documents.findIndex(item => item.id === doc.id);
      if (index >= 0) documents[index] = doc;
      else documents.unshift(doc);
      if (
        current.id === doc.id &&
        current.updatedAt === doc.updatedAt &&
        !busy &&
        !pendingImages
      )
        text("save-status", "已自动保存在本机");
      renderLibrary();
    });
  lastSave = lastSave.finally(() => {
    pendingLocalWrites--;
  });
  return lastSave;
}
function changed() {
  if (loading || busy) return;
  current.updatedAt = new Date().toISOString();
  text("save-status", "正在保存…");
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveLocal().catch(showError);
  }, 650);
  clearTimeout(syncTimer);
  if (autoSync && client)
    syncTimer = window.setTimeout(() => {
      void synchronize().catch(showError);
    }, 10_000);
  updateDocumentLabels();
  updateWordCount();
  if (preview) renderPreview();
}
function updateWordCount() {
  const count = Array.from(editor.getText().replace(/\s/g, "")).length;
  text(
    "word-count",
    `${count} 字 · ${Math.max(1, Math.ceil(count / 350))} 分钟阅读`
  );
}
function updateDocumentLabels() {
  const category = getCategory(current.category);
  text(
    "paper-category",
    `${category.title.toUpperCase()} / ${category.subtitle}`
  );
  const state = current.remoteSha
    ? current.draft
      ? "GitHub 草稿"
      : "已发布"
    : "本机草稿";
  text("document-state", `${category.title} / ${state}`);
  text(
    "publish-button",
    current.remoteSha && !current.draft ? "更新发布 ↗" : "发布 ↗"
  );
  $("reload-remote").hidden = !current.remoteSha;
  $("template-heading").textContent =
    current.category === "paper-reading"
      ? "阅读笔记"
      : current.category === "photo"
        ? "相册正文"
        : current.category === "notes"
          ? "正文"
          : "详细感想";
}
function titleHeight() {
  const title = $<HTMLTextAreaElement>("document-title");
  title.style.height = "auto";
  title.style.height = `${title.scrollHeight}px`;
}
function lineHeight() {
  const value = String(current.extra.studioLineHeight ?? "2");
  return ["1.7", "2", "2.3"].includes(value) ? value : "2";
}
function renderPreview() {
  const dom = new DOMParser().parseFromString(
    cleanHtml(editor.getHTML()),
    "text/html"
  );
  dom.querySelectorAll("img").forEach(image => {
    image.src = previewUrl(image.getAttribute("src") ?? "");
  });
  // Sanitize before resolving local images, then keep the trusted blob URLs.
  $("article-preview").replaceChildren(...Array.from(dom.body.childNodes));
  $("article-preview").style.lineHeight = lineHeight();
}
function renderCover() {
  const cover = $("cover-preview");
  cover.replaceChildren();
  if (current.cover) {
    const image = document.createElement("img");
    image.src = previewUrl(current.cover);
    image.alt = "文章封面";
    cover.append(image);
  } else {
    const label = document.createElement("span");
    label.textContent = "从图片中选择一张封面";
    cover.append(label);
  }
}
function renderLibrary() {
  const filter = input("document-filter").value.toLowerCase();
  text("local-count", String(documents.length));
  const localList = $("local-documents");
  localList.replaceChildren();
  for (const doc of documents.filter(doc =>
    `${doc.title} ${doc.category}`.toLowerCase().includes(filter)
  )) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "document-open";
    const title = document.createElement("strong");
    title.textContent = doc.title || "未命名的记录";
    const meta = document.createElement("small");
    meta.textContent = `${getCategory(doc.category).title} · ${doc.remoteSha ? "有本机备份" : "本机草稿"}`;
    if (doc.id === current.id) button.setAttribute("aria-current", "page");
    button.append(title, meta);
    button.addEventListener("click", () => {
      void openDocument(doc).catch(showError);
    });
    item.append(button);
    libraryTools.bind(item, {
      id: doc.id,
      path: doc.path ?? undefined,
      sha: doc.remoteSha ?? undefined,
      title: doc.title || "未命名的记录",
      remote: false,
    });
    localList.append(item);
  }
  const remoteList = $("remote-documents");
  remoteList.replaceChildren();
  for (const file of remoteFiles) {
    const cached = documents.find(doc => doc.path === file.path);
    const titleText =
      cached?.title || file.path.split("/").pop()!.replace(/\.md$/, "");
    if (!`${titleText} ${file.path}`.toLowerCase().includes(filter)) continue;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "document-open";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("small");
    meta.textContent =
      cached && cached.remoteSha !== file.sha
        ? "远端有更新"
        : cached?.draft
          ? "GitHub 草稿"
          : "GitHub 记录";
    if (current.path === file.path) button.setAttribute("aria-current", "page");
    button.append(title, meta);
    button.addEventListener("click", () => {
      void openRemote(file).catch(showError);
    });
    item.append(button);
    libraryTools.bind(item, {
      id: cached?.id,
      path: file.path,
      sha: file.sha,
      title: titleText,
      remote: true,
    });
    remoteList.append(item);
  }
}
async function hydrateAssets(doc: WritingDocument) {
  await Promise.all(
    Array.from(referencedMedia(doc)).map(async path => {
      if (assets.has(path)) return;
      const asset = await loadAsset(path);
      if (!asset) return;
      assets.set(path, asset);
      assetUrls.set(
        path.slice("public".length),
        URL.createObjectURL(asset.blob)
      );
    })
  );
}
function closeDrawers() {
  document.body.classList.remove("library-open");
  $("drawer-backdrop").hidden = true;
}
function guardSwitch() {
  if (busy || pendingImages) {
    toast("正在同步或处理图片，请稍等片刻。");
    return false;
  }
  return true;
}
async function openDocument(doc: WritingDocument, savePrevious = true) {
  if (!guardSwitch()) return;
  clearTimeout(syncTimer);
  if (savePrevious) await saveLocal();
  loading = true;
  try {
    document.body.classList.remove("paper-notes-writing");
    $("paper-notes-toggle").setAttribute("aria-pressed", "false");
    current = structuredClone(doc);
    current.entry = normalizeEntry(current.entry);
    slugEdited = Boolean(doc.slug);
    await hydrateAssets(current);
    editor.commands.setContent(current.html, { emitUpdate: false });
    $<HTMLTextAreaElement>("document-title").value = current.title;
    $<HTMLTextAreaElement>("document-description").value = current.description;
    input("document-tags").value = current.tags.join(", ");
    input("document-slug").value = current.slug;
    input("document-slug").disabled = Boolean(current.path);
    $<HTMLSelectElement>("quick-category").value = current.category;
    input("document-featured").checked = current.featured;
    const date = new Date(current.pubDatetime);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    input("document-date").value = local;
    $<HTMLSelectElement>("document-line-height").value = lineHeight();
    editor.view.dom.style.lineHeight = lineHeight();
    updateDocumentLabels();
    updateWordCount();
    renderCover();
    collectionEditor.render();
    collectionEditor.setPreview(preview);
    renderLibrary();
    updateTools();
    titleHeight();
    if (preview) renderPreview();
    text("save-status", current.remoteSha ? "GitHub 记录已载入" : "草稿已载入");
    closeDrawers();
    clearError();
    if (doc.remoteSha && !documents.some(item => item.id === doc.id))
      await saveLocal();
    localStorage.setItem(selectionKey, current.id);
  } finally {
    loading = false;
  }
}
async function openRemote(file: RemoteFile, forceReload = false) {
  if (!client || !guardSwitch()) return;
  await saveLocal();
  const cached = documents.find(doc => doc.path === file.path);
  if (cached && !forceReload) {
    await openDocument(cached);
    if (cached.remoteSha !== file.sha)
      toast("这篇文章在其他设备有更新。可在发布选项中重新载入 GitHub 版本。");
    return;
  }
  text("save-status", "正在读取 GitHub 文章…");
  const doc = parseDocument(await client.readFile(file), file.path, file.sha);
  if (cached) doc.id = cached.id;
  await openDocument(doc);
}
async function refreshLibrary() {
  if (!client) {
    text("remote-hint", "连接 GitHub 后，可在不同设备继续写作。");
    return;
  }
  text("remote-hint", "正在读取 GitHub 文章…");
  const connection = client;
  const files = await connection.listPosts();
  if (connection !== client) return;
  remoteFiles = files.sort((a, b) => a.path.localeCompare(b.path));
  text(
    "remote-hint",
    remoteFiles.length
      ? `${remoteFiles.length} 篇 Markdown 记录，点击即可编辑。`
      : "仓库中还没有记录，写下第一篇吧。"
  );
  renderLibrary();
}
function setBusy(value: boolean) {
  busy = value;
  document.body.classList.toggle("is-syncing", value);
  editor.setEditable(!value && !preview);
  $<HTMLTextAreaElement>("document-title").readOnly = value || preview;
  $<HTMLFieldSetElement>("metadata-fields").disabled = value;
  $<HTMLFieldSetElement>("entry-fields").disabled = value;
  $<HTMLSelectElement>("quick-category").disabled = value || preview;
  $<HTMLButtonElement>("publish-button").disabled = value;
  $<HTMLButtonElement>("sync-draft-button").disabled = value;
  $<HTMLButtonElement>("delete-local-document").disabled = value;
}
async function synchronize(publishState?: boolean) {
  clearTimeout(syncTimer);
  if (busy || entryDialog?.isOpen) return;
  if (!client) {
    $<HTMLDialogElement>("connect-dialog").showModal();
    toast("连接 GitHub 后，就能同步这篇记录。");
    return;
  }
  if (pendingImages) {
    toast("图片还在处理中，请稍后同步。");
    return;
  }
  if (!current.title.trim()) {
    input("document-title").focus();
    toast("先给这篇记录起一个标题。");
    return;
  }
  const desiredDraft =
    publishState !== undefined ? !publishState : current.draft;
  if (!current.slug) current.slug = makeSlug(current.title, current.id);
  documentPath(current);
  await saveLocal();
  setBusy(true);
  clearError();
  const doc = snapshot();
  doc.draft = desiredDraft;
  try {
    const needed = Array.from(referencedMedia(doc));
    const media: WritingAsset[] = [];
    for (const path of needed) {
      const asset = assets.get(path) ?? (await loadAsset(path));
      if (asset) media.push(asset);
    }
    const result = await client.publish(doc, media, message => {
      text("save-status", message);
      text("sync-result", message);
    });
    current.draft = doc.draft;
    current.path = result.path;
    current.remoteSha = result.sha;
    current.syncedAt = new Date().toISOString();
    current.updatedAt = current.syncedAt;
    input("document-slug").value = current.slug;
    input("document-slug").disabled = true;
    const fileIndex = remoteFiles.findIndex(file => file.path === result.path);
    const file = { path: result.path, sha: result.sha };
    if (fileIndex >= 0) remoteFiles[fileIndex] = file;
    else remoteFiles.unshift(file);
    await saveLocal();
    const link = $<HTMLAnchorElement>("commit-link");
    link.href = result.url;
    link.hidden = false;
    text("save-status", "已同步到 GitHub");
    text(
      "sync-result",
      current.draft
        ? "草稿已同步，可在其他设备继续写作。网站不会展示草稿。"
        : "文章与图片已提交，等待自动部署更新网站。"
    );
    updateDocumentLabels();
    renderLibrary();
    toast(
      current.draft
        ? "草稿已同步到 GitHub。"
        : "发布成功，网站会在构建完成后更新。"
    );
  } catch (error) {
    text("sync-result", "同步未完成，本机草稿和图片已保留。");
    throw error;
  } finally {
    setBusy(false);
  }
}
function reflectOrganization() {
  input("document-tags").value = current.tags.join(", ");
  $<HTMLSelectElement>("quick-category").value = current.category;
  input("document-slug").disabled = Boolean(current.path);
  collectionEditor.render();
  collectionEditor.setPreview(preview);
  updateDocumentLabels();
  renderLibrary();
}
function recordCommit(url: string, message: string) {
  const link = $<HTMLAnchorElement>("commit-link");
  link.href = url;
  link.hidden = false;
  text("sync-result", message);
}
async function organizeListedDocument(
  target: LibraryTarget,
  values: ArticleOrganization
) {
  if (!guardSwitch()) throw new Error("请等待当前操作完成后重试。");
  clearTimeout(syncTimer);
  setBusy(true);
  try {
    await saveLocal();
    let doc = documents.find(item =>
      target.remote ? item.path === target.path : item.id === target.id
    );
    if (target.remote) {
      if (!client || !target.path || !target.sha)
        throw new Error("请先连接 GitHub。");
      const result = await client.organizePost(
        { path: target.path, sha: target.sha },
        values.category,
        values.tags
      );
      if (!result.sha) throw new Error("GitHub 未返回文章版本，请刷新后重试。");
      remoteFiles = remoteFiles.map(file =>
        file.path === target.path ? { ...file, sha: result.sha! } : file
      );
      if (doc) doc = { ...doc, remoteSha: result.sha };
      recordCommit(result.url, "分类与标签已同步，等待网站自动部署。");
    }
    if (doc) {
      doc = { ...doc, ...values, updatedAt: new Date().toISOString() };
      if (current.id === doc.id) Object.assign(current, doc);
      await saveDocument(doc);
      documents = documents.map(item => (item.id === doc!.id ? doc! : item));
    }
    reflectOrganization();
    toast(
      target.remote ? "分类与标签已同步到 GitHub。" : "分类与标签已保存在本机。"
    );
  } finally {
    setBusy(false);
  }
  if (!target.remote && current.id === target.id) changed();
}
async function deleteLocalDocument(id: string) {
  if (!guardSwitch()) return;
  const doc =
    id === current.id ? snapshot() : documents.find(item => item.id === id);
  if (!doc) return;
  const title = doc.title.trim() || "未命名的记录";
  if (
    !window.confirm(
      `删除「${title}」的本机记录？未同步的修改将丢失，GitHub 和网站上的文章会保留。`
    )
  )
    return;
  const active = current.id === id;
  if (active) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    clearTimeout(syncTimer);
  } else await saveLocal();
  deletingLocal = true;
  setBusy(true);
  try {
    await lastSave.catch(() => {});
    await removeDocument(id);
    documents = documents.filter(item => item.id !== id);
  } finally {
    deletingLocal = false;
    setBusy(false);
  }
  if (active)
    await openDocument(documents[0] ?? newDocument(current.category), false);
  else renderLibrary();
  toast("本机记录已删除，GitHub 和网站上的文章不受影响。");
}
async function deleteRemoteDocument(target: LibraryTarget) {
  if (!guardSwitch()) return;
  if (!client || !target.path || !target.sha) {
    $<HTMLDialogElement>("connect-dialog").showModal();
    return;
  }
  if (
    !window.confirm(
      `从 GitHub 和网站删除「${target.title}」？本机备份会保留；附件和历史提交不会删除。`
    )
  )
    return;
  clearTimeout(syncTimer);
  setBusy(true);
  try {
    await saveLocal();
    const result = await client.deletePost({
      path: target.path,
      sha: target.sha,
    });
    // Stop automatic publishing so a retained draft cannot recreate the deleted post.
    autoSync = false;
    input("auto-sync").checked = false;
    localStorage.setItem("studio-auto-sync", "false");
    remoteFiles = remoteFiles.filter(file => file.path !== target.path);
    for (const doc of documents.filter(item => item.path === target.path)) {
      const draft = {
        ...doc,
        path: null,
        remoteSha: null,
        syncedAt: null,
        draft: true,
      };
      if (current.id === doc.id) Object.assign(current, draft);
      await saveDocument(draft);
      documents = documents.map(item => (item.id === doc.id ? draft : item));
    }
    reflectOrganization();
    recordCommit(result.url, "文章已从 GitHub 删除，网站将在部署后移除。");
    toast("已删除 GitHub 文章，本机草稿保留；自动同步已关闭。");
  } finally {
    setBusy(false);
  }
}
async function processImage(file: File): Promise<WritingAsset> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type))
    throw new Error("支持 PNG、JPEG、WebP、GIF 和 AVIF 图片。");
  if (file.size > 25 * 1024 * 1024)
    throw new Error("这张图片超过 25 MB，请先缩小后再粘贴。");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  let blob: Blob;
  if (file.type === "image/gif") blob = file;
  else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂时无法处理图片。");
    context.drawImage(bitmap, 0, 0, width, height);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        value => (value ? resolve(value) : reject(new Error("图片处理失败。"))),
        "image/webp",
        0.86
      )
    );
  }
  bitmap.close();
  if (blob.size > 8 * 1024 * 1024)
    throw new Error("处理后的图片仍超过 8 MB，请使用较小的图片。");
  const extension =
    blob.type === "image/gif"
      ? "gif"
      : blob.type === "image/webp"
        ? "webp"
        : "png";
  return {
    path: `${studioConfig.mediaDirectory}/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${extension}`,
    blob,
    width,
    height,
  };
}
async function insertImages(files: File[], asCover = false) {
  if (busy) return;
  pendingImages += files.length;
  text("save-status", "正在处理图片…");
  try {
    for (const file of files) {
      const asset = await processImage(file);
      await saveAsset(asset);
      assets.set(asset.path, asset);
      const path = asset.path.slice("public".length);
      assetUrls.set(path, URL.createObjectURL(asset.blob));
      if (asCover) {
        current.cover = path;
        renderCover();
        changed();
      } else
        editor
          .chain()
          .focus()
          .setImage({
            src: path,
            alt:
              file.name === "image.png"
                ? ""
                : file.name.replace(/\.[^.]+$/, ""),
          })
          .run();
    }
    await saveLocal();
    toast(
      asCover
        ? "封面已保存到本机，随文章一起同步。"
        : "图片已保存到本机，可点击图片调整宽度和说明。"
    );
  } finally {
    pendingImages -= files.length;
    if (pendingImages === 0) text("save-status", "已自动保存在本机");
  }
}

async function storeAsset(asset: WritingAsset) {
  await saveAsset(asset);
  assets.set(asset.path, asset);
  const path = asset.path.slice("public".length);
  if (assetUrls.has(path)) URL.revokeObjectURL(assetUrls.get(path)!);
  assetUrls.set(path, URL.createObjectURL(asset.blob));
  return path;
}

collectionEditor = new CollectionEditor({
  current: () => current,
  changed,
  resolve: previewUrl,
  image: processImage,
  store: storeAsset,
  pending: count => {
    pendingImages += count;
    if (pendingImages) text("save-status", "正在处理附件…");
    else void saveLocal().catch(showError);
  },
  title: value => {
    $<HTMLTextAreaElement>("document-title").value = value;
    $("document-title").dispatchEvent(new Event("input"));
  },
  description: value => {
    $<HTMLTextAreaElement>("document-description").value = value;
    $("document-description").dispatchEvent(new Event("input"));
  },
  tags: value => {
    $<HTMLInputElement>("document-tags").value = value.join(", ");
    $("document-tags").dispatchEvent(new Event("input"));
  },
  cover: renderCover,
  error: showError,
  busy: () => busy,
});

entryDialog = new EntryDialog({
  accept: async (doc, pdf) => {
    if (!guardSwitch()) throw new Error("正在同步，请稍后保存信息。");
    if (pdf)
      doc.entry.paper.pdfUrl = await storeAsset({
        path: `${studioConfig.documentsDirectory}/${crypto.randomUUID()}.pdf`,
        blob: pdf,
        width: 0,
        height: 0,
      });
    await openDocument(doc);
    changed();
    await saveLocal();
    if (doc.category !== "paper-reading") editor.commands.focus("end");
    toast("记录已保存在本机，发布后更新网站。");
  },
});

async function openLibraryTarget(target: LibraryTarget) {
  await saveLocal();
  if (target.remote && target.path && target.sha)
    await openRemote({ path: target.path, sha: target.sha });
  else {
    const doc = documents.find(item => item.id === target.id);
    if (!doc) throw new Error("这篇本机记录已不存在，请刷新文章库。");
    await openDocument(doc);
  }
}
function editEntryInfo() {
  if (!guardSwitch()) return;
  clearTimeout(syncTimer);
  entryDialog.open(snapshot(), "edit");
}

libraryTools = new LibraryTools({
  available: () => !loading && guardSwitch(),
  open: openLibraryTarget,
  info: async target => {
    await openLibraryTarget(target);
    editEntryInfo();
  },
  read: async target => {
    await saveLocal();
    if (target.remote) {
      if (!client || !target.path || !target.sha)
        throw new Error("请先连接 GitHub。");
      return parseDocument(
        await client.readFile({ path: target.path, sha: target.sha })
      );
    }
    const doc = documents.find(item => item.id === target.id);
    if (!doc) throw new Error("这篇本机记录已不存在，请刷新文章库。");
    return structuredClone(doc);
  },
  save: organizeListedDocument,
  removeLocal: deleteLocalDocument,
  removeRemote: deleteRemoteDocument,
  error: showError,
});

$("writing-toolbar").addEventListener("mousedown", event => {
  if ((event.target as HTMLElement).closest("button")) event.preventDefault();
});
document
  .querySelectorAll<HTMLButtonElement>("[data-command]")
  .forEach(button => {
    button.addEventListener("click", () => {
      if (busy) return;
      const chain = editor.chain().focus();
      switch (button.dataset.command) {
        case "bold":
          chain.toggleBold().run();
          break;
        case "italic":
          chain.toggleItalic().run();
          break;
        case "underline":
          chain.toggleUnderline().run();
          break;
        case "strike":
          chain.toggleStrike().run();
          break;
        case "highlight":
          chain.toggleHighlight().run();
          break;
        case "code":
          chain.toggleCode().run();
          break;
        case "bulletList":
          chain.toggleBulletList().run();
          break;
        case "orderedList":
          chain.toggleOrderedList().run();
          break;
        case "blockquote":
          chain.toggleBlockquote().run();
          break;
        case "horizontalRule":
          chain.setHorizontalRule().run();
          break;
        case "codeBlock":
          chain.toggleCodeBlock().run();
          break;
        case "table":
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          break;
        case "addRowAfter":
          chain.addRowAfter().run();
          break;
        case "addColumnAfter":
          chain.addColumnAfter().run();
          break;
        case "deleteRow":
          chain.deleteRow().run();
          break;
        case "deleteColumn":
          chain.deleteColumn().run();
          break;
        case "deleteTable":
          chain.deleteTable().run();
          break;
        case "undo":
          chain.undo().run();
          break;
        case "redo":
          chain.redo().run();
          break;
      }
      updateTools();
    });
  });
listen("block-format", "change", () => {
  const value = $<HTMLSelectElement>("block-format").value;
  if (value === "paragraph") editor.chain().focus().setParagraph().run();
  else
    editor
      .chain()
      .focus()
      .setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 })
      .run();
});
listen("text-align", "change", () =>
  editor
    .chain()
    .focus()
    .setTextAlign($<HTMLSelectElement>("text-align").value)
    .run()
);
listen("insert-image", "click", () => input("image-file").click());
listen("image-file", "change", async () => {
  const files = Array.from(input("image-file").files ?? []);
  await insertImages(files);
  input("image-file").value = "";
});
listen("choose-cover", "click", () => input("cover-file").click());
listen("cover-file", "change", async () => {
  const files = Array.from(input("cover-file").files ?? []);
  await insertImages(files, true);
  input("cover-file").value = "";
});
listen("remove-cover", "click", () => {
  current.cover = "";
  renderCover();
  changed();
});
for (const id of ["image-width", "image-align", "image-caption", "image-alt"]) {
  listen(
    id,
    id.includes("caption") || id.includes("alt") ? "input" : "change",
    () => {
      const attr = id.replace("image-", "");
      const value = ($(id) as HTMLInputElement).value;
      editor.commands.updateAttributes("image", {
        [attr]: attr === "width" ? Number(value) : value,
      });
    }
  );
}
listen("image-set-cover", "click", () => {
  current.cover = String(editor.getAttributes("image").src);
  renderCover();
  changed();
  toast("已设为文章封面。");
});
listen("image-remove", "click", () =>
  editor.chain().focus().deleteSelection().run()
);
listen("insert-link", "click", () => {
  input("link-url").value = String(editor.getAttributes("link").href ?? "");
  $<HTMLDialogElement>("link-dialog").showModal();
  input("link-url").focus();
});
listen("link-form", "submit", event => {
  event.preventDefault();
  const url = input("link-url").value.trim();
  if (url && !/^(https?:\/\/|mailto:)/i.test(url)) {
    toast("请输入以 https://、http:// 或 mailto: 开头的链接。");
    return;
  }
  if (url)
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  else editor.chain().focus().extendMarkRange("link").unsetLink().run();
  $<HTMLDialogElement>("link-dialog").close();
});
listen("remove-link", "click", () => {
  editor.chain().focus().extendMarkRange("link").unsetLink().run();
  $<HTMLDialogElement>("link-dialog").close();
});
listen("cancel-link", "click", () =>
  $<HTMLDialogElement>("link-dialog").close()
);
listen("document-title", "input", () => {
  current.title = $<HTMLTextAreaElement>("document-title").value;
  if (!slugEdited && !current.path) {
    current.slug = makeSlug(current.title, current.id);
    input("document-slug").value = current.slug;
  }
  titleHeight();
  changed();
});
listen("document-description", "input", () => {
  current.description = $<HTMLTextAreaElement>("document-description").value;
  changed();
});
listen("document-tags", "input", () => {
  current.tags = parseTags(input("document-tags").value);
  changed();
});
listen("document-slug", "input", () => {
  slugEdited = true;
  current.slug = input("document-slug").value;
  changed();
});
function changeCategory(id: string) {
  current.category = $<HTMLSelectElement>(id).value as CategoryId;
  $<HTMLSelectElement>("quick-category").value = current.category;
  collectionEditor.render();
  changed();
}
listen("quick-category", "change", () => changeCategory("quick-category"));
listen("document-featured", "change", () => {
  current.featured = input("document-featured").checked;
  changed();
});
listen("document-date", "change", () => {
  const date = new Date(input("document-date").value);
  if (Number.isFinite(date.getTime())) current.pubDatetime = date.toISOString();
  changed();
});
listen("document-line-height", "change", () => {
  current.extra.studioLineHeight = $<HTMLSelectElement>(
    "document-line-height"
  ).value;
  editor.view.dom.style.lineHeight = lineHeight();
  changed();
});
function createEntry() {
  if (!guardSwitch()) return;
  clearTimeout(syncTimer);
  entryDialog.open(newDocument(current.category), "create");
}
listen("edit-entry-info", "click", editEntryInfo);
listen("paper-notes-toggle", "click", () => {
  const visible = document.body.classList.toggle("paper-notes-writing");
  $("paper-notes-toggle").setAttribute("aria-pressed", String(visible));
  if (visible) {
    setMode(false);
    editor.commands.focus("end");
  }
});
listen("new-document", "click", createEntry);
listen("new-entry", "click", createEntry);
listen("document-filter", "input", renderLibrary);
listen("refresh-library", "click", refreshLibrary);
listen("publish-button", "click", () => synchronize(true));
listen("sync-draft-button", "click", () => synchronize(false));
listen("delete-local-document", "click", () => deleteLocalDocument(current.id));
listen("auto-sync", "change", () => {
  autoSync = input("auto-sync").checked;
  localStorage.setItem("studio-auto-sync", String(autoSync));
  if (autoSync && !client) {
    autoSync = false;
    input("auto-sync").checked = false;
    localStorage.setItem("studio-auto-sync", "false");
    $<HTMLDialogElement>("connect-dialog").showModal();
    return;
  }
  if (autoSync) {
    toast("自动同步已开启，停止输入 10 秒后保存到 GitHub。");
    changed();
  } else clearTimeout(syncTimer);
});
listen("reload-remote", "click", async () => {
  if (!client || !guardSwitch() || !current.path) return;
  if (
    !window.confirm(
      "重新载入会以 GitHub 版本替换当前本机备份。建议先导出 Markdown。是否继续？"
    )
  )
    return;
  await refreshLibrary();
  const file = remoteFiles.find(file => file.path === current.path);
  if (!file) throw new Error("GitHub 上已找不到这篇文章，当前本机草稿已保留。");
  await openRemote(file, true);
  await saveLocal();
});
function setMode(isPreview: boolean) {
  preview = isPreview;
  $("rich-editor").hidden = isPreview;
  $("article-preview").hidden = !isPreview;
  $("writing-toolbar").hidden = isPreview;
  $("image-tools").hidden = true;
  $("table-tools").hidden = true;
  $("mode-write").setAttribute("aria-pressed", String(!isPreview));
  $("mode-preview").setAttribute("aria-pressed", String(isPreview));
  document.body.classList.toggle("is-preview", isPreview);
  $<HTMLTextAreaElement>("document-title").readOnly = isPreview;
  $<HTMLTextAreaElement>("document-description").readOnly = isPreview;
  input("document-tags").readOnly = isPreview;
  editor.setEditable(!isPreview && !busy);
  $<HTMLSelectElement>("quick-category").disabled = isPreview || busy;
  collectionEditor.setPreview(isPreview);
  if (isPreview) renderPreview();
  else updateTools();
}
listen("mode-write", "click", () => setMode(false));
listen("mode-preview", "click", () => setMode(true));
listen("toggle-library", "click", () => {
  const opened = document.body.classList.toggle("library-open");
  $("drawer-backdrop").hidden = !opened;
});
listen("focus-writing", "click", () => {
  const focused = document.body.classList.toggle("focus-writing");
  $("focus-writing").setAttribute("aria-pressed", String(focused));
  text("focus-writing", focused ? "显示文章库" : "专注");
});
document.addEventListener("pointerdown", event => {
  const options = $<HTMLDetailsElement>("publish-options");
  if (!options.contains(event.target as Node)) options.open = false;
});
listen("drawer-backdrop", "click", closeDrawers);
document.addEventListener("keydown", event => {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") closeDrawers();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveLocal()
      .then(() => toast("已保存在本机；点击发布或开启自动同步可上传 GitHub。"))
      .catch(showError);
  }
});
function setTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  text("studio-theme", theme === "dark" ? "切换浅色" : "切换深色");
  localStorage.setItem("theme", theme);
}
setTheme(
  localStorage.getItem("theme") ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
);
listen("studio-theme", "click", () =>
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
);
listen("connect-button", "click", () => {
  if (!busy) $<HTMLDialogElement>("connect-dialog").showModal();
});
listen("close-connect", "click", () =>
  $<HTMLDialogElement>("connect-dialog").close()
);
listen("try-writing", "click", () => {
  $<HTMLDialogElement>("connect-dialog").close();
  input("document-title").focus();
});
async function connect(token: string, remember: boolean) {
  const candidate = new GitHubClient(token);
  const user = await candidate.connect();
  client = candidate;
  if (remember) sessionStorage.setItem(sessionKey, token);
  else sessionStorage.removeItem(sessionKey);
  text("connect-button", `${user.login} · GitHub`);
  text("connection-status", "已连接");
  $("logout-button").hidden = false;
  $<HTMLDialogElement>("connect-dialog").close();
  input("github-token").value = "";
  await refreshLibrary();
  await openRequestedPost();
  renderCover();
  // Refresh node views so repository-relative images resolve on another device.
  loading = true;
  editor.commands.setContent(current.html, { emitUpdate: false });
  loading = false;
}
listen("connect-form", "submit", async event => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("confirm-connect");
  button.disabled = true;
  text("connect-error", "");
  try {
    clearError();
    await connect(
      input("github-token").value.trim(),
      input("remember-session").checked
    );
    toast("GitHub 已连接，可以同步记录了。");
  } catch (error) {
    text(
      "connect-error",
      error instanceof Error ? error.message : "连接失败，请重试。"
    );
    if (!$<HTMLDialogElement>("connect-dialog").open) showError(error);
  } finally {
    button.disabled = false;
  }
});
listen("logout-button", "click", () => {
  if (busy) return;
  sessionStorage.removeItem(sessionKey);
  client = undefined;
  autoSync = false;
  input("auto-sync").checked = false;
  localStorage.setItem("studio-auto-sync", "false");
  clearTimeout(syncTimer);
  remoteFiles = [];
  text("connect-button", "连接 GitHub");
  text("connection-status", "未连接");
  $("logout-button").hidden = true;
  text("remote-hint", "已退出 GitHub；本机草稿仍然保留。");
  renderLibrary();
  toast("已退出 GitHub。");
});
listen("export-document", "click", async () => {
  await saveLocal();
  const blob = new Blob([serializeDocument(snapshot())], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${current.slug || makeSlug(current.title, current.id)}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("beforeunload", event => {
  if (busy || pendingImages || pendingLocalWrites || saveTimer !== undefined) {
    event.preventDefault();
  }
});
window.addEventListener("pagehide", () => {
  void saveLocal().catch(() => {});
});

async function initialize() {
  input("auto-sync").checked = autoSync;
  documents = await loadDocuments();
  const returningWriter = documents.length > 0;
  let linkError: unknown;
  try {
    pendingEditPath = requestedPost(window.location.search);
  } catch (error) {
    linkError = error;
  }
  const requested = pendingEditPath
    ? documents.find(doc => doc.path === pendingEditPath)
    : undefined;
  const selected = documents.find(
    doc => doc.id === localStorage.getItem(selectionKey)
  );
  await openDocument(requested ?? selected ?? documents[0] ?? current, false);
  if (requested) finishRequestedPost();
  if (!documents.length) await saveLocal();
  const token = sessionStorage.getItem(sessionKey);
  if (token) {
    try {
      await connect(token, true);
    } catch (error) {
      sessionStorage.removeItem(sessionKey);
      showError(error);
      $<HTMLDialogElement>("connect-dialog").showModal();
    }
  } else if (!returningWriter || pendingEditPath)
    $<HTMLDialogElement>("connect-dialog").showModal();
  if (pendingEditPath && !client)
    text("remote-hint", "连接 GitHub 后，将打开你刚才选择的文章。");
  if (linkError) showError(linkError);
}
void initialize().catch(showError);
