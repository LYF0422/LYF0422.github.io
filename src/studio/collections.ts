import {
  entryStatuses,
  normalizeEntry,
  paperFromUrl,
  pdfPreviewUrl,
  resourceUrl,
} from "@/data/entries";
import { studioConfig } from "@/data/studio";
import { getAssetPath } from "@/utils/withBase";
import { loadCatalog } from "./catalog";
import {
  downloadSubjectCover,
  getSubject,
  searchSubjects,
  subjectId,
} from "./bangumi";
import type { WritingAsset, WritingDocument } from "./model";

interface Context {
  current: () => WritingDocument;
  changed: () => void;
  resolve: (url: string) => string;
  image: (file: File) => Promise<WritingAsset>;
  store: (asset: WritingAsset) => Promise<string>;
  pending: (count: number) => void;
  title: (value: string) => void;
  cover: () => void;
  error: (error: unknown) => void;
  busy: () => boolean;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value = "",
  className = ""
) => {
  const element = document.createElement(tag);
  element.textContent = value;
  element.className = className;
  return element;
};

export class CollectionEditor {
  private request?: AbortController;
  private reading = true;
  private paperNavigation = 0;
  constructor(private context: Context) {
    const on = (
      id: string,
      event: string,
      action: (event: Event) => void | Promise<void>
    ) =>
      $(id).addEventListener(event, e => {
        if (context.busy()) return;
        try {
          Promise.resolve(action(e)).catch(context.error);
        } catch (error) {
          context.error(error);
        }
      });
    on("entry-showcase", "change", () => {
      this.entry.showcase = input("entry-showcase").checked;
      context.changed();
    });
    on("entry-comment", "input", () => {
      this.entry.comment = $<HTMLTextAreaElement>("entry-comment").value;
      context.changed();
    });
    on("entry-rating", "input", () => {
      if (!input("entry-rating").validity.valid) return;
      this.entry.rating =
        input("entry-rating").value === ""
          ? null
          : Number(input("entry-rating").value);
      context.changed();
    });
    on("entry-status", "change", () => {
      this.entry.status = $<HTMLSelectElement>("entry-status").value;
      context.changed();
    });
    on("bangumi-search", "click", () => this.search());
    on("bangumi-query", "keydown", event => {
      if ((event as KeyboardEvent).key === "Enter") {
        event.preventDefault();
        return this.search();
      }
    });
    on("gallery-add", "click", () => input("gallery-files").click());
    on("gallery-files", "change", async () => {
      await this.addPhotos(Array.from(input("gallery-files").files ?? []));
      input("gallery-files").value = "";
    });
    on("gallery-drop", "dragover", event => event.preventDefault());
    on("gallery-drop", "drop", event => {
      event.preventDefault();
      return this.addPhotos(
        Array.from((event as DragEvent).dataTransfer?.files ?? [])
      );
    });
    on("gallery-fields", "paste", event => {
      const files = Array.from(
        (event as ClipboardEvent).clipboardData?.files ?? []
      ).filter(file => file.type.startsWith("image/"));
      if (files.length) {
        event.preventDefault();
        return this.addPhotos(files);
      }
    });
    on("paper-attach", "click", () => this.attachPaper());
    on("paper-source", "keydown", event => {
      if ((event as KeyboardEvent).key === "Enter") {
        event.preventDefault();
        this.attachPaper();
      }
    });
    on("paper-upload", "click", () => input("paper-file").click());
    on("paper-file", "change", async () => {
      const file = input("paper-file").files?.[0];
      if (file) await this.uploadPdf(file);
      input("paper-file").value = "";
    });
    on("paper-pdf", "change", () => {
      const value = input("paper-pdf").value.trim();
      if (value && !resourceUrl(value))
        throw new Error("PDF 链接需为 HTTPS 地址。");
      this.entry.paper.pdfUrl = resourceUrl(value);
      this.updatePaper();
      context.changed();
    });
    on("paper-authors", "input", () => {
      this.entry.paper.authors = input("paper-authors").value;
      context.changed();
    });
    on("paper-read-toggle", "click", () => {
      this.reading = !this.reading;
      this.updatePaper();
    });
    on("paper-reader-close", "click", () => {
      this.reading = false;
      this.updatePaper();
    });
    on("paper-remove", "click", () => {
      this.entry.paper = {
        sourceUrl: "",
        pdfUrl: "",
        authors: this.entry.paper.authors,
      };
      this.render();
      context.changed();
    });
  }
  private get doc() {
    return this.context.current();
  }
  private get entry() {
    return this.doc.entry;
  }
  private async catalogInfo(signal?: AbortSignal) {
    const catalog = await loadCatalog(signal);
    $("catalog-info").textContent =
      `站内热门作品库 · ${catalog.counts.anime} 部动画 / ${catalog.counts.game} 部游戏 · ${new Date(catalog.updatedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 更新 · 来源 Bangumi`;
  }
  render() {
    this.request?.abort();
    this.doc.entry = normalizeEntry(this.doc.entry);
    const category = this.doc.category;
    $("entry-fields").hidden = category === "notes";
    $("subject-fields").hidden = !["anime", "game"].includes(category);
    $("gallery-fields").hidden = category !== "photo";
    $("paper-fields").hidden = category !== "paper-reading";
    $("entry-panel-title").textContent =
      category === "photo"
        ? "相册"
        : category === "paper-reading"
          ? "论文与笔记"
          : "作品记录";
    $("entry-comment-label").textContent =
      category === "photo"
        ? "相册简评"
        : category === "paper-reading"
          ? "阅读摘要"
          : "简评";
    input("entry-showcase").checked = this.entry.showcase;
    input("entry-rating").value =
      this.entry.rating === null ? "" : String(this.entry.rating);
    $<HTMLSelectElement>("entry-status").value = this.entry.status;
    $<HTMLTextAreaElement>("entry-comment").value = this.entry.comment;
    input("bangumi-query").value = "";
    $("bangumi-results").replaceChildren();
    $("bangumi-status").textContent = "";
    if (["anime", "game"].includes(category)) {
      void this.catalogInfo().catch(() => {
        $("catalog-info").textContent = "作品库暂时无法加载，可点击搜索重试。";
      });
    }
    input("paper-source").value = this.entry.paper.sourceUrl;
    input("paper-pdf").value = this.entry.paper.pdfUrl;
    input("paper-authors").value = this.entry.paper.authors;
    $<HTMLDetailsElement>("paper-attachment-details").open = !(
      this.entry.paper.sourceUrl || this.entry.paper.pdfUrl
    );
    this.renderSubject();
    this.renderPhotos();
    this.updatePaper();
  }
  private async search() {
    const keyword = input("bangumi-query").value.trim();
    if (!keyword) {
      input("bangumi-query").focus();
      return;
    }
    this.request?.abort();
    const request = (this.request = new AbortController());
    const id = this.doc.id;
    const category = this.doc.category;
    const type = category === "game" ? 4 : 2;
    $("bangumi-results").replaceChildren();
    $("bangumi-status").textContent = "正在检索…";
    try {
      await this.catalogInfo(request.signal);
      const directId = subjectId(keyword);
      if (directId) {
        await this.select(directId, type, request, id, category);
        return;
      }
      const results = await searchSubjects(keyword, type, request.signal);
      if (
        request.signal.aborted ||
        this.doc.id !== id ||
        this.doc.category !== category
      )
        return;
      $("bangumi-status").textContent = results.length
        ? "选择对应作品"
        : "站内暂无匹配作品。仅收录部分热门作品，可尝试原名、别名或编号。";
      for (const result of results) {
        const button = node("button", "", "bangumi-result");
        button.type = "button";
        const cover = resourceUrl(result.images.common);
        if (cover) {
          const img = node("img");
          img.src = getAssetPath(cover);
          img.alt = "";
          img.referrerPolicy = "no-referrer";
          button.append(img);
        }
        const label = node("span", result.name_cn || result.name);
        label.append(
          node("small", result.name_cn ? result.name : `#${result.id}`)
        );
        button.append(label);
        button.addEventListener("click", () => {
          if (this.context.busy()) return;
          this.request?.abort();
          const selection = (this.request = new AbortController());
          void this.select(result.id, type, selection, id, category).catch(
            this.context.error
          );
        });
        $("bangumi-results").append(button);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        $("bangumi-status").textContent = "检索未完成，请检查网络后重试。";
        throw error;
      }
    }
  }
  private async select(
    id: number,
    type: 2 | 4,
    request: AbortController,
    docId: string,
    category: string
  ) {
    $("bangumi-status").textContent = "正在读取作品信息…";
    let savingCover = false;
    try {
      const subject = await getSubject(id, type, request.signal);
      if (
        request.signal.aborted ||
        this.doc.id !== docId ||
        this.doc.category !== category ||
        this.context.busy()
      )
        return;
      const previous = this.entry.subject;
      let coverCached = true;
      if (subject.image) {
        if (
          previous?.id === subject.id &&
          previous.image.startsWith("/images/studio/")
        ) {
          subject.image = previous.image;
        } else {
          this.context.pending(1);
          savingCover = true;
          $("bangumi-status").textContent = "正在保存作品封面…";
          try {
            const file = await downloadSubjectCover(subject, request.signal);
            const asset = await this.context.image(file);
            subject.image = await this.context.store(asset);
          } catch {
            coverCached = false;
          }
        }
      }
      if (
        request.signal.aborted ||
        this.doc.id !== docId ||
        this.doc.category !== category
      )
        return;
      this.entry.subject = subject;
      if (!this.doc.title.trim() || this.doc.title === previous?.name)
        this.context.title(subject.name);
      if (!this.doc.cover || this.doc.cover === previous?.image) {
        this.doc.cover = subject.image;
        this.context.cover();
      }
      $("bangumi-results").replaceChildren();
      $("bangumi-status").textContent = coverCached
        ? ""
        : "作品信息已添加；封面暂未保存，再次选择此作品可重试。";
      this.renderSubject();
      this.context.changed();
    } catch (error) {
      if (!request.signal.aborted) {
        $("bangumi-status").textContent = "读取失败，请重试。";
        throw error;
      }
    } finally {
      if (savingCover) this.context.pending(-1);
    }
  }
  private renderSubject() {
    const container = $("bangumi-selected");
    container.replaceChildren();
    const subject = this.entry.subject;
    container.hidden =
      !subject || subject.type !== (this.doc.category === "game" ? 4 : 2);
    if (container.hidden || !subject) return;
    if (subject.image) {
      const image = node("img");
      image.src = this.context.resolve(subject.image);
      image.alt = subject.name;
      image.referrerPolicy = "no-referrer";
      container.append(image);
    }
    const info = node("div");
    const link = node("a", `${subject.name} ↗`);
    link.href = `https://bgm.tv/subject/${subject.id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    info.append(
      link,
      node(
        "p",
        [
          subject.date,
          subject.platform,
          subject.episodes ? `${subject.episodes} 话` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        "entry-hint"
      )
    );
    for (const fact of subject.facts)
      info.append(node("p", `${fact.label} · ${fact.value}`, "entry-hint"));
    const remove = node("button", "解除关联", "studio-text-button");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (this.context.busy()) return;
      if (this.doc.cover === subject.image) {
        this.doc.cover = "";
        this.context.cover();
      }
      this.entry.subject = null;
      this.renderSubject();
      this.context.changed();
    });
    info.append(remove);
    container.append(info);
  }
  private async addPhotos(files: File[]) {
    if (!files.length) return;
    this.context.pending(1);
    try {
      for (const file of files) {
        const asset = await this.context.image(file);
        const src = await this.context.store(asset);
        this.entry.photos.push({
          src,
          caption: "",
          alt: file.name.replace(/\.[^.]+$/, ""),
          width: asset.width,
          height: asset.height,
        });
        if (!this.doc.cover) {
          this.doc.cover = src;
          this.context.cover();
        }
        this.renderPhotos();
        this.context.changed();
      }
    } finally {
      this.context.pending(-1);
    }
  }
  private renderPhotos() {
    $("gallery-count").textContent =
      `${this.entry.photos.length} 张照片 · 可拖入或粘贴图片`;
    const container = $("gallery-editor");
    container.replaceChildren();
    this.entry.photos.forEach((photo, index) => {
      const card = node("div", "", "gallery-editor-card");
      const image = node("img");
      image.src = this.context.resolve(photo.src);
      image.alt = photo.alt;
      card.append(image);
      const caption = node("textarea");
      caption.value = photo.caption;
      caption.rows = 2;
      caption.placeholder = "这张照片的简评…";
      caption.setAttribute("aria-label", `照片 ${index + 1} 简评`);
      caption.addEventListener("input", () => {
        photo.caption = caption.value;
        this.context.changed();
      });
      card.append(caption);
      const actions = node("div", "", "gallery-actions");
      const button = (label: string, action: () => void, disabled = false) => {
        const b = node("button", label);
        b.type = "button";
        b.disabled = disabled;
        b.addEventListener("click", () => {
          if (!this.context.busy()) action();
        });
        actions.append(b);
      };
      button(
        "↑",
        () => {
          [this.entry.photos[index - 1], this.entry.photos[index]] = [
            photo,
            this.entry.photos[index - 1],
          ];
          this.renderPhotos();
          this.context.changed();
        },
        index === 0
      );
      button(
        "↓",
        () => {
          [this.entry.photos[index + 1], this.entry.photos[index]] = [
            photo,
            this.entry.photos[index + 1],
          ];
          this.renderPhotos();
          this.context.changed();
        },
        index === this.entry.photos.length - 1
      );
      button(this.doc.cover === photo.src ? "封面 ✓" : "设为封面", () => {
        this.doc.cover = photo.src;
        this.context.cover();
        this.renderPhotos();
        this.context.changed();
      });
      button("移除", () => {
        this.entry.photos.splice(index, 1);
        if (this.doc.cover === photo.src) {
          this.doc.cover = this.entry.photos[0]?.src ?? "";
          this.context.cover();
        }
        this.renderPhotos();
        this.context.changed();
      });
      card.append(actions);
      container.append(card);
    });
  }
  private attachPaper() {
    Object.assign(this.entry.paper, paperFromUrl(input("paper-source").value));
    input("paper-pdf").value = this.entry.paper.pdfUrl;
    $<HTMLDetailsElement>("paper-attachment-details").open = false;
    this.reading = true;
    this.updatePaper();
    this.context.changed();
  }
  private async uploadPdf(file: File) {
    if (file.size > 20 * 1024 * 1024)
      throw new Error("PDF 最大支持 20 MB，请压缩后再上传。");
    if (
      new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) !== "%PDF-"
    )
      throw new Error("请选择有效的 PDF 文件。");
    this.context.pending(1);
    try {
      const path = await this.context.store({
        path: `${studioConfig.documentsDirectory}/${crypto.randomUUID()}.pdf`,
        blob: new Blob([file], { type: "application/pdf" }),
        width: 0,
        height: 0,
      });
      this.entry.paper.pdfUrl = path;
      if (!this.doc.title.trim())
        this.context.title(file.name.replace(/\.pdf$/i, ""));
      input("paper-pdf").value = path;
      $<HTMLDetailsElement>("paper-attachment-details").open = false;
      this.reading = true;
      this.updatePaper();
      this.context.changed();
    } finally {
      this.context.pending(-1);
    }
  }
  private updatePaper() {
    const navigation = ++this.paperNavigation;
    const paper = this.entry.paper;
    const src = paper.pdfUrl || paper.sourceUrl;
    const active = this.doc.category === "paper-reading" && Boolean(src);
    $("paper-reader-pane").hidden = !active || !this.reading;
    $("paper-reader-pane").parentElement?.classList.toggle(
      "with-paper-reader",
      active && this.reading
    );
    $("paper-read-toggle").hidden = $("paper-remove").hidden = !active;
    $("paper-read-toggle").textContent = this.reading ? "收起预览" : "边读边写";
    const frame = $<HTMLIFrameElement>("paper-reader-frame");
    const resource = active && this.reading ? this.context.resolve(src) : "";
    const resolved = resource
      ? paper.pdfUrl
        ? pdfPreviewUrl(resource)
        : resource
      : "about:blank";
    if (frame.getAttribute("src") !== resolved) {
      if (resolved === "about:blank") frame.src = resolved;
      else {
        // Let the reading layout settle before the native PDF viewer measures it.
        requestAnimationFrame(() => {
          if (navigation === this.paperNavigation) frame.src = resolved;
        });
      }
    }
    const link = $<HTMLAnchorElement>("paper-reader-link");
    link.href = active
      ? this.context.resolve(paper.sourceUrl || paper.pdfUrl)
      : "#";
    $("paper-status").textContent = paper.pdfUrl.startsWith(
      "/documents/studio/"
    )
      ? "PDF 已保存在本机，发布时一起上传。"
      : active && !paper.pdfUrl
        ? "网页若不允许内嵌，可打开原文或上传 PDF。"
        : "";
  }
  setPreview(preview: boolean) {
    $("entry-fields").hidden = preview || this.doc.category === "notes";
    const container = $("entry-preview");
    container.replaceChildren();
    container.hidden = !preview || this.doc.category === "notes";
    if (!preview) return;
    if (
      ["anime", "game"].includes(this.doc.category) &&
      this.entry.subject?.type === (this.doc.category === "game" ? 4 : 2)
    ) {
      const subject = this.entry.subject;
      const card = node("div", "", "entry-subject");
      if (subject.image) {
        const image = node("img");
        image.src = this.context.resolve(subject.image);
        image.alt = subject.name;
        card.append(image);
      }
      const info = node("div");
      info.append(
        node("strong", subject.name),
        node(
          "p",
          [
            subject.date,
            subject.platform,
            this.entry.rating !== null
              ? `我的评分 ${this.entry.rating}/10`
              : "",
            entryStatuses[this.entry.status],
          ]
            .filter(Boolean)
            .join(" · ")
        )
      );
      card.append(info);
      container.append(card);
    }
    if (this.entry.comment)
      container.append(node("p", this.entry.comment, "entry-comment"));
    if (this.doc.category === "photo")
      for (const photo of this.entry.photos) {
        const figure = node("figure");
        const image = node("img");
        image.src = this.context.resolve(photo.src);
        image.alt = photo.alt;
        figure.append(image, node("figcaption", photo.caption));
        container.append(figure);
      }
  }
}
