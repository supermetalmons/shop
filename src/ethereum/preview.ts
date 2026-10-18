export function ethereumContainerPreview(kind: 'crate' | 'warehouse'): string {
  const drawing = kind === 'crate'
    ? '<path d="M170 246 320 169 470 246 470 410 320 488 170 410Z M170 246 320 325 470 246 M320 325V488 M247 207 395 285V450 M247 286V449"/><path d="M203 298V387L284 430 M354 350V426L437 383"/><text x="320" y="563" text-anchor="middle">CRATE · 20 ARTWORKS</text>'
    : '<path d="M133 292 320 177 507 292V466H133Z M133 292H507 M180 466V335H276V466 M364 466V335H460V466 M215 241H425"/><path d="M194 364H260 M194 389H260 M194 414H260 M379 364H445 M379 389H445 M379 414H445"/><circle cx="320" cy="247" r="21"/><text x="320" y="563" text-anchor="middle">WAREHOUSE · 11 CRATES</text>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><rect width="640" height="640" fill="#f4f0e7"/><g fill="none" stroke="#183aaa" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${drawing.replace('<text', '</g><text').replace('</text>', '</text><g>')}</g><style>text{font:17px monospace;fill:#183aaa;letter-spacing:2px;stroke:none}</style><text x="48" y="64">111K</text><text x="592" y="64" text-anchor="end">TEST EDITION</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
