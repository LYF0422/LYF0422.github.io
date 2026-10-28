import settings from "./paper-settings.json";

export const pdfLimit = settings.maxPdfMegabytes * 1024 * 1024;
export const pdfSizeLabel = `${settings.maxPdfMegabytes} MB`;
export const pdfSizeMessage = `PDF 最大支持 ${pdfSizeLabel}，请压缩后上传。`;
export const paperTransferTimeout = settings.transferTimeoutSeconds * 1000;

export const paperTextFields = [
  "authors",
  "year",
  "doi",
  "abstract",
  "venue",
  "publisher",
  "volume",
  "issue",
  "pages",
] as const;

export function publicationText(paper: {
  venue: string;
  publisher: string;
  volume: string;
  issue: string;
  pages: string;
}) {
  return [
    paper.venue,
    paper.publisher,
    paper.volume && `卷 ${paper.volume}`,
    paper.issue && `期 ${paper.issue}`,
    paper.pages && `页 ${paper.pages}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
