// Minimal dependency-free PDF writer — renders a plain-text line array into
// a valid multi-page PDF (Courier, Letter, one text column). Used by the
// records ledger to archive trading days older than the 100 shown on
// /records. No font embedding, no images: pure text operators.
//
// Object layout: 1 = Catalog, 2 = Pages, 3 = Font, then per page i:
// (4 + 2i) = Page, (5 + 2i) = Contents stream.

const PAGE_W = 612; // Letter
const PAGE_H = 792;
const MARGIN = 40;
const LEADING = 10;
const FONT_SIZE = 8;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

function asciiOnly(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[^\x20-\x7E]/g, "?");
}

function esc(s: string): string {
    return asciiOnly(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function renderLinesPdf(title: string, lines: string[]): Buffer {
    const allLines = [title, ...lines];
    const pages: string[][] = [];
    for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
        pages.push(allLines.slice(i, i + LINES_PER_PAGE));
    }
    if (pages.length === 0) pages.push([""]);

    const nPages = pages.length;
    const pageObjNum = (i: number) => 4 + 2 * i;
    const contentObjNum = (i: number) => 5 + 2 * i;
    const totalObjects = 3 + 2 * nPages;

    const objs: string[] = new Array(totalObjects);
    objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[1] = `<< /Type /Pages /Kids [ ${pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ")} ] /Count ${nPages} >>`;
    objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";

    pages.forEach((pageLines, i) => {
        const stream = [
            "BT",
            `/F1 ${FONT_SIZE} Tf`,
            `${LEADING} TL`,
            `${MARGIN} ${PAGE_H - MARGIN} Td`,
            ...pageLines.map((l) => `(${esc(l)}) Tj T*`),
            "ET",
        ].join("\n");
        objs[pageObjNum(i) - 1] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>`;
        objs[contentObjNum(i) - 1] =
            `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });

    let out = "%PDF-1.4\n";
    const offsets: number[] = new Array(totalObjects + 1);
    for (let n = 1; n <= totalObjects; n++) {
        offsets[n] = Buffer.byteLength(out, "latin1");
        out += `${n} 0 obj\n${objs[n - 1]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${totalObjects + 1}\n`;
    out += "0000000000 65535 f \n";
    for (let n = 1; n <= totalObjects; n++) {
        out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
}
