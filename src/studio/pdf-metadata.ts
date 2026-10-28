import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PaperMetadata {
  title: string;
  authors: string;
  abstract: string;
  year: string;
  doi: string;
  venue: string;
  publisher: string;
  volume: string;
  issue: string;
  pages: string;
  keywords: string[];
}

const clean = (value: unknown) =>
  (Array.isArray(value)
    ? value.join(", ")
    : typeof value === "string"
      ? value
      : ""
  )
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function usefulTitle(value: string) {
  return (
    value.length >= 5 &&
    !/^(?:untitled|unknown|main|document|paper|arXiv)$/i.test(value) &&
    !/^Microsoft (?:Word|PowerPoint)\b/i.test(value) &&
    !/\.(?:pdf|docx?|tex)$/i.test(value) &&
    !/[\\/]/.test(value.slice(0, 3))
  );
}

/** Read embedded metadata first, then use the first pages as a conservative fallback. */
export async function readPaperMetadata(
  pdf: PDFDocumentProxy
): Promise<PaperMetadata> {
  const { info, metadata } = await pdf
    .getMetadata()
    .catch(() => ({ info: {}, metadata: null }));
  const fields = info as Record<string, unknown>;
  const field = (name: string) => clean(metadata?.get(name.toLowerCase()));
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const lines: { text: string; size: number; y: number; x: number }[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const size = Math.hypot(item.transform[2], item.transform[3]);
    const y = item.transform[5],
      x = item.transform[4];
    const line = lines.find(
      line => Math.abs(line.y - y) < Math.max(2, size * 0.35)
    );
    if (line) {
      line.text += ` ${item.str}`;
      line.size = Math.max(line.size, size);
      line.x = Math.min(line.x, x);
    } else lines.push({ text: item.str, size, y, x });
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);
  const height = page.view[3] - page.view[1];
  const abstractIndex = lines.findIndex(line =>
    /^(?:abstract\b|摘要)/i.test(line.text.trim())
  );
  const header = lines.slice(0, abstractIndex < 0 ? 18 : abstractIndex);
  const candidates = header.filter(
    line =>
      line.y > page.view[1] + height * 0.55 &&
      usefulTitle(clean(line.text)) &&
      !/arxiv:|doi\.org|https?:|copyright|proceedings|preprint|^\d{4}\b|@/i.test(
        line.text
      )
  );
  const largest = Math.max(0, ...candidates.map(line => line.size));
  const titleLines = candidates.filter(line => line.size >= largest * 0.9);
  const embeddedTitle =
    [field("dc:title"), clean(fields.Title)].find(usefulTitle) || "";
  const title = usefulTitle(embeddedTitle)
    ? embeddedTitle
    : clean(titleLines.map(line => line.text).join(" "));
  const titleBottom = Math.min(...titleLines.map(line => line.y));
  const authorLine = header.find(
    line =>
      line.y < titleBottom - 3 &&
      line.size < largest * 0.95 &&
      !/@|https?:|university|institute|department|laborator|school|college|^\d|conference|preprint|submitted/i.test(
        line.text
      ) &&
      /[\p{L}]{2,}/u.test(line.text) &&
      line.text.length < 350
  );
  const embeddedAuthors = clean(fields.Author) || field("dc:creator");
  const authors = /^(?:unknown|anonymous user|user|administrator)$/i.test(
    embeddedAuthors
  )
    ? clean(authorLine?.text)
    : embeddedAuthors || clean(authorLine?.text);
  // Keep the PDF's reading order for abstracts in papers with two columns.
  let text = content.items
    .map(item => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
    .join("");
  if (
    pdf.numPages > 1 &&
    (!/\babstract\b|摘要/i.test(text) || !/\b10\.\d{4,9}\//.test(text))
  ) {
    const second = await (await pdf.getPage(2)).getTextContent();
    text +=
      "\n" +
      second.items
        .map(item =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""
        )
        .join("");
  }
  const afterAbstract =
    text.split(/(?:\bAbstract\b|摘要)\s*[:.\u2014-]?\s*/i)[1] || "";
  const abstract = clean(
    afterAbstract.split(
      /\n\s*(?:(?:[1I][.\s]+)?Introduction\b|Keywords\b|Index Terms\b|关键词|引言)/i
    )[0]
  ).slice(0, 2000);
  const doiText =
    field("prism:doi") ||
    text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] ||
    "";
  const doi = doiText
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/[.,;:]+$/, "")
    .slice(0, 300);
  const date =
    field("prism:publicationDate") ||
    field("prism:coverDate") ||
    header
      .map(line => line.text)
      .join(" ")
      .match(
        /(?:published|copyright|\u00a9)[^\n]{0,70}?\b((?:19|20)\d{2})\b/i
      )?.[1] ||
    text.match(/arXiv:[^\n]{0,100}?\b((?:19|20)\d{2})\b/i)?.[1] ||
    "";
  const year = date.match(/\b(?:19|20)\d{2}\b/)?.[0] || "";
  const keywords = (clean(fields.Keywords) || field("dc:subject"))
    .split(/[,;，；]/)
    .map(word => word.trim())
    .filter(Boolean)
    .slice(0, 8);
  // Use publication metadata or explicit first-page publication statements.
  // References in the body must not be mistaken for the venue of this paper.
  const firstPageText = content.items
    .map(item => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
    .join("");
  const venue =
    field("prism:publicationName") ||
    firstPageText.match(
      /Published as a (?:conference|workshop) paper at\s+([^\n]+)/i
    )?.[1] ||
    firstPageText.match(
      /(?:^|\n)\s*(Proceedings of (?:the )?[^\n]{8,200})/i
    )?.[1] ||
    "";
  return {
    title: title.slice(0, 500),
    authors: authors.slice(0, 1000),
    abstract,
    year,
    doi,
    venue: clean(venue).slice(0, 500),
    publisher: field("dc:publisher").slice(0, 300),
    volume: field("prism:volume").slice(0, 50),
    issue: (field("prism:number") || field("prism:issueIdentifier")).slice(
      0,
      50
    ),
    pages: (
      field("prism:pageRange") ||
      [field("prism:startingPage"), field("prism:endingPage")]
        .filter(Boolean)
        .join("–")
    ).slice(0, 100),
    keywords,
  };
}
