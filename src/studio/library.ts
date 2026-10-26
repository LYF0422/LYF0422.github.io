import type { CategoryId } from "@/data/categories";

export interface LibraryTarget {
  id?: string;
  path?: string;
  sha?: string;
  title: string;
  remote: boolean;
}
export interface ArticleOrganization {
  category: CategoryId;
  tags: string[];
}
interface Context {
  available: () => boolean;
  open: (target: LibraryTarget) => Promise<void>;
  info: (target: LibraryTarget) => Promise<void>;
  read: (
    target: LibraryTarget
  ) => Promise<ArticleOrganization & { title: string }>;
  save: (target: LibraryTarget, values: ArticleOrganization) => Promise<void>;
  removeLocal: (id: string) => Promise<void>;
  removeRemote: (target: LibraryTarget) => Promise<void>;
  error: (error: unknown) => void;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean)
    ),
  ];
}

export class LibraryTools {
  private target?: LibraryTarget;
  private trigger?: HTMLElement;
  private saving = false;
  private menu = $("document-menu");
  private dialog = $<HTMLDialogElement>("organize-dialog");
  constructor(private context: Context) {
    this.menu.addEventListener("click", event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-library-action]"
      )?.dataset.libraryAction;
      const target = this.target;
      if (!action || !target || !context.available()) return;
      this.close();
      const task =
        action === "open"
          ? context.open(target)
          : action === "info"
            ? context.info(target)
            : action === "metadata"
              ? this.organize(target)
              : action === "local" && target.id
                ? context.removeLocal(target.id)
                : action === "remote"
                  ? context.removeRemote(target)
                  : Promise.resolve();
      void task.catch(context.error);
    });
    document.addEventListener("pointerdown", event => {
      if (!this.menu.contains(event.target as Node)) this.close();
    });
    document.addEventListener("keydown", event => {
      if (this.menu.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [
          ...this.menu.querySelectorAll<HTMLButtonElement>("button"),
        ].filter(button => !button.hidden);
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      } else if (event.key === "Tab") this.close();
    });
    window.addEventListener("resize", () => this.close());
    window.addEventListener(
      "scroll",
      event => {
        if (!this.menu.contains(event.target as Node)) this.close();
      },
      true
    );
    $("organize-cancel").addEventListener("click", () => {
      if (!this.saving) this.dialog.close();
    });
    this.dialog.addEventListener("cancel", event => {
      if (this.saving) event.preventDefault();
    });
    $("organize-form").addEventListener("submit", event => {
      event.preventDefault();
      void this.save().catch(context.error);
    });
  }
  bind(row: HTMLLIElement, target: LibraryTarget) {
    row.classList.add("document-row");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "document-more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", `管理 ${target.title}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const rect = more.getBoundingClientRect();
      this.show(target, more, rect.right, rect.bottom + 4);
    });
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.show(target, more, event.clientX, event.clientY);
    });
    row.addEventListener("keydown", event => {
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        const rect = more.getBoundingClientRect();
        this.show(target, more, rect.right, rect.bottom);
      }
    });
    row.append(more);
  }
  private show(
    target: LibraryTarget,
    trigger: HTMLElement,
    x: number,
    y: number
  ) {
    if (!this.context.available()) return;
    this.target = target;
    this.trigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    $("document-menu-title").textContent = target.title;
    this.menu.querySelector<HTMLElement>(
      '[data-library-action="local"]'
    )!.hidden = !target.id;
    this.menu.querySelector<HTMLElement>(
      '[data-library-action="remote"]'
    )!.hidden = !target.path || !target.sha;
    this.menu.hidden = false;
    const rect = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
    this.menu.querySelector<HTMLButtonElement>("button")?.focus();
  }
  private close(restoreFocus = false) {
    this.menu.hidden = true;
    this.trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.trigger?.focus();
  }
  private setSaving(value: boolean) {
    this.saving = value;
    $<HTMLFieldSetElement>("organize-fields").disabled = value;
    $<HTMLButtonElement>("organize-save").disabled = value;
    $<HTMLButtonElement>("organize-cancel").disabled = value;
  }
  private async organize(target: LibraryTarget) {
    this.target = target;
    $("organize-document-title").textContent = target.title;
    $("organize-status").textContent = "正在载入…";
    $("organize-error").hidden = true;
    this.setSaving(true);
    this.dialog.showModal();
    try {
      const article = await this.context.read(target);
      $("organize-document-title").textContent = article.title || target.title;
      $<HTMLSelectElement>("organize-category").value = article.category;
      $<HTMLInputElement>("organize-tags").value = article.tags.join(", ");
      $("organize-status").textContent = target.remote
        ? "保存后同步到 GitHub，网站会自动更新。"
        : "保存到本机，发布时更新网站。";
      $("organize-save").textContent = target.remote ? "保存并同步" : "保存";
    } catch (error) {
      this.dialog.close();
      throw error;
    } finally {
      this.setSaving(false);
    }
    $<HTMLSelectElement>("organize-category").focus();
  }
  private async save() {
    if (!this.target || this.saving || !this.context.available()) return;
    this.setSaving(true);
    $("organize-error").hidden = true;
    try {
      await this.context.save(this.target, {
        category: $<HTMLSelectElement>("organize-category").value as CategoryId,
        tags: parseTags($<HTMLInputElement>("organize-tags").value),
      });
      this.dialog.close();
    } catch (error) {
      $("organize-error").textContent =
        error instanceof Error ? error.message : "保存未完成，请重试。";
      $("organize-error").hidden = false;
    } finally {
      this.setSaving(false);
    }
  }
}
