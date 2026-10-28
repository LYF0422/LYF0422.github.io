import { pdfjs, openPdf, readPdfBytes, pdfError } from "./pdf-document";
import {
  normalizeAnnotations,
  pdfPreviewUrl,
  type PdfAnnotation,
  type PdfRect,
} from "@/data/entries";
import { readPaperMetadata, type PaperMetadata } from "./pdf-metadata";

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = ""
) => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
interface Options {
  url: string;
  annotations: PdfAnnotation[];
  canEdit?: () => boolean;
  changed?: (annotations: PdfAnnotation[]) => void;
  metadata?: (metadata: PaperMetadata) => void;
  enrichMetadata?: boolean;
}

/** Canvas/text rendering and normalized annotation coordinates share one viewport. */
export class PdfReader {
  private lifecycle = new AbortController();
  private loading?: pdfjs.PDFDocumentLoadingTask;
  private pdf?: pdfjs.PDFDocumentProxy;
  private renderTask?: pdfjs.RenderTask;
  private textLayer?: pdfjs.TextLayer;
  private observer: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private documentId = "";
  private page = 1;
  private ready = false;
  private mode: "select" | "region" | "note" = "select";
  private annotations: PdfAnnotation[];
  private selection: { quote: string; rects: PdfRect[] } | null = null;
  private drag?: { x: number; y: number; pointer: number };
  private sheet: HTMLElement;
  private marks: HTMLElement;
  private scroll: HTMLElement;
  private selectedId = "";
  private deleted?: { annotation: PdfAnnotation; index: number };
  private dialog?: HTMLDialogElement;
  private placeholder?: Comment;
  private returnFocus?: HTMLElement;
  private viewKey = "";
  private notesBeforeExpand = true;

  constructor(
    private root: HTMLElement,
    private options: Options
  ) {
    this.annotations = normalizeAnnotations(options.annotations);
    this.sheet = this.find(".pdf-sheet");
    this.marks = this.find(".pdf-marks");
    this.scroll = this.find(".pdf-scroll");
    this.find(".pdf-tools").hidden = !options.changed;
    this.find("[data-pdf-mark-actions]").hidden = true;
    this.find("[data-pdf-delete]").hidden = !options.changed;
    this.on(this.find("[data-pdf-prev]"), "click", () =>
      this.go(this.page - 1)
    );
    this.on(this.find("[data-pdf-next]"), "click", () =>
      this.go(this.page + 1)
    );
    this.on(this.find("[data-pdf-page]"), "change", () =>
      this.go(Number(this.find<HTMLInputElement>("[data-pdf-page]").value))
    );
    this.on(this.find("[data-pdf-zoom]"), "change", () => {
      void this.draw();
    });
    this.on(this.find("[data-pdf-retry]"), "click", () => {
      void this.load();
    });
    this.on(this.find("[data-pdf-expand]"), "click", () => this.expand());
    this.on(this.find("[data-pdf-notes-toggle]"), "click", () => {
      this.showNotes(Boolean(this.find(".pdf-sidebar").hidden));
    });
    this.on(this.find("[data-pdf-delete]"), "click", () =>
      this.remove(this.selectedId)
    );
    this.on(this.find("[data-pdf-clear]"), "click", () =>
      this.selectAnnotation("")
    );
    this.on(this.find("[data-pdf-undo]"), "click", () => {
      if (!this.deleted || !this.editable()) return;
      const { annotation, index } = this.deleted;
      this.annotations.splice(index, 0, annotation);
      this.deleted = undefined;
      this.find("[data-pdf-undo]").hidden = true;
      this.save();
      this.renderList();
      this.selectAnnotation(annotation.id);
      this.status("已恢复删除的批注。");
    });
    this.on(this.find("[data-pdf-highlight]"), "pointerdown", e =>
      e.preventDefault()
    );
    this.on(this.find("[data-pdf-highlight]"), "click", () => {
      if (this.selection)
        this.add("highlight", this.selection.rects, this.selection.quote);
    });
    this.on(this.find("[data-pdf-region]"), "click", () =>
      this.setMode(this.mode === "region" ? "select" : "region")
    );
    this.on(this.find("[data-pdf-note]"), "click", () =>
      this.setMode(this.mode === "note" ? "select" : "note")
    );
    this.on(this.find("[data-pdf-page-note]"), "click", () =>
      this.add("note", [{ x: 0.9, y: 0.03, width: 0.04, height: 0.03 }])
    );
    this.on(document, "selectionchange", () => this.captureSelection());
    this.on(this.sheet, "pointerdown", e =>
      this.pointerDown(e as PointerEvent)
    );
    this.on(this.sheet, "pointermove", e =>
      this.pointerMove(e as PointerEvent)
    );
    this.on(this.sheet, "pointerup", e => this.pointerUp(e as PointerEvent));
    this.on(this.sheet, "click", event => {
      if (this.mode !== "select" || !window.getSelection()?.isCollapsed) return;
      const point = this.point(event as PointerEvent);
      const hit = [...this.annotations]
        .reverse()
        .find(
          a =>
            a.documentId === this.documentId &&
            a.page === this.page &&
            a.rects.some(
              r =>
                point.x >= r.x &&
                point.x <= r.x + r.width &&
                point.y >= r.y &&
                point.y <= r.y + r.height
            )
        );
      this.selectAnnotation(hit?.id || "");
    });
    this.on(this.sheet, "pointercancel", () => {
      this.drag = undefined;
      this.renderMarks();
    });
    this.on(this.root, "keydown", e => {
      const event = e as KeyboardEvent;
      if (event.key === "Escape") {
        if (this.mode !== "select" || this.selectedId) {
          event.preventDefault();
          this.setMode("select");
          this.selectAnnotation("");
        }
      }
      if (
        ["Delete", "Backspace"].includes(event.key) &&
        this.selectedId &&
        !(event.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable=true]"
        )
      ) {
        event.preventDefault();
        this.remove(this.selectedId);
      }
    });
    let previousWidth = 0;
    this.observer = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (!width || Math.abs(width - previousWidth) < 2) return;
      previousWidth = width;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.pdf) void this.draw();
      }, 120);
    });
    this.observer.observe(this.scroll);
    void this.load();
  }
  private find<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.root.querySelector<T>(selector)!;
  }
  private on(
    target: EventTarget,
    event: string,
    handler: (event: Event) => void
  ) {
    target.addEventListener(event, handler, { signal: this.lifecycle.signal });
  }
  private status(text: string) {
    this.find("[data-pdf-status]").textContent = text;
  }
  private editable() {
    return (
      Boolean(this.options.changed) &&
      (!this.options.canEdit || this.options.canEdit())
    );
  }
  private showNotes(show: boolean) {
    this.find(".pdf-sidebar").hidden = !show;
    this.root.classList.toggle("pdf-notes-open", show);
    this.find("[data-pdf-notes-toggle]").setAttribute(
      "aria-expanded",
      String(show)
    );
  }
  private expand() {
    if (this.dialog) {
      this.collapse();
      return;
    }
    this.returnFocus = document.activeElement as HTMLElement;
    this.notesBeforeExpand = !this.find(".pdf-sidebar").hidden;
    if (window.matchMedia("(max-width: 899px)").matches) this.showNotes(false);
    this.placeholder = document.createComment("PDF reader position");
    this.root.before(this.placeholder);
    const dialog = element("dialog", "", "pdf-reader-dialog");
    dialog.setAttribute("aria-label", "PDF 大屏阅读");
    dialog.append(this.root);
    document.body.append(dialog);
    this.dialog = dialog;
    this.root.classList.add("is-expanded");
    this.find("[data-pdf-expand]").textContent = "退出大屏";
    this.find("[data-pdf-expand]").setAttribute("aria-pressed", "true");
    document.body.classList.add("pdf-reading-open");
    this.on(dialog, "close", () => this.collapse());
    dialog.showModal();
    this.find("[data-pdf-expand]").focus();
  }
  private collapse() {
    if (!this.dialog) return;
    const dialog = this.dialog;
    this.dialog = undefined;
    this.placeholder?.replaceWith(this.root);
    this.placeholder = undefined;
    this.root.classList.remove("is-expanded");
    this.find("[data-pdf-expand]").textContent = "大屏阅读";
    this.find("[data-pdf-expand]").setAttribute("aria-pressed", "false");
    dialog.close();
    dialog.remove();
    document.body.classList.remove("pdf-reading-open");
    this.showNotes(this.notesBeforeExpand);
    this.returnFocus?.focus({ preventScroll: true });
  }
  private async load() {
    this.ready = false;
    this.root.dataset.ready = "false";
    this.viewKey = "";
    this.find("[data-pdf-retry]").hidden = true;
    this.find(".pdf-fallback").hidden = true;
    this.scroll.hidden = true;
    this.marks.replaceChildren();
    this.find(".pdf-annotations").replaceChildren();
    this.status("正在加载 PDF…");
    try {
      const bytes = await readPdfBytes(
        this.options.url,
        this.lifecycle.signal,
        (size, total) => {
          this.status(
            `正在下载 PDF… ${total ? `${Math.round((size / total) * 100)}%` : `${(size / 1024 / 1024).toFixed(1)} MB`}`
          );
        }
      );
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      this.documentId = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      this.lifecycle.signal.throwIfAborted();
      this.loading = openPdf(bytes);
      this.pdf = await this.loading.promise;
      this.lifecycle.signal.throwIfAborted();
      this.find<HTMLInputElement>("[data-pdf-page]").max = String(
        this.pdf.numPages
      );
      this.find("[data-pdf-count]").textContent = `/ ${this.pdf.numPages}`;
      this.scroll.hidden = false;
      this.showNotes(true);
      this.renderList();
      if (this.options.metadata) {
        void readPaperMetadata(this.pdf)
          .then(async metadata => {
            if (!this.options.enrichMetadata || this.lifecycle.signal.aborted)
              return metadata;
            const { enrichPaperMetadata } = await import("./publisher-paper");
            return enrichPaperMetadata(metadata, this.lifecycle.signal);
          })
          .then(metadata => {
            if (!this.lifecycle.signal.aborted)
              this.options.metadata?.(metadata);
          })
          .catch(() => {});
      }
      await this.draw();
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      this.status(`${pdfError(error)} 已保存的批注不会丢失。`);
      this.scroll.hidden = true;
      this.find("[data-pdf-retry]").hidden = false;
      this.find(".pdf-fallback").hidden = false;
      this.find<HTMLIFrameElement>(".pdf-fallback iframe").src = pdfPreviewUrl(
        this.options.url
      );
    }
  }
  private go(page: number) {
    if (!this.pdf) return;
    this.page = Math.max(1, Math.min(this.pdf.numPages, Math.floor(page) || 1));
    this.scroll.scrollTop = 0;
    void this.draw();
  }
  private async draw() {
    if (!this.pdf || this.lifecycle.signal.aborted) return;
    if (!this.scroll.clientWidth) return;
    const style = getComputedStyle(this.scroll);
    const available = Math.max(
      180,
      this.scroll.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
    );
    const zoom = Number(this.find<HTMLSelectElement>("[data-pdf-zoom]").value);
    const viewKey = `${this.page}:${available}:${zoom}:${window.devicePixelRatio}`;
    if (this.ready && this.viewKey === viewKey) return;
    this.viewKey = viewKey;
    const revision = ++this.revision;
    this.ready = false;
    this.root.dataset.ready = "false";
    this.selection = null;
    this.find<HTMLButtonElement>("[data-pdf-highlight]").disabled = true;
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    this.marks.replaceChildren();
    this.status("正在绘制页面…");
    this.find<HTMLInputElement>("[data-pdf-page]").value = String(this.page);
    this.find<HTMLButtonElement>("[data-pdf-prev]").disabled = this.page === 1;
    this.find<HTMLButtonElement>("[data-pdf-next]").disabled =
      this.page === this.pdf.numPages;
    try {
      const page = await this.pdf.getPage(this.page);
      if (revision !== this.revision || this.lifecycle.signal.aborted) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: (available / base.width) * zoom,
      });
      this.sheet.style.width = `${viewport.width}px`;
      this.sheet.style.height = `${viewport.height}px`;
      this.sheet.style.setProperty(
        "--total-scale-factor",
        String(viewport.scale * viewport.userUnit)
      );
      const canvas = element("canvas");
      canvas.setAttribute("aria-label", `PDF 第 ${this.page} 页`);
      const ratio = Math.min(
        Math.max(window.devicePixelRatio || 1, 1.5),
        3,
        8192 / viewport.width,
        8192 / viewport.height,
        Math.sqrt(16_777_216 / (viewport.width * viewport.height))
      );
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      this.sheet.querySelector("canvas")!.replaceWith(canvas);
      const textContainer = element("div", "", "textLayer");
      const content = await page.getTextContent();
      if (revision !== this.revision || this.lifecycle.signal.aborted) return;
      // PDF.js measures on a canvas with the PDF language. Match it explicitly:
      // inheriting zh-CN from the site changes Latin fallback font metrics.
      const language = content.lang || "en";
      textContainer.lang = language;
      this.sheet.querySelector(".textLayer")!.replaceWith(textContainer);
      this.renderTask = page.render({
        canvas,
        viewport,
        transform: [
          canvas.width / viewport.width,
          0,
          0,
          canvas.height / viewport.height,
          0,
          0,
        ],
      });
      this.textLayer = new pdfjs.TextLayer({
        textContentSource: { ...content, lang: language },
        container: textContainer,
        viewport,
      });
      await Promise.all([this.renderTask.promise, this.textLayer.render()]);
      if (revision !== this.revision || this.lifecycle.signal.aborted) return;
      this.ready = true;
      this.root.dataset.ready = "true";
      this.renderMarks();
      this.setMode(this.mode);
    } catch (error) {
      if (revision !== this.revision || this.lifecycle.signal.aborted) return;
      if (!(
        error instanceof Error && error.name === "RenderingCancelledException"
      ))
        this.status("此页暂时无法显示，请切换页码重试。");
    }
  }
  private setMode(mode: typeof this.mode) {
    this.mode = mode;
    this.sheet.dataset.mode = mode;
    this.find("[data-pdf-region]").setAttribute(
      "aria-pressed",
      String(mode === "region")
    );
    this.find("[data-pdf-note]").setAttribute(
      "aria-pressed",
      String(mode === "note")
    );
    if (!this.ready) return;
    this.status(
      !this.options.changed
        ? "作者的批注 · 点击下方页码可定位。"
        : mode === "region"
          ? "在页面上拖动框选需要高亮的区域，Esc 退出。"
          : mode === "note"
            ? "点击页面上的位置添加批注，Esc 退出。"
            : "选文后点“高亮选文”；点选已有标注可删除，也可在批注列表中删除。"
    );
  }
  private captureSelection() {
    if (!this.ready || !this.editable() || this.mode !== "select") return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      this.selection = null;
    } else {
      const range = selection.getRangeAt(0);
      const layer = this.sheet.querySelector(".textLayer")!;
      if (
        !layer.contains(range.startContainer) ||
        !layer.contains(range.endContainer)
      )
        return;
      const sheet = this.sheet.getBoundingClientRect();
      const rects = Array.from(range.getClientRects())
        .filter(rect => rect.width > 1 && rect.height > 1)
        .map(rect => ({
          x: Math.max(0, (rect.left - sheet.left) / sheet.width),
          y: Math.max(0, (rect.top - sheet.top) / sheet.height),
          width: Math.min(rect.width / sheet.width, 1),
          height: Math.min(rect.height / sheet.height, 1),
        }));
      this.selection = rects.length
        ? { quote: selection.toString().slice(0, 2000), rects }
        : null;
    }
    this.find<HTMLButtonElement>("[data-pdf-highlight]").disabled =
      !this.selection;
  }
  private point(event: PointerEvent) {
    const rect = this.sheet.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(0.999, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(0.999, (event.clientY - rect.top) / rect.height)),
    };
  }
  private pointerDown(event: PointerEvent) {
    if (
      event.button !== 0 ||
      !this.ready ||
      !this.editable() ||
      this.mode === "select"
    )
      return;
    event.preventDefault();
    this.drag = { ...this.point(event), pointer: event.pointerId };
    this.sheet.setPointerCapture(event.pointerId);
  }
  private dragRect(event: PointerEvent): PdfRect {
    const end = this.point(event),
      start = this.drag!;
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }
  private pointerMove(event: PointerEvent) {
    if (
      !this.drag ||
      event.pointerId !== this.drag.pointer ||
      this.mode !== "region"
    )
      return;
    this.renderMarks();
    this.mark(this.dragRect(event), "yellow", "pdf-drag");
  }
  private pointerUp(event: PointerEvent) {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    const start = this.drag;
    const rect = this.dragRect(event);
    this.drag = undefined;
    this.sheet.releasePointerCapture(event.pointerId);
    if (this.mode === "note")
      this.add("note", [{ x: start.x, y: start.y, width: 0.04, height: 0.03 }]);
    else if (rect.width > 0.005 && rect.height > 0.005)
      this.add("highlight", [rect]);
    else this.renderMarks();
  }
  private add(kind: PdfAnnotation["kind"], rects: PdfRect[], quote = "") {
    if (!this.ready || !this.editable()) return;
    if (this.annotations.length >= 1000) {
      this.status("这篇文章已达到 1,000 条批注，请先整理已有批注。");
      return;
    }
    const annotation: PdfAnnotation = {
      id: crypto.randomUUID(),
      documentId: this.documentId,
      page: this.page,
      kind,
      color: this.find<HTMLSelectElement>("[data-pdf-color]")
        .value as PdfAnnotation["color"],
      rects,
      quote,
      text: "",
    };
    this.annotations = normalizeAnnotations([...this.annotations, annotation]);
    this.save();
    window.getSelection()?.removeAllRanges();
    this.setMode("select");
    this.renderList();
    this.selectAnnotation(annotation.id);
    this.root
      .querySelector<HTMLTextAreaElement>(
        `[data-note-id="${annotation.id}"] textarea`
      )
      ?.focus();
  }
  private save() {
    this.options.changed?.(structuredClone(this.annotations));
  }
  private selectAnnotation(id: string) {
    this.selectedId = id;
    const annotation = this.annotations.find(a => a.id === id);
    if (annotation) this.showNotes(true);
    this.find("[data-pdf-mark-actions]").hidden =
      !annotation || !this.options.changed;
    this.find("[data-pdf-selected-label]").textContent = annotation
      ? `已选中第 ${annotation.page} 页${annotation.kind === "highlight" ? "高亮" : "批注"}`
      : "";
    for (const card of this.root.querySelectorAll<HTMLElement>(
      "[data-note-id]"
    ))
      card.classList.toggle("is-selected", card.dataset.noteId === id);
    this.renderMarks();
    if (id)
      this.root
        .querySelector(`[data-note-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }
  private remove(id: string) {
    if (!this.editable()) return;
    const index = this.annotations.findIndex(a => a.id === id);
    if (index < 0) return;
    this.deleted = { annotation: this.annotations[index], index };
    this.annotations.splice(index, 1);
    this.find("[data-pdf-undo]").hidden = false;
    this.save();
    this.renderList();
    this.selectAnnotation("");
    this.status("已删除标注，可点击“撤销删除”恢复。");
  }
  private mark(rect: PdfRect, color: string, className = "") {
    const mark = element("span", "", `pdf-mark ${className}`);
    mark.dataset.color = color;
    Object.assign(mark.style, {
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    });
    this.marks.append(mark);
    return mark;
  }
  private renderMarks() {
    this.marks.replaceChildren();
    for (const annotation of this.annotations.filter(
      a => a.documentId === this.documentId && a.page === this.page
    )) {
      for (const rect of annotation.rects) {
        const mark = this.mark(
          rect,
          annotation.color,
          annotation.kind === "note" ? "pdf-pin" : ""
        );
        mark.dataset.annotation = annotation.id;
        mark.title = annotation.text || annotation.quote || "批注";
        mark.classList.toggle("is-selected", annotation.id === this.selectedId);
        mark.tabIndex = 0;
        mark.setAttribute("role", "button");
        mark.setAttribute(
          "aria-label",
          `查看第 ${annotation.page} 页${annotation.kind === "note" ? "批注" : "高亮"}`
        );
        mark.addEventListener("click", event => {
          event.stopPropagation();
          this.selectAnnotation(annotation.id);
        });
        mark.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.selectAnnotation(annotation.id);
          }
        });
        if (annotation.kind === "note") mark.textContent = "✎";
      }
    }
  }
  private renderList() {
    const list = this.find(".pdf-annotations");
    list.replaceChildren();
    const items = this.annotations
      .filter(a => a.documentId === this.documentId)
      .sort((a, b) => a.page - b.page);
    this.find("[data-pdf-notes-toggle]").textContent = `批注 ${items.length}`;
    list.append(
      element("p", `本篇 PDF · ${items.length} 条批注`, "pdf-note-heading")
    );
    if (!items.length)
      list.append(
        element(
          "p",
          this.options.changed
            ? "还没有批注。选中文字高亮，或用框选、位置批注记录想法。添加后，可点选页面标记或使用这里的“删除”按钮。"
            : "作者尚未添加批注。",
          "pdf-note-empty"
        )
      );
    if (this.annotations.length > items.length && this.options.changed)
      list.append(
        element(
          "p",
          "其他版本 PDF 的批注已保留，重新打开对应文件即可查看。",
          "pdf-status"
        )
      );
    for (const annotation of items) {
      const card = element("div", "", "pdf-note");
      card.dataset.noteId = annotation.id;
      card.dataset.color = annotation.color;
      card.classList.toggle("is-selected", annotation.id === this.selectedId);
      const header = element("div", "", "pdf-note-actions");
      const jump = element(
        "button",
        `第 ${annotation.page} 页 · ${annotation.kind === "note" ? "批注" : "高亮"}`
      );
      jump.type = "button";
      jump.addEventListener("click", () => {
        this.go(annotation.page);
        this.selectAnnotation(annotation.id);
        this.scroll.scrollIntoView({ block: "nearest" });
      });
      header.append(jump);
      if (this.options.changed) {
        const remove = element("button", "删除", "pdf-note-delete");
        remove.type = "button";
        remove.setAttribute("aria-label", `删除第 ${annotation.page} 页批注`);
        remove.addEventListener("click", () => {
          this.remove(annotation.id);
        });
        header.append(remove);
      }
      card.append(header);
      if (annotation.quote)
        card.append(element("blockquote", annotation.quote));
      if (this.options.changed) {
        const input = element("textarea");
        input.value = annotation.text;
        input.placeholder = "写下你的批注…";
        input.rows = 2;
        input.maxLength = 4000;
        input.setAttribute("aria-label", `第 ${annotation.page} 页批注内容`);
        input.addEventListener("input", () => {
          if (!this.editable()) {
            input.value = annotation.text;
            return;
          }
          annotation.text = input.value;
          this.save();
          this.renderMarks();
        });
        card.append(input);
      } else if (annotation.text) card.append(element("p", annotation.text));
      list.append(card);
    }
  }
  destroy() {
    this.collapse();
    this.lifecycle.abort();
    ++this.revision;
    this.observer.disconnect();
    clearTimeout(this.resizeTimer);
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    void this.loading?.destroy().catch(() => {});
    this.root.dataset.ready = "false";
  }
}
