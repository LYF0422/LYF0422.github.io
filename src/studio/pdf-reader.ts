import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  normalizeAnnotations,
  pdfPreviewUrl,
  type PdfAnnotation,
  type PdfRect,
} from "@/data/entries";
import { getAssetPath } from "@/utils/withBase";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
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

  constructor(
    private root: HTMLElement,
    private options: Options
  ) {
    this.annotations = normalizeAnnotations(options.annotations);
    this.sheet = this.find(".pdf-sheet");
    this.marks = this.find(".pdf-marks");
    this.scroll = this.find(".pdf-scroll");
    this.find(".pdf-tools").hidden = !options.changed;
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
    this.on(this.sheet, "pointercancel", () => {
      this.drag = undefined;
      this.renderMarks();
    });
    this.on(this.root, "keydown", e => {
      if ((e as KeyboardEvent).key === "Escape") this.setMode("select");
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
  private async load() {
    this.ready = false;
    this.root.dataset.ready = "false";
    this.find("[data-pdf-retry]").hidden = true;
    this.find(".pdf-fallback").hidden = true;
    this.scroll.hidden = true;
    this.marks.replaceChildren();
    this.find(".pdf-annotations").replaceChildren();
    this.status("正在加载 PDF…");
    try {
      const response = await fetch(this.options.url, {
        credentials: "omit",
        signal: AbortSignal.any([
          this.lifecycle.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      if (!response.ok || !response.body) throw new Error("PDF 暂时无法读取。");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("PDF 超过 20 MB，请压缩后上传。");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      this.documentId = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      this.lifecycle.signal.throwIfAborted();
      this.loading = pdfjs.getDocument({
        data: bytes,
        cMapUrl: getAssetPath("pdfjs/cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: getAssetPath("pdfjs/standard_fonts/"),
        wasmUrl: getAssetPath("pdfjs/wasm/"),
      });
      this.pdf = await this.loading.promise;
      this.lifecycle.signal.throwIfAborted();
      this.find<HTMLInputElement>("[data-pdf-page]").max = String(
        this.pdf.numPages
      );
      this.find("[data-pdf-count]").textContent = `/ ${this.pdf.numPages}`;
      this.scroll.hidden = false;
      this.renderList();
      await this.draw();
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      this.status(
        error instanceof Error && error.message.includes("20 MB")
          ? error.message
          : "无法开启批注：链接可能限制跨域读取，或 PDF 已加密/损坏。请上传可正常打开的 PDF 后重试；已保存的批注不会丢失。"
      );
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
      const zoom = Number(
        this.find<HTMLSelectElement>("[data-pdf-zoom]").value
      );
      const viewport = page.getViewport({
        scale:
          (Math.max(180, this.scroll.clientWidth - 20) / base.width) * zoom,
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
        window.devicePixelRatio || 1,
        2,
        4096 / viewport.width,
        4096 / viewport.height
      );
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      this.sheet.querySelector("canvas")!.replaceWith(canvas);
      const textContainer = element("div", "", "textLayer");
      this.sheet.querySelector(".textLayer")!.replaceWith(textContainer);
      this.renderTask = page.render({
        canvas,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      this.textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
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
            : "选中文字后点“高亮选文”；扫描版可用框选高亮。"
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
    this.renderMarks();
    this.renderList();
    this.root
      .querySelector<HTMLTextAreaElement>(
        `[data-note-id="${annotation.id}"] textarea`
      )
      ?.focus();
  }
  private save() {
    this.options.changed?.(structuredClone(this.annotations));
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
    list.append(
      element("p", `本篇 PDF · ${items.length} 条批注`, "pdf-note-heading")
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
      const header = element("div", "", "pdf-note-actions");
      const jump = element(
        "button",
        `第 ${annotation.page} 页 · ${annotation.kind === "note" ? "批注" : "高亮"}`
      );
      jump.type = "button";
      jump.addEventListener("click", () => {
        this.go(annotation.page);
        this.scroll.scrollIntoView({ block: "nearest" });
      });
      header.append(jump);
      if (this.options.changed) {
        const remove = element("button", "删除");
        remove.type = "button";
        remove.setAttribute("aria-label", `删除第 ${annotation.page} 页批注`);
        remove.addEventListener("click", () => {
          if (!this.editable()) return;
          this.annotations = this.annotations.filter(
            a => a.id !== annotation.id
          );
          this.save();
          this.renderMarks();
          this.renderList();
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
