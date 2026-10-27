import { type CategoryId } from "@/data/categories";
import { normalizeEntry, paperFromUrl } from "@/data/entries";
import type { WritingDocument } from "./model";
import { parseTags } from "./library";
import {
  arxivId,
  cachedArxivPaper,
  checkPaperDigest,
  type ImportedPaper,
} from "./paper-imports";
import { getAssetPath } from "@/utils/withBase";
import type { PaperMetadata } from "./pdf-metadata";
import { PaperSourceError, resolvePaperSource } from "./paper-source";
import { acmDownloadError, readDoiMetadata } from "./publisher-paper";

const $ = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.getElementById(`entry-dialog-${name}`) as T;
const field = (name: string) => $<HTMLInputElement>(name);
interface Context {
  accept: (doc: WritingDocument, pdf?: Blob, pdfPath?: string) => Promise<void>;
  importArxiv: (
    id: string,
    signal: AbortSignal,
    progress: (message: string) => void
  ) => Promise<ImportedPaper>;
}

/** Prepare a private copy. Dismissal never changes the active article or its attachments. */
export class EntryDialog {
  private dialog = document.getElementById("entry-dialog") as HTMLDialogElement;
  private doc?: WritingDocument;
  private request?: AbortController;
  private pdf?: Blob;
  private sourceKey = "";
  private pdfPath?: string;
  private importing = false;
  private saving = false;
  private edited = new Set<string>();
  private returnFocus?: HTMLElement;
  constructor(private context: Context) {
    for (const name of ["close", "cancel"])
      $(name).addEventListener("click", () => {
        if (!this.saving) this.dialog.close();
      });
    this.dialog.addEventListener("cancel", event => {
      if (this.saving) event.preventDefault();
    });
    this.dialog.addEventListener("close", () => {
      // A queued close event must not clear a newly reopened dialog.
      if (this.dialog.open) return;
      this.request?.abort();
      this.pdf = undefined;
      this.doc = undefined;
      // Native dialog closure already restores focus. Do not steal it after
      // the user has started typing in another field.
      const active = document.activeElement;
      if (
        active === document.body ||
        active === this.dialog ||
        (active && this.dialog.contains(active))
      )
        this.returnFocus?.focus();
    });
    $("category").addEventListener("change", () => {
      this.request?.abort();
      this.request = undefined;
      this.importing = false;
      this.pdf = undefined;
      this.sourceKey = "";
      field("source").value = "";
      field("file").value = "";
      $("file-name").textContent = "";
      $("results").replaceChildren();
      $("import-status").textContent = "";
      $("error").hidden = true;
      this.renderCategory();
      this.setBusy(false);
    });
    $("source").addEventListener("input", () => {
      this.request?.abort();
      this.request = undefined;
      this.importing = false;
      this.pdf = undefined;
      this.sourceKey = "";
      field("file").value = "";
      $("file-name").textContent = "";
      $("results").replaceChildren();
      $("import-status").textContent = "";
      $("error").hidden = true;
      this.updateImportActions();
      this.setBusy(false);
    });
    $("source").addEventListener("change", () => {
      if (field("source").value.trim()) void this.identify();
    });
    $("source").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.identify();
      }
    });
    $("github").addEventListener("click", () => {
      if (this.saving) return;
      this.request?.abort();
      this.request = undefined;
      this.importing = false;
      this.sourceKey = "";
      void this.identify(undefined, true);
    });
    $("identify").addEventListener("click", () => void this.identify());
    $("file").addEventListener("change", () => {
      const file = field("file").files?.[0];
      if (file) {
        this.request?.abort();
        this.request = undefined;
        this.importing = false;
        void this.identify(file);
      }
    });
    for (const name of [
      "name",
      "description",
      "tags",
      "authors",
      "year",
      "doi",
      "abstract",
    ])
      $(name).addEventListener("input", () => this.edited.add(name));
    document
      .getElementById("entry-dialog-form")!
      .addEventListener("submit", event => {
        event.preventDefault();
        void this.save();
      });
  }
  get isOpen() {
    return this.dialog.open;
  }
  open(doc: WritingDocument, mode: "create" | "edit") {
    this.request?.abort();
    this.doc = structuredClone(doc);
    this.doc.entry = normalizeEntry(this.doc.entry);
    this.pdf = undefined;
    this.sourceKey = "";
    this.importing = this.saving = false;
    this.edited.clear();
    this.returnFocus = document.activeElement as HTMLElement;
    $("title").textContent = mode === "create" ? "新建记录" : "修改文章信息";
    $("save").textContent = mode === "create" ? "创建记录" : "保存信息";
    field("category").value = doc.category;
    field("name").value = doc.title;
    field("description").value = doc.description;
    field("tags").value = doc.tags.join(", ");
    field("source").value =
      doc.category === "paper-reading"
        ? doc.entry.paper.sourceUrl
        : doc.entry.subject
          ? `https://bgm.tv/subject/${doc.entry.subject.id}`
          : "";
    for (const name of ["authors", "year", "doi", "abstract"] as const)
      field(name).value = doc.entry.paper[name];
    field("slug").value = doc.slug;
    field("slug").disabled = Boolean(doc.path);
    const date = new Date(doc.pubDatetime);
    field("date").value = new Date(
      date.getTime() - date.getTimezoneOffset() * 60_000
    )
      .toISOString()
      .slice(0, 16);
    field("featured").checked = doc.featured;
    field("showcase").checked = doc.entry.showcase;
    field("file").value = "";
    $("file-name").textContent = doc.entry.paper.pdfUrl
      ? "已有 PDF，保留原文件与批注；选择新文件可替换。"
      : "";
    $("results").replaceChildren();
    $("import-status").textContent = "";
    $("error").hidden = true;
    $("import-error").hidden = true;
    $("import-progress").hidden = true;
    this.renderCategory();
    this.setBusy(false);
    this.dialog.showModal();
    (mode === "create" ? $("category") : $("name")).focus();
  }
  private get category() {
    return field("category").value as CategoryId;
  }
  private renderCategory() {
    const paper = this.category === "paper-reading";
    const subject = ["anime", "game"].includes(this.category);
    $("source-panel").hidden = !paper && !subject;
    $("paper-info").hidden = !paper;
    $("file-label").hidden = !paper;
    $("source-label").textContent = paper
      ? "论文网址或 PDF 链接"
      : "作品名称、Bangumi 网址或编号";
    field("source").placeholder = paper
      ? "https://arxiv.org/abs/… 或 PDF 下载地址"
      : "例如：葬送的芙莉莲 / https://bgm.tv/subject/…";
    $("original").hidden = true;
    this.updateImportActions();
    if (paper && this.doc && !this.edited.has("name") && !field("name").value)
      $("import-status").textContent =
        "粘贴网址后自动读取，或上传 PDF；读取后可检查并修改信息。";
  }
  private updateImportActions() {
    $("github").hidden =
      this.category !== "paper-reading" || !arxivId(field("source").value);
    $("import-error").hidden = true;
    $("import-progress").hidden = true;
  }
  private fill(name: string, value: string) {
    if (value && !this.edited.has(name)) field(name).value = value;
  }
  private metadata(data: PaperMetadata) {
    this.fill("name", data.title);
    this.fill("description", data.abstract.slice(0, 500));
    this.fill("tags", data.keywords.join(", "));
    for (const name of ["authors", "year", "doi", "abstract"] as const)
      this.fill(name, data[name]);
    if (this.doc)
      this.doc.entry.paper.title = data.title || field("name").value;
  }
  private setBusy(busy: boolean) {
    this.importing = busy;
    $<HTMLButtonElement>("save").disabled = busy || this.saving;
    $<HTMLButtonElement>("identify").disabled = busy || this.saving;
    $<HTMLButtonElement>("github").disabled = this.saving;
    field("category").disabled = this.saving;
    $<HTMLFieldSetElement>("fields").disabled = this.saving;
    $("save-hint").textContent = busy
      ? "正在读取，可以继续填写信息或取消。"
      : "先保存在本机，发布后更新网站。";
  }
  private async identify(file?: File, viaGitHub = false) {
    if (!this.doc || this.saving || this.importing) return;
    const value = field("source").value.trim();
    const key = `${this.category}:${value}`;
    if (!file && this.sourceKey === key) return;
    this.request?.abort();
    const request = (this.request = new AbortController());
    const doc = this.doc;
    $("error").hidden = true;
    $("import-error").hidden = true;
    $("results").replaceChildren();
    this.setBusy(true);
    $("import-status").textContent = file ? "正在读取 PDF…" : "正在读取链接…";
    try {
      if (this.category === "paper-reading") {
        const paper = value ? paperFromUrl(value) : null;
        let resolvedBytes: Uint8Array<ArrayBuffer> | undefined;
        const original = $<HTMLAnchorElement>("original");
        if (paper) {
          original.href = paper.sourceUrl;
          original.hidden = false;
        }
        let publisherMetadata: PaperMetadata | null = null;
        if (paper?.doi) {
          this.fill("doi", paper.doi);
          $("import-status").textContent = "正在读取论文 DOI 信息…";
          publisherMetadata = await readDoiMetadata(paper.doi, request.signal);
          request.signal.throwIfAborted();
          if (this.doc !== doc || this.request !== request) return;
          if (publisherMetadata) this.metadata(publisherMetadata);
        }
        if (!file && paper && !paper.pdfUrl) {
          $("import-status").textContent = "正在从论文网页查找 PDF…";
          const resolved = await resolvePaperSource(value, request.signal);
          paper.pdfUrl = resolved.pdfUrl;
          resolvedBytes = resolved.bytes;
        }
        if (!file && !paper)
          throw new Error("请输入完整的 HTTPS 论文网址或 PDF 链接。");
        const { readPdfBytes, openPdf } = await import("./pdf-document");
        this.pdfPath = undefined;
        let source: Blob | string = file || paper!.pdfUrl;
        const id = !file && arxivId(value);
        let digest = "";
        if (viaGitHub) {
          if (!id)
            throw new Error("通过 GitHub 获取目前支持公开的 arXiv 论文。");
          const progress = $<HTMLAnchorElement>("import-progress");
          progress.href =
            "https://github.com/LYF0422/LYF0422.github.io/actions/workflows/import-paper.yml";
          progress.hidden = false;
          const imported = await this.context.importArxiv(
            id,
            request.signal,
            message => {
              if (this.request === request)
                $("import-status").textContent = message;
            }
          );
          source = imported.blob;
          this.pdfPath = imported.path;
          digest = imported.sha256;
        } else if (id) {
          const cached = await cachedArxivPaper(id, request.signal);
          if (cached) {
            source = getAssetPath(cached.path);
            this.pdfPath = cached.path;
            digest = cached.sha256;
            $("import-status").textContent = "正在读取站内缓存的 PDF…";
          }
        }
        const bytes =
          resolvedBytes ||
          (await (async () => {
            try {
              return await readPdfBytes(
                source,
                request.signal,
                (size, total) => {
                  if (this.request !== request) return;
                  $("import-status").textContent =
                    `正在下载 PDF… ${total ? `${Math.round((size / total) * 100)}%` : `${(size / 1024 / 1024).toFixed(1)} MB`}`;
                }
              );
            } catch (error) {
              request.signal.throwIfAborted();
              if (!file && paper?.doi) throw acmDownloadError(error);
              throw error;
            }
          })());
        const blob = new Blob([bytes.slice().buffer], {
          type: "application/pdf",
        });
        if (digest) await checkPaperDigest(blob, digest);
        const task = openPdf(bytes);
        const abort = () => {
          void task.destroy();
        };
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          const pdf = await task.promise;
          const { readPaperMetadata } = await import("./pdf-metadata");
          const metadata = await readPaperMetadata(pdf);
          request.signal.throwIfAborted();
          if (this.doc !== doc || this.request !== request) return;
          this.pdf = blob;
          if (paper) doc.entry.paper.sourceUrl = paper.sourceUrl;
          this.metadata(
            publisherMetadata
              ? {
                  ...metadata,
                  title: publisherMetadata.title || metadata.title,
                  authors: publisherMetadata.authors || metadata.authors,
                  year: publisherMetadata.year || metadata.year,
                  doi: publisherMetadata.doi || metadata.doi,
                  abstract: publisherMetadata.abstract || metadata.abstract,
                  keywords: publisherMetadata.keywords.length
                    ? publisherMetadata.keywords
                    : metadata.keywords,
                }
              : { ...metadata, doi: paper?.doi || metadata.doi }
          );
          if (!field("name").value && file)
            this.fill("name", file.name.replace(/\.pdf$/i, ""));
          $("file-name").textContent =
            `${file?.name || "PDF 已下载"} · ${(blob.size / 1024 / 1024).toFixed(1)} MB · ${pdf.numPages} 页`;
          $("import-status").textContent =
            "已读取论文信息，请检查后创建。PDF 将保存在本机，发布时一起上传。";
        } finally {
          request.signal.removeEventListener("abort", abort);
          await task.destroy();
        }
      } else {
        const { subjectId, getSubject, searchSubjects } =
          await import("./bangumi");
        const type = this.category === "game" ? 4 : 2;
        const id = subjectId(value);
        const select = async (id: number) => {
          const subject = await getSubject(id, type, request.signal);
          if (
            this.doc !== doc ||
            this.request !== request ||
            request.signal.aborted
          )
            return;
          const previousCover = doc.entry.subject?.image;
          doc.entry.subject = subject;
          if (!doc.cover || doc.cover === previousCover)
            doc.cover = subject.image;
          this.fill("name", subject.name);
          this.fill("description", subject.summary.slice(0, 500));
          this.fill("tags", this.category);
          $("import-status").textContent = `已关联：${subject.name}`;
          $("results").replaceChildren();
          this.sourceKey = key;
        };
        if (id) await select(id);
        else {
          const results = await searchSubjects(value, type, request.signal);
          request.signal.throwIfAborted();
          $("import-status").textContent = results.length
            ? "请选择对应作品："
            : "站内暂未收录，可手动填写信息后创建。";
          for (const result of results) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = result.name_cn || result.name;
            button.addEventListener("click", () => {
              void select(result.id).catch(error => this.error(error));
            });
            $("results").append(button);
          }
        }
      }
      this.sourceKey = key;
    } catch (error) {
      if (
        request.signal.aborted ||
        this.doc !== doc ||
        this.request !== request
      )
        return;
      let message =
        error instanceof Error ? error.message : "读取失败，请重试。";
      if (
        this.category === "paper-reading" &&
        !(
          error instanceof Error &&
          /暂时无法从|请输入|GitHub|校验|有效的|目前支持/.test(error.message)
        ) &&
        !(error instanceof PaperSourceError)
      ) {
        const { pdfError } = await import("./pdf-document");
        message = pdfError(error);
      }
      $("import-error").textContent = message;
      $("import-error").hidden = false;
      // Keep the form-level alert for submission errors and older assistive clients.
      this.error(new Error(message));
      $("import-status").textContent = arxivId(value)
        ? "可点击“通过 GitHub 获取”，或上传 PDF。已填写的信息保留。"
        : "可检查链接后重试，或上传 PDF。已填写的信息保留。";
    } finally {
      if (this.request === request) this.setBusy(false);
    }
  }
  private error(error: unknown) {
    $("error").textContent =
      error instanceof Error ? error.message : "操作未完成，请重试。";
    $("error").hidden = false;
  }
  private async save(): Promise<void> {
    if (!this.doc || this.importing || this.saving) return;
    $("error").hidden = true;
    try {
      const doc = structuredClone(this.doc);
      const category = this.category;
      if (category === "paper-reading") {
        const source = field("source").value.trim();
        const changed = source !== this.doc.entry.paper.sourceUrl;
        if (!this.pdf && source && (changed || !doc.entry.paper.pdfUrl)) {
          await this.identify();
          if (!this.pdf) return;
          return this.save();
        }
        if (!this.pdf && !doc.entry.paper.pdfUrl)
          throw new Error(
            "请先粘贴论文网址并读取，或上传 PDF。只有 PDF 可以在阅读器中批注。"
          );
        if (!source) doc.entry.paper.sourceUrl = "";
        for (const name of ["authors", "year", "doi", "abstract"] as const)
          doc.entry.paper[name] = field(name).value.trim();
        doc.entry.paper.title ||= field("name").value.trim();
      }
      doc.category = category;
      doc.title = field("name").value.trim();
      if (!doc.title) {
        field("name").focus();
        return;
      }
      doc.description = field("description").value.trim();
      doc.tags = parseTags(field("tags").value);
      doc.slug = field("slug").value.trim();
      if (
        !doc.path &&
        doc.slug &&
        !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,119}$/u.test(doc.slug)
      )
        throw new Error("文件名只能包含文字、数字、短横线和下划线。");
      doc.pubDatetime = new Date(field("date").value).toISOString();
      doc.featured = field("featured").checked;
      doc.entry.showcase = field("showcase").checked;
      doc.updatedAt = new Date().toISOString();
      this.saving = true;
      this.setBusy(false);
      await this.context.accept(
        doc,
        category === "paper-reading" ? this.pdf : undefined,
        this.pdfPath
      );
      this.dialog.close();
    } catch (error) {
      this.error(error);
    } finally {
      this.saving = false;
      this.setBusy(false);
    }
  }
}
